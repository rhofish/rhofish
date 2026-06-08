// ==============================
// 粒子生命模拟器 (Particle Life Simulator)
// 量纲：位置(像素), 速度(像素/秒), 加速度(像素/秒²)
// 固定时间步长: 1/60 秒, 最大允许 delta 限制避免跳跃过大
// ==============================
/**
 * ParticleLifeSim 类
 * 基于物种间作用矩阵的粒子群模拟
 */
export class ParticleLifeSim {
    canvas;
    ctx;
    // 模拟参数
    particleCount;
    speciesCount;
    interactionRadius; // 像素
    forceStrength; // 加速度系数
    damping; // 1/秒
    bounce;
    baseRadius;
    particleAlpha;
    // 世界尺寸（像素）
    worldWidth = 0;
    worldHeight = 0;
    // 固定时间步长（秒）
    fixedDelta = 1 / 60;
    maxDelta = 1 / 30;
    accumulator = 0;
    lastTimestamp = 0;
    animationId = null;
    // 粒子数据 (TypedArray)
    speciesIds; // 物种索引 [0, speciesCount-1]
    positionsX; // 像素
    positionsY;
    velocitiesX; // 像素/秒
    velocitiesY;
    // 物种属性
    speciesColors; // 32位颜色 (0xRRGGBB)
    speciesRadii; // 像素，每个物种绘制半径
    // 作用力矩阵 [speciesCount * speciesCount] 范围 [-1, 1]
    forceMatrix;
    // 空间网格优化
    cellSize = 0; // 网格边长 = interactionRadius
    gridCols = 0;
    gridRows = 0;
    spatialGrid = []; // 每个格子存储粒子索引列表
    neighborsBuffer = []; // 复用邻居列表
    // 鼠标交互参数
    externalX = -1; // 归一化坐标 [0,1)，-1 表示无效
    externalY = -1;
    externalForce = 10; // 力的大小系数
    externalRadius = 0.15; // 影响半径（与 rMax 类似）
    // 辅助常量
    EPS = 1e-6;
    FORCE_BETA = 0.3;
    STORAGE_KEY = "ParticleLifeSimState";
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        const ctx = canvas.getContext("2d");
        if (!ctx)
            throw new Error("Cannot get 2D context");
        this.ctx = ctx;
        // 解析参数
        this.particleCount = options.particleCount ?? 200;
        this.speciesCount = options.speciesCount ?? 5;
        this.interactionRadius = options.interactionRadius ?? 40;
        this.forceStrength = options.forceStrength ?? 100;
        this.damping = options.damping ?? 2.0;
        this.bounce = options.bounce ?? true;
        this.baseRadius = options.baseRadius ?? 3;
        this.particleAlpha = options.particleAlpha ?? 0.8;
        // 分配数组
        this.speciesIds = new Uint8Array(this.particleCount);
        this.positionsX = new Float32Array(this.particleCount);
        this.positionsY = new Float32Array(this.particleCount);
        this.velocitiesX = new Float32Array(this.particleCount);
        this.velocitiesY = new Float32Array(this.particleCount);
        this.speciesColors = new Uint32Array(this.speciesCount);
        this.speciesRadii = new Uint8Array(this.speciesCount);
        this.forceMatrix = new Float32Array(this.speciesCount * this.speciesCount);
        // 初始随机力矩阵和物种外观
        this.randomizeMatrix();
        this.initSpeciesAppearance();
        // 初始化画布尺寸与粒子位置
        this.handleResize();
        this.resetParticles();
    }
    /**
     * 随机生成力矩阵 [-1, 1]
     */
    randomizeMatrix() {
        const len = this.speciesCount * this.speciesCount;
        for (let i = 0; i < len; i++) {
            this.forceMatrix[i] = Math.random() * 2 - 1;
        }
    }
    /**
     * 初始化物种颜色和半径（基于色相环）
     */
    initSpeciesAppearance() {
        for (let i = 0; i < this.speciesCount; i++) {
            const hue = (i / this.speciesCount) * 360;
            this.speciesColors[i] = this.hslaToInt(hue, 100, 60, this.particleAlpha);
            // 半径随物种不同略有变化，但仍围绕 baseRadius
            this.speciesRadii[i] = this.baseRadius + (i % 5);
        }
    }
    /**
     * 重置所有粒子：随机位置、零速度、随机物种
     */
    resetParticles() {
        for (let i = 0; i < this.particleCount; i++) {
            this.speciesIds[i] = Math.floor(Math.random() * this.speciesCount);
            this.positionsX[i] = Math.random() * this.worldWidth;
            this.positionsY[i] = Math.random() * this.worldHeight;
            this.velocitiesX[i] = 0;
            this.velocitiesY[i] = 0;
        }
    }
    /**
     * 响应窗口尺寸变化
     */
    handleResize() {
        this.canvas.width = this.canvas.clientWidth;
        this.canvas.height = this.canvas.clientHeight;
        this.worldWidth = this.canvas.clientWidth;
        this.worldHeight = this.canvas.clientHeight;
        // 重建空间网格
        this.cellSize = this.interactionRadius;
        this.gridCols = Math.ceil(this.worldWidth / this.cellSize);
        this.gridRows = Math.ceil(this.worldHeight / this.cellSize);
        if (this.gridCols < 1)
            this.gridCols = 1;
        if (this.gridRows < 1)
            this.gridRows = 1;
        const totalCells = this.gridCols * this.gridRows;
        this.spatialGrid = Array.from({ length: totalCells }, () => []);
    }
    /**
     * 添加外部力场
     * @param x Position X
     * @param y Position Y
     * @param radius Radius
     * @param strength Force Strength
     */
    setExternalForce(x, y, radius, strength) {
        this.externalX = x;
        this.externalY = y;
        this.externalRadius = radius;
        this.externalForce = Math.min(this.forceStrength, Math.max(-this.forceStrength, strength));
    }
    /**
     * 清除外部力场
     */
    clearExternalForce() {
        this.externalRadius = 0;
        this.externalForce = 0;
    }
    /**
     * 启动动画循环
     */
    start() {
        if (this.animationId !== null)
            return;
        this.lastTimestamp = performance.now() / 1000;
        this.accumulator = 0;
        const animate = (nowMs) => {
            const nowSec = nowMs / 1000;
            let delta = nowSec - this.lastTimestamp;
            this.lastTimestamp = nowSec;
            if (delta > this.maxDelta)
                delta = this.maxDelta;
            this.accumulator += delta;
            while (this.accumulator >= this.fixedDelta) {
                this.updatePhysics(this.fixedDelta);
                this.accumulator -= this.fixedDelta;
            }
            this.draw();
            this.animationId = requestAnimationFrame(animate);
        };
        this.animationId = requestAnimationFrame(animate);
    }
    /**
     * 停止动画
     */
    stop() {
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }
    /**
     * 单步物理更新（固定时间步长）
     * @param dt 秒
     */
    updatePhysics(dt) {
        const n = this.particleCount;
        const species = this.speciesIds;
        const posX = this.positionsX;
        const posY = this.positionsY;
        const velX = this.velocitiesX;
        const velY = this.velocitiesY;
        const worldW = this.worldWidth;
        const worldH = this.worldHeight;
        const bounce = this.bounce;
        const radius = this.interactionRadius;
        const forceStrength = this.forceStrength;
        const dampingFactor = Math.max(0, 1 - this.damping * dt);
        const matrix = this.forceMatrix;
        const speciesCnt = this.speciesCount;
        const spatialGrid = this.spatialGrid;
        // 1. 清空网格
        for (let i = 0; i < spatialGrid.length; i++) {
            spatialGrid[i].length = 0;
        }
        // 2. 填充网格
        const cellW = this.cellSize;
        const cellH = this.cellSize;
        const cols = this.gridCols;
        const rows = this.gridRows;
        for (let i = 0; i < n; i++) {
            let px = posX[i];
            let py = posY[i];
            let gx = Math.floor(px / cellW);
            let gy = Math.floor(py / cellH);
            if (bounce) {
                gx = Math.min(cols - 1, Math.max(0, gx));
                gy = Math.min(rows - 1, Math.max(0, gy));
            }
            else {
                gx = ((gx % cols) + cols) % cols;
                gy = ((gy % rows) + rows) % rows;
            }
            const cellIdx = gx + gy * cols;
            spatialGrid[cellIdx].push(i);
        }
        // 3. 计算每个粒子的受力并更新状态
        const halfWorldW = worldW * 0.5 + this.EPS;
        const halfWorldH = worldH * 0.5 + this.EPS;
        const neighbors = this.neighborsBuffer;
        for (let i = 0; i < n; i++) {
            const px = posX[i];
            const py = posY[i];
            const gx = Math.floor(px / cellW);
            const gy = Math.floor(py / cellH);
            // 收集邻居 (3x3 邻域)
            neighbors.length = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    let nx = gx + dx;
                    let ny = gy + dy;
                    if (bounce) {
                        if (nx < 0 || nx >= cols)
                            continue;
                        if (ny < 0 || ny >= rows)
                            continue;
                    }
                    else {
                        nx = ((nx % cols) + cols) % cols;
                        ny = ((ny % rows) + rows) % rows;
                    }
                    const cellIdx = nx + ny * cols;
                    const cell = spatialGrid[cellIdx];
                    for (let k = 0; k < cell.length; k++) {
                        const j = cell[k];
                        if (j !== i)
                            neighbors.push(j);
                    }
                }
            }
            // 合力
            let fx = 0;
            let fy = 0;
            const radiusSq = radius * radius;
            for (let k = 0; k < neighbors.length; k++) {
                const j = neighbors[k];
                let dx = posX[j] - px;
                let dy = posY[j] - py;
                if (!bounce) {
                    // 周期边界最小镜像距离
                    if (dx > halfWorldW)
                        dx -= worldW;
                    else if (dx < -halfWorldW)
                        dx += worldW;
                    if (dy > halfWorldH)
                        dy -= worldH;
                    else if (dy < -halfWorldH)
                        dy += worldH;
                }
                const distSq = dx * dx + dy * dy;
                if (distSq === 0 || distSq >= radiusSq)
                    continue;
                const dist = Math.sqrt(distSq);
                const rNorm = dist / radius; // [0,1]
                const a = matrix[species[i] * speciesCnt + species[j]];
                const f = this.getForceMagnitude(rNorm, a);
                // 方向单位向量分量
                const invDist = 1 / dist;
                fx += dx * invDist * f;
                fy += dy * invDist * f;
            }
            // 添加外部力
            if (this.externalRadius > this.EPS) {
                let dx = this.externalX - px;
                let dy = this.externalY - py;
                if (!bounce) {
                    // 周期边界下考虑最小镜像距离
                    if (dx > halfWorldW)
                        dx -= worldW;
                    else if (dx < -halfWorldW)
                        dx += worldW;
                    if (dy > halfWorldH)
                        dy -= worldH;
                    else if (dy < -halfWorldH)
                        dy += worldH;
                }
                const dist = Math.hypot(dx, dy);
                if (dist < this.externalRadius) {
                    const t = 1 - dist / this.externalRadius; // 线性衰减因子 [0,1]
                    const factor = this.externalForce * t;
                    // 方向单位向量 (dx/dist, dy/dist)
                    if (dist > 1e-6) {
                        fx += (dx / dist) * factor;
                        fy += (dy / dist) * factor;
                    }
                }
            }
            // 加速度: a = forceStrength * (合力)  [像素/秒²]
            const ax = fx * forceStrength;
            const ay = fy * forceStrength;
            // 欧拉积分 (阻尼)
            let vx = velX[i];
            let vy = velY[i];
            vx = vx * dampingFactor + ax * dt;
            vy = vy * dampingFactor + ay * dt;
            let newX = px + vx * dt;
            let newY = py + vy * dt;
            // 边界处理
            if (bounce) {
                if (newX < 0) {
                    newX = -newX;
                    vx = -vx;
                }
                else if (newX > worldW) {
                    newX = 2 * worldW - newX;
                    vx = -vx;
                }
                if (newY < 0) {
                    newY = -newY;
                    vy = -vy;
                }
                else if (newY > worldH) {
                    newY = 2 * worldH - newY;
                    vy = -vy;
                }
                // 防漂移钳位
                newX = Math.min(worldW - this.EPS, Math.max(this.EPS, newX));
                newY = Math.min(worldH - this.EPS, Math.max(this.EPS, newY));
            }
            else {
                // 周期环绕
                newX = ((newX % worldW) + worldW) % worldW;
                newY = ((newY % worldH) + worldH) % worldH;
            }
            posX[i] = newX;
            posY[i] = newY;
            velX[i] = vx;
            velY[i] = vy;
        }
    }
    /**
     * 绘制所有粒子
     */
    draw() {
        const w = this.canvas.width;
        const h = this.canvas.height;
        this.ctx.clearRect(0, 0, w, h);
        const n = this.particleCount;
        const radii = this.speciesRadii;
        const colors = this.speciesColors;
        const species = this.speciesIds;
        const posX = this.positionsX;
        const posY = this.positionsY;
        for (let i = 0; i < n; i++) {
            const sp = species[i];
            const r = radii[sp];
            const colorHex = "#" + colors[sp].toString(16).padStart(8, "0");
            this.ctx.beginPath();
            this.ctx.arc(posX[i], posY[i], r, 0, 2 * Math.PI);
            this.ctx.fillStyle = colorHex;
            this.ctx.fill();
        }
        // ================= 水印 =================
        this.ctx.font = "20px 'Segoe UI', 'Poppins', 'Arial', sans-serif";
        this.ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
        this.ctx.textAlign = "right";
        this.ctx.textBaseline = "bottom";
        this.ctx.fillText("RUOO.TOP", w - 15, h - 15);
    }
    /**
     * 力函数: 基于归一化距离 r (0~1) 和矩阵系数 a (-1..1)
     * 常用分段线性模型:
     *   r < beta:  排斥 (r/beta - 1)
     *   r in [beta, 1]: 吸引/中性 (a * (1 - |2r-1-beta|/(1-beta)))
     *   r > 1: 0
     */
    getForceMagnitude(r, a) {
        const beta = this.FORCE_BETA; // 排斥/吸引转折点，通常 0.2~0.4
        if (r < beta) {
            // 线性排斥，范围 [-1, 0]
            return r / beta - 1;
        }
        else if (r < 1) {
            // 吸引部分，形状为三角形，峰值 a (可为负值表示排斥)
            const t = (2 * r - 1 - beta) / (1 - beta);
            return a * (1 - Math.abs(t));
        }
        else {
            return 0;
        }
    }
    /**
     * 将 HSL 颜色值转换为整数形式的颜色代码 (0xRRGGBB)
     * @param {number} h - 色调，范围 0–360
     * @param {number} s - 饱和度，范围 0–100
     * @param {number} l - 亮度，范围 0–100
     * @param {number} a - 不透明度，范围 0–1 (0 完全透明, 1 完全不透明)
     * @returns {number} 整数颜色值，例如红色为 0xff0000 (16711680)
     */
    hslaToInt(h, s, l, a) {
        // 1. 参数归一化与边界限制
        h = ((h % 360) + 360) % 360;
        s = Math.min(100, Math.max(0, s)) / 100;
        l = Math.min(100, Math.max(0, l)) / 100;
        a = Math.min(1, Math.max(0, a));
        // 2. HSL → RGB 转换算法
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const hp = h / 60;
        const x = c * (1 - Math.abs((hp % 2) - 1));
        const m = l - c / 2;
        let r, g, b;
        if (hp >= 0 && hp < 1) {
            (r = c), (g = x), (b = 0);
        }
        else if (hp < 2) {
            (r = x), (g = c), (b = 0);
        }
        else if (hp < 3) {
            (r = 0), (g = c), (b = x);
        }
        else if (hp < 4) {
            (r = 0), (g = x), (b = c);
        }
        else if (hp < 5) {
            (r = x), (g = 0), (b = c);
        }
        else {
            (r = c), (g = 0), (b = x);
        }
        // 3. 转换为 0–255 整数
        r = Math.round((r + m) * 255);
        g = Math.round((g + m) * 255);
        b = Math.round((b + m) * 255);
        const alpha = Math.round(a * 255);
        // 4. 组合为单个整数
        return (r << 24) | (g << 16) | (b << 8) | alpha;
    }
    /**
     * 将鼠标事件坐标转换为 canvas 像素坐标（考虑 CSS 缩放）
     * @param e 鼠标事件
     * @returns [mouseX, mouseY]
     */
    getCanvasMousePos(e) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const mouseX = (e.clientX - rect.left) * scaleX;
        const mouseY = (e.clientY - rect.top) * scaleY;
        // 钳位到画布范围内
        return [
            Math.min(this.worldWidth, Math.max(0, mouseX)),
            Math.min(this.worldHeight, Math.max(0, mouseY)),
        ];
    }
    // 保存方法
    save() {
        const state = {
            version: 1,
            timestamp: Date.now(),
            speciesCount: this.speciesCount,
            particleCount: this.particleCount,
            forceMatrix: Array.from(this.forceMatrix),
            speciesColors: Array.from(this.speciesColors),
            speciesRadii: Array.from(this.speciesRadii),
            positionsX: Array.from(this.positionsX),
            positionsY: Array.from(this.positionsY),
            velocitiesX: Array.from(this.velocitiesX),
            velocitiesY: Array.from(this.velocitiesY),
            speciesIds: Array.from(this.speciesIds),
        };
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(state));
            console.log("ParticleLifeSim state saved.");
        }
        catch (e) {
            console.warn("Failed to save simulation state:", e);
        }
    }
    // 加载方法
    load() {
        const raw = localStorage.getItem(this.STORAGE_KEY);
        if (!raw)
            return false;
        try {
            const state = JSON.parse(raw);
            const dayPass = (state.timestamp - Date.now()) / 864e5;
            if (dayPass > 10) {
                localStorage.removeItem(this.STORAGE_KEY);
                return false; // 寿命只有 10 天
            }
            // 恢复数据
            this.forceMatrix.set(state.forceMatrix);
            this.speciesColors.set(state.speciesColors);
            this.speciesRadii.set(state.speciesRadii);
            this.positionsX.set(state.positionsX);
            this.positionsY.set(state.positionsY);
            this.velocitiesX.set(state.velocitiesX);
            this.velocitiesY.set(state.velocitiesY);
            this.speciesIds.set(state.speciesIds);
            // 重新绘制（动画循环中下一次更新会自动使用这些数据）
            this.draw();
            console.log("ParticleLifeSim state loaded.");
            return true;
        }
        catch (e) {
            console.warn("Failed to load simulation state:", e);
            return false;
        }
    }
}

// main.js

const canvas = document.querySelector("canvas");
const sim = new ParticleLifeSim(canvas, {
  particleCount: 1000,
  speciesCount: 8,
  interactionRadius: 100,
  forceStrength: 250,
  damping: 10,
  bounce: false,
  baseRadius: 2,
  particleAlpha: 0.7,
});
const url = new URL(window.location.href);
const reload = url.searchParams.get("reload");
window.addEventListener("load", () => {
  sim.start();
  if (!reload) sim.load();
});
window.addEventListener("beforeunload", () => {
  if (reload) {
    localStorage.clear();
  } else {
    sim.save();
  }
});
window.addEventListener("resize", () => {
  sim.handleResize();
});
window.addEventListener("dblclick", () => {
  sim.randomizeMatrix();
});
