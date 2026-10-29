(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),e.crossOrigin===`use-credentials`?t.credentials=`include`:e.crossOrigin===`anonymous`?t.credentials=`omit`:t.credentials=`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var e=`// 统一粒子着色器\r
\r
struct ComputeParams {\r
  numParticles: u32, // 粒子个数\r
  numTypes: u32, // 粒子种类数\r
  boundary: u32, // 0: wrap, 1: bounce\r
  maxDist: f32, // 最大作用半径\r
  forceFactor: f32, // 力缩放\r
  frictionFactor: f32, // 摩擦系数\r
  simWidth: f32, // 世界尺寸 X\r
  simHeight: f32, // 世界尺寸 Y\r
  gridWidth: u32, // 网格列数\r
  gridHeight: u32, // 网格行数\r
  deltaTime: f32,\r
  padding: f32,\r
};\r
\r
struct Particle {\r
    posX: f32,\r
    posY: f32,\r
    velX: f32,\r
    velY: f32,\r
    typeId: f32,\r
    cellId: f32,\r
}\r
\r
struct Rule {\r
    strength: f32, // 作用力大小\r
    minR: f32, // \r
    maxR: f32,\r
}\r
\r
\r
// 原始粒子数据，长度为 Math.ceil(numParticles / 64) * 64\r
@group(0) @binding(0) var<storage, read> particlesSource: array<Particle>;\r
// 经过网格重排后的粒子数据，长度为 Math.ceil(numParticles / 64) * 64\r
@group(0) @binding(1) var<storage, read_write> particlesTarget: array<Particle>;\r
\r
// 网格计数器，长度为网格总数\r
@group(0) @binding(2) var<storage, read_write> gridCellCounts: array<atomic<u32>>;\r
// 定义每个网格粒子索引的偏移量, 长度为网格总数 + 1\r
@group(0) @binding(3) var<storage, read_write> gridCellOffset: array<u32>;\r
\r
// 编码后的规则矩阵，每个规则编码为一个 u32：\r
//   - bit 0-7:   rule 力强度，编码为 [-1, 1]\r
//   - bit 8-15:  minR 最小作用距离，编码为 [0, 1]\r
//   - bit 16-31: maxR 最大作用距离，编码为 [0, 1]\r
@group(0) @binding(4) var<storage, read> ruleMatrix: array<Rule>;\r
\r
@group(0) @binding(5) var<uniform> params: ComputeParams;\r
\r
\r
// 清理网格计数器\r
@compute @workgroup_size(64)\r
fn clearGrid(@builtin(global_invocation_id) id: vec3<u32>) {\r
    if id.x >= arrayLength(&gridCellCounts) { return; }\r
    atomicStore(&gridCellCounts[id.x], 0u);\r
}\r
\r
\r
// 填充网格 -> gridCellCounts 原子化记录每个网格上的粒子个数\r
@compute @workgroup_size(64)\r
fn fillGrid(@builtin(global_invocation_id) id: vec3<u32>) {\r
    if id.x >= params.numParticles { return; }\r
\r
    let p = particlesSource[id.x];\r
    let gx = floor(p.posX * f32(params.gridWidth) / params.simWidth);\r
    let gy = floor(p.posY * f32(params.gridHeight) / params.simHeight);\r
    let cell_id = i32(gy) * i32(params.gridWidth) + i32(gx);\r
\r
    atomicAdd(&gridCellCounts[cell_id], 1u);\r
}\r
\r
\r
// 串行前缀和 -> gridCellOffset 记录每个网格的起始粒子索引\r
@compute @workgroup_size(1)\r
fn prefixSum(@builtin(global_invocation_id) id: vec3<u32>) {\r
    if id.x != 0u { return; }\r
\r
    let gridCount = params.gridWidth * params.gridHeight;\r
\r
    var sum = 0u;\r
    for (var i = 0u; i < gridCount; i++) {\r
        gridCellOffset[i] = sum;\r
        let count = atomicLoad(&gridCellCounts[i]);\r
        sum += count;\r
    }\r
    gridCellOffset[gridCount] = sum;\r
}\r
\r
\r
// 并行遍历所有粒子，根据网格顺序连续排序，生成 particles\r
@compute @workgroup_size(64)\r
fn sortParticles(@builtin(global_invocation_id) id: vec3<u32>) {\r
    if id.x >= params.numParticles { return; }\r
\r
    let p = particlesSource[id.x];\r
    let gx = floor(p.posX * f32(params.gridWidth) / params.simWidth);\r
    let gy = floor(p.posY * f32(params.gridHeight) / params.simHeight);\r
    let cell_id = i32(gy) * i32(params.gridWidth) + i32(gx);\r
\r
    // 原子递减 gridCellCounts 获取当前网格内的写入偏移（从 count-1 递减到 0）\r
    let offset = atomicSub(&gridCellCounts[cell_id], 1u) - 1u;\r
    let new_idx = gridCellOffset[cell_id] + offset;\r
    particlesTarget[new_idx] = p;\r
}\r
\r
\r
// 主计算函数\r
@compute @workgroup_size(64)\r
fn computeForce(@builtin(global_invocation_id) id: vec3<u32>) {\r
    if id.x >= params.numParticles { return; }\r
\r
    let simWidth = params.simWidth;\r
    let simHeight = params.simHeight;\r
    let gridWidth = i32(params.gridWidth);\r
    let gridHeight = i32(params.gridHeight);\r
\r
    let maxDist = params.maxDist;\r
    let invMaxDist = 1.0 / maxDist;\r
    let maxDistSq = maxDist * maxDist;\r
\r
    // 判断各轴是否为 bounce 模式（非 wrap）\r
    let x_bounce = (params.boundary & 1u) == 1u; // or simWidth == 0.0\r
    let y_bounce = (params.boundary & 2u) == 2u; // or simHeight == 0.0\r
\r
    var force = vec2f(0.0);\r
\r
    // 从排序后的数据中读取当前粒子\r
    var p = particlesSource[id.x];\r
    // 计算当前粒子的网格坐标（用于遍历邻居）\r
    var gx = i32(floor(p.posX * f32(params.gridWidth) / params.simWidth));\r
    var gy = i32(floor(p.posY * f32(params.gridHeight) / params.simHeight));\r
\r
    // 遍历 3*3 网格\r
    // wrap 模式下使用 ((n % max) + max) % max 处理越界\r
    for (var dy = -1; dy <= 1; dy++) {\r
        var ny = gy + dy;\r
        if y_bounce && (ny < 0 || ny >= gridHeight) { continue; }\r
        ny = ((ny % gridHeight) + gridHeight) % gridHeight;\r
\r
        for (var dx = -1; dx <= 1; dx++) {\r
            var nx = gx + dx;\r
            if x_bounce && (nx < 0 || nx >= gridWidth) { continue; }\r
            nx = ((nx % gridWidth) + gridWidth) % gridWidth;\r
\r
            let idx = ny * gridWidth + nx;\r
            let start = gridCellOffset[idx];\r
            let end = gridCellOffset[idx + 1];\r
\r
            for (var i = start; i < end; i++) {\r
                if i == id.x { continue; }\r
\r
                let q = particlesSource[i];\r
\r
                var rx = q.posX - p.posX;\r
                var ry = q.posY - p.posY;\r
\r
                // wrap 模式下使用最短距离（periodic boundary condition）\r
                if !x_bounce {\r
                    rx = rx - round(rx / simWidth) * simWidth;\r
                }\r
                if !y_bounce {\r
                    ry = ry - round(ry / simHeight) * simHeight;\r
                }\r
\r
                let distSq = rx * rx + ry * ry;\r
                if distSq > maxDistSq || distSq < 1e-6 { continue; }\r
\r
                let dist = sqrt(distSq);\r
                let normDist = dist * invMaxDist;\r
\r
                let dir = vec2f(rx, ry) / dist;\r
\r
                let rule = ruleMatrix[u32(p.typeId) * params.numTypes + u32(q.typeId)];\r
                var strength = rule.strength;\r
\r
                if normDist < rule.minR {\r
                    strength = -1.0 + normDist / rule.minR;\r
                } else if normDist < rule.maxR {\r
                    strength = strength * (normDist - rule.minR) / (rule.maxR - rule.minR);\r
                } else if normDist < 1 {\r
                    strength = strength * (1.0 - normDist) / (1.0 - rule.maxR);\r
                }\r
\r
                force += strength * dir;\r
            }\r
        }\r
    }\r
\r
    p.velX *= params.frictionFactor;\r
    p.velY *= params.frictionFactor;\r
    p.velX += force.x * params.forceFactor * params.deltaTime;\r
    p.velY += force.y * params.forceFactor * params.deltaTime;\r
    p.posX += p.velX * params.deltaTime;\r
    p.posY += p.velY * params.deltaTime;\r
\r
    // x轴\r
    if x_bounce {\r
        let x_bounced = p.posX < 0.0 || p.posX > params.simWidth;\r
        p.velX = select(p.velX, -p.velX, x_bounced);\r
        p.posX = clamp(p.posX, 0.0, params.simWidth);\r
    } else if params.simWidth > 0 {\r
        // wrap 模式：使用 ((n % max) + max) % max 公式约束到 [0, simWidth)\r
        p.posX = ((p.posX % params.simWidth) + params.simWidth) % params.simWidth;\r
    }\r
\r
    // y轴\r
    if y_bounce {\r
        let y_bounced = p.posY < 0.0 || p.posY > params.simHeight;\r
        p.velY = select(p.velY, -p.velY, y_bounced);\r
        p.posY = clamp(p.posY, 0.0, params.simHeight);\r
    } else if params.simHeight > 0 {\r
        // wrap 模式：使用 ((n % max) + max) % max 公式约束到 [0, simHeight)\r
        p.posY = ((p.posY % params.simHeight) + params.simHeight) % params.simHeight;\r
    }\r
\r
    particlesTarget[id.x] = p;\r
}\r
\r
`,t=`// 粒子渲染着色器\r
// 使用实例化的四边形（每粒子 6 个顶点）绘制圆形粒子。\r
//\r
// 渲染流程：\r
//   vertexMain   : 根据粒子位置/尺寸生成四边形顶点，并变换到 NDC\r
//   fragmentMain : 以 UV 到中心的距离裁剪出圆形，并做边缘抗锯齿\r
\r
// #region ============================== 常量 ==============================\r
\r
// 每个粒子由两个三角形组成，共 6 个顶点\r
const VERTEX_COUNT: u32 = 6u;\r
\r
// 四边形半边长（相对粒子尺寸），顶点偏移范围 [-0.5, 0.5]\r
const QUAD_HALF: f32 = 0.5;\r
\r
// UV 半径：UV 以粒子中心为原点，范围 [-1, 1]\r
const UV_RADIUS: f32 = 1.0;\r
\r
// 圆形边缘抗锯齿的起始半径（相对 UV 半径）\r
const EDGE_START: f32 = 0.8;\r
\r
// #endregion\r
\r
// #region ============================== 结构体 ==============================\r
\r
struct RenderParams {\r
  numParticles: u32, // 粒子个数\r
  numTypes: u32, // 粒子种类数\r
  boundary: u32, // 0: wrap, 1: bounce\r
  maxDist: f32, // 最大作用半径\r
  forceFactor: f32, // 力缩放\r
  frictionFactor: f32, // 摩擦系数\r
  simWidth: f32, // 世界尺寸 X\r
  simHeight: f32, // 世界尺寸 Y\r
  gridWidth: u32, // 网格列数\r
  gridHeight: u32, // 网格行数\r
  deltaTime: f32,\r
  padding: f32,\r
};\r
\r
struct Particle {\r
  posX: f32,\r
  posY: f32,\r
  velX: f32,\r
  velY: f32,\r
  typeId: f32,\r
  cellId: f32,\r
}\r
\r
struct Style {\r
  size: f32, // 粒子尺寸\r
  color_r: f32,\r
  color_g: f32,\r
  color_b: f32,\r
  color_a: f32,\r
}\r
\r
struct Camera2D {\r
  centerX: f32,\r
  centerY: f32,\r
  scaleX: f32,\r
  scaleY: f32,\r
}\r
\r
struct VertexOutput {\r
  @builtin(position) position: vec4<f32>,\r
  @location(0) color: vec4<f32>,\r
  @location(1) uv: vec2<f32>,\r
};\r
\r
// #endregion\r
\r
// #region ============================== 绑定 ==============================\r
\r
// 粒子数据（顶点阶段读取）\r
@group(0) @binding(0) var<storage, read> particles: array<Particle>;\r
\r
// 粒子样式表（按 typeId 索引）\r
@group(0) @binding(1) var<storage, read> stylesheet: array<Style>;\r
\r
// 渲染参数\r
@group(0) @binding(2) var<uniform> params: RenderParams;\r
\r
// 相机参数\r
@group(0) @binding(3) var<uniform> camera: Camera2D;\r
\r
// #endregion\r
\r
// #region ============================== 辅助函数 ==============================\r
\r
// 返回四边形顶点的局部偏移（相对粒子中心，单位：粒子尺寸）\r
fn quadOffset(vertexId: u32) -> vec2<f32> {\r
    switch vertexId {\r
    case 0u: { return vec2<f32>(-QUAD_HALF, -QUAD_HALF); }\r
    case 1u: { return vec2<f32>(QUAD_HALF, -QUAD_HALF); }\r
    case 2u: { return vec2<f32>(-QUAD_HALF, QUAD_HALF); }\r
    case 3u: { return vec2<f32>(-QUAD_HALF, QUAD_HALF); }\r
    case 4u: { return vec2<f32>(QUAD_HALF, -QUAD_HALF); }\r
    case 5u: { return vec2<f32>(QUAD_HALF, QUAD_HALF); }\r
    default: { return vec2<f32>(0.0); }\r
  }\r
}\r
\r
// 返回四边形顶点的 UV（以粒子中心为原点，范围 [-1, 1]）\r
fn quadUV(vertexId: u32) -> vec2<f32> {\r
    return quadOffset(vertexId) * (2.0 * UV_RADIUS);\r
}\r
\r
// 将世界坐标变换到 NDC\r
fn worldToNdc(worldPos: vec2<f32>) -> vec2<f32> {\r
    return vec2<f32>(\r
        (worldPos.x - camera.centerX) * camera.scaleX,\r
        (worldPos.y - camera.centerY) * camera.scaleY,\r
    );\r
}\r
\r
// 将世界坐标折叠到以相机中心为中心的一个世界周期内（wrap 无限平铺）。\r
// 原理：把坐标相对相机中心做周期取模，使结果落在\r
// [center - size/2, center + size/2) 区间，从而无论相机移到何处，\r
// 粒子都会在视野内正确重复出现，且每个粒子只需绘制一次。\r
fn wrapToCamera(worldPos: vec2<f32>) -> vec2<f32> {\r
    let size = vec2<f32>(params.simWidth, params.simHeight);\r
    let center = vec2<f32>(camera.centerX, camera.centerY);\r
  // 相对相机中心的偏移，折叠到 [-size/2, size/2)\r
    let rel = worldPos - center;\r
    let wrapped = rel - floor(rel / size + 0.5) * size;\r
    return center + wrapped;\r
}\r
\r
// 构造一个不可见的输出（用于越界时提前返回）\r
fn invisibleOutput() -> VertexOutput {\r
    var output: VertexOutput;\r
    output.position = vec4<f32>(0.0, 0.0, 0.0, 1.0);\r
    output.color = vec4<f32>(0.0);\r
    output.uv = vec2<f32>(0.0);\r
    return output;\r
}\r
\r
// #endregion\r
\r
// #region ============================== 顶点着色器 ==============================\r
\r
@vertex\r
fn vertexMain(\r
    @builtin(vertex_index) vertexId: u32,\r
    @builtin(instance_index) instanceId: u32\r
) -> VertexOutput {\r
  // 边界检查：粒子索引与类型索引不能越界\r
    if instanceId >= params.numParticles {\r
        return invisibleOutput();\r
    }\r
\r
    let p = particles[instanceId];\r
    let typeId = u32(p.typeId);\r
    if typeId >= params.numTypes {\r
        return invisibleOutput();\r
    }\r
\r
    let style = stylesheet[typeId];\r
\r
  // 粒子中心（wrap 模式下先折叠到相机附近的一个世界周期内）\r
    var center = vec2<f32>(p.posX, p.posY);\r
    if params.boundary == 0u {\r
        center = wrapToCamera(center);\r
    }\r
\r
  // 世界坐标 = 折叠后的粒子中心 + 局部偏移 * 粒子尺寸\r
  // 注意：必须只折叠中心，再叠加四边形偏移，否则四边形跨越世界边界时\r
  // 各顶点会被折叠到不同周期，导致四边形被拉长成横跨世界的长条。\r
    let worldPos = center + quadOffset(vertexId) * style.size;\r
\r
    var output: VertexOutput;\r
    output.position = vec4<f32>(worldToNdc(worldPos), 0.0, 1.0);\r
    output.color = vec4<f32>(style.color_r, style.color_g, style.color_b, style.color_a);\r
    output.uv = quadUV(vertexId);\r
    return output;\r
}\r
\r
// #endregion\r
\r
// #region ============================== 片元着色器 ==============================\r
\r
@fragment\r
fn fragmentMain(\r
    @location(0) color: vec4<f32>,\r
    @location(1) uv: vec2<f32>\r
) -> @location(0) vec4<f32> {\r
  // 到圆心的距离（UV 半径归一化为 1）\r
    let dist = length(uv);\r
\r
  // 裁剪圆形外的像素\r
    if dist > UV_RADIUS {\r
    discard;\r
    }\r
\r
  // 边缘抗锯齿：从 EDGE_START 到 UV_RADIUS 平滑过渡\r
    let alpha = color.a * (1.0 - smoothstep(EDGE_START, UV_RADIUS, dist));\r
\r
  // 输出预乘 alpha（与渲染管线的 premultiplied alpha 混合模式匹配），\r
  // 否则边缘半透明像素的 RGB 仍为全亮颜色，叠加后会出现白色亮边。\r
    return vec4<f32>(color.rgb * alpha, alpha);\r
}\r
\r
// #endregion\r
`,n=64,r=6,i=5,a=3,o=64,s=16,c=class{numParticles=1e3;numTypes=8;simWidth=1024;simHeight=1024;boundary=0;maxDist=100;forceFactor=100;frictionFactor=.9;pointSize=6},l=class{device;context;format;numParticles;numTypes;maxDist;forceFactor;frictionFactor;pointSize;pointSaturation=.8;pointLightness=.6;boundary;simWidth;simHeight;cameraCenterX=0;cameraCenterY=0;cameraScaleX=1;cameraScaleY=1;gridSizeX=0;gridSizeY=0;particleBufferA;particleBufferB;gridCellCountsBuffer;gridCellOffsetBuffer;rulesMatrixBuffer;styleBuffer;computeParamsBuffer;renderParamsBuffer;cameraBuffer;renderBindGroupLayout;computeBindGroupLayout;computeBindGroupA;computeBindGroupB;renderBindGroup;clearGridPipeline;fillGridPipeline;prefixSumPipeline;sortParticlesPipeline;computeForcePipeline;renderPipeline;constructor(e,t,n,r={}){this.device=e,this.context=t,this.format=n;let i=new c;this.numParticles=r.numParticles??i.numParticles,this.numTypes=r.numTypes??i.numTypes,this.boundary=r.boundary??i.boundary,this.simWidth=r.simWidth??i.simWidth,this.simHeight=r.simHeight??i.simHeight,this.maxDist=r.maxDist??i.maxDist,this.forceFactor=r.forceFactor??i.forceFactor,this.frictionFactor=r.frictionFactor??i.frictionFactor,this.pointSize=r.pointSize??i.pointSize,this.init()}init(){this.createParticleBuffers(p(this.numParticles,this.numTypes,this.simWidth,this.simHeight)),this.createGridBuffers(),this.createRuleBuffer(m(this.numTypes)),this.createStyleBuffer(),this.createCameraBuffer(),this.updateComputeParams(0),this.updateRenderParams(0),this.createBindGroupLayouts(),this.createComputeBindGroup(),this.createRenderBindGroup(),this.createComputePipelines(),this.createRenderPipeline()}destroy(){this.particleBufferA?.destroy(),this.particleBufferB?.destroy(),this.gridCellCountsBuffer?.destroy(),this.gridCellOffsetBuffer?.destroy(),this.rulesMatrixBuffer?.destroy(),this.computeParamsBuffer?.destroy(),this.cameraBuffer?.destroy(),this.styleBuffer?.destroy()}createParticleBuffers(e){let t=h(this.numParticles,n)*r*Float32Array.BYTES_PER_ELEMENT;(!this.particleBufferA||this.particleBufferA.size!==t)&&(this.particleBufferA?.destroy(),this.particleBufferB?.destroy(),this.particleBufferA=this.device.createBuffer({label:`ParticleBuffer`,size:t,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC}),this.particleBufferB=this.device.createBuffer({label:`ParticleTempBuffer`,size:t,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC})),e&&(this.device.queue.writeBuffer(this.particleBufferA,0,e),this.device.queue.writeBuffer(this.particleBufferB,0,e))}createGridBuffers(){this.gridSizeX=Math.floor(this.simWidth/this.maxDist),this.gridSizeY=Math.floor(this.simHeight/this.maxDist),this.gridSizeX<1&&(this.gridSizeX=1),this.gridSizeY<1&&(this.gridSizeY=1);let e=this.gridSizeX*this.gridSizeY,t=h(e,n)*Uint32Array.BYTES_PER_ELEMENT;(!this.gridCellCountsBuffer||this.gridCellCountsBuffer.size!==t)&&(this.gridCellCountsBuffer?.destroy(),this.gridCellCountsBuffer=this.device.createBuffer({label:`GridCellCountsBuffer`,size:t,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}));let r=h(e+1,n)*Uint32Array.BYTES_PER_ELEMENT;(!this.gridCellOffsetBuffer||this.gridCellOffsetBuffer.size!==r)&&(this.gridCellOffsetBuffer?.destroy(),this.gridCellOffsetBuffer=this.device.createBuffer({label:`GridCellOffsetBuffer`,size:r,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC}))}createRuleBuffer(e){let t=this.numTypes*this.numTypes*a*Float32Array.BYTES_PER_ELEMENT;(!this.rulesMatrixBuffer||this.rulesMatrixBuffer.size!==t)&&(this.rulesMatrixBuffer?.destroy(),this.rulesMatrixBuffer=this.device.createBuffer({label:`RulesMatrixBuffer`,size:t,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST})),e&&this.device.queue.writeBuffer(this.rulesMatrixBuffer,0,e)}createStyleBuffer(e){let t=e??f(this.numTypes,this.pointSize,this.pointSaturation,this.pointLightness),n=t.byteLength;(!this.styleBuffer||this.styleBuffer.size!==n)&&(this.styleBuffer?.destroy(),this.styleBuffer=this.device.createBuffer({label:`StyleBuffer`,size:n,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST})),this.device.queue.writeBuffer(this.styleBuffer,0,t)}updateComputeParams(e){let t=new ArrayBuffer(o),n=new Uint32Array(t),r=new Float32Array(t);n[0]=this.numParticles,n[1]=this.numTypes,n[2]=this.boundary,r[3]=this.maxDist,r[4]=this.forceFactor,r[5]=this.frictionFactor,r[6]=this.simWidth,r[7]=this.simHeight,n[8]=this.gridSizeX,n[9]=this.gridSizeY,r[10]=e,r[11]=0,this.computeParamsBuffer??=this.device.createBuffer({label:`ComputeParams`,size:o,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.device.queue.writeBuffer(this.computeParamsBuffer,0,t)}updateRenderParams(e){let t=new ArrayBuffer(o),n=new Uint32Array(t),r=new Float32Array(t);n[0]=this.numParticles,n[1]=this.numTypes,n[2]=this.boundary,r[3]=this.maxDist,r[4]=this.forceFactor,r[5]=this.frictionFactor,r[6]=this.simWidth,r[7]=this.simHeight,n[8]=this.gridSizeX,n[9]=this.gridSizeY,r[10]=e,r[11]=0,this.renderParamsBuffer??=this.device.createBuffer({label:`RenderParams`,size:o,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.device.queue.writeBuffer(this.renderParamsBuffer,0,t)}createCameraBuffer(){this.cameraCenterX=this.simWidth*.5,this.cameraCenterY=this.simHeight*.5,this.cameraScaleX=2/this.simWidth,this.cameraScaleY=-2/this.simHeight,this.cameraBuffer??=this.device.createBuffer({label:`CameraBuffer`,size:s,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.writeCameraBuffer()}writeCameraBuffer(){let e=new Float32Array([this.cameraCenterX,this.cameraCenterY,this.cameraScaleX,this.cameraScaleY]);this.device.queue.writeBuffer(this.cameraBuffer,0,e)}createBindGroupLayouts(){this.computeBindGroupLayout=this.device.createBindGroupLayout({label:`ComputeBindGroupLayout`,entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:`read-only-storage`}},{binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:`storage`}},{binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:`storage`}},{binding:3,visibility:GPUShaderStage.COMPUTE,buffer:{type:`storage`}},{binding:4,visibility:GPUShaderStage.COMPUTE,buffer:{type:`read-only-storage`}},{binding:5,visibility:GPUShaderStage.COMPUTE,buffer:{type:`uniform`}}]}),this.renderBindGroupLayout=this.device.createBindGroupLayout({label:`RenderBindGroupLayout`,entries:[{binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:`read-only-storage`}},{binding:1,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:`read-only-storage`}},{binding:2,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:`uniform`}},{binding:3,visibility:GPUShaderStage.VERTEX,buffer:{type:`uniform`}}]})}createComputeBindGroup(){this.computeBindGroupA=this.device.createBindGroup({label:`ComputeBindGroup`,layout:this.computeBindGroupLayout,entries:[{binding:0,resource:{buffer:this.particleBufferA}},{binding:1,resource:{buffer:this.particleBufferB}},{binding:2,resource:{buffer:this.gridCellCountsBuffer}},{binding:3,resource:{buffer:this.gridCellOffsetBuffer}},{binding:4,resource:{buffer:this.rulesMatrixBuffer}},{binding:5,resource:{buffer:this.computeParamsBuffer}}]}),this.computeBindGroupB=this.device.createBindGroup({label:`ComputeBindGroup`,layout:this.computeBindGroupLayout,entries:[{binding:0,resource:{buffer:this.particleBufferB}},{binding:1,resource:{buffer:this.particleBufferA}},{binding:2,resource:{buffer:this.gridCellCountsBuffer}},{binding:3,resource:{buffer:this.gridCellOffsetBuffer}},{binding:4,resource:{buffer:this.rulesMatrixBuffer}},{binding:5,resource:{buffer:this.computeParamsBuffer}}]})}createRenderBindGroup(){this.renderBindGroup=this.device.createBindGroup({label:`RenderBindGroup`,layout:this.renderBindGroupLayout,entries:[{binding:0,resource:{buffer:this.particleBufferA}},{binding:1,resource:{buffer:this.styleBuffer}},{binding:2,resource:{buffer:this.renderParamsBuffer}},{binding:3,resource:{buffer:this.cameraBuffer}}]})}createComputePipelines(){let t=this.device.createShaderModule({code:e,label:`ComputeShader`}),n=this.device.createPipelineLayout({label:`ComputePipelineLayout`,bindGroupLayouts:[this.computeBindGroupLayout]});this.clearGridPipeline=this.device.createComputePipeline({label:`ClearGridPipeline`,layout:n,compute:{module:t,entryPoint:`clearGrid`}}),this.fillGridPipeline=this.device.createComputePipeline({label:`FillGridPipeline`,layout:n,compute:{module:t,entryPoint:`fillGrid`}}),this.prefixSumPipeline=this.device.createComputePipeline({label:`PrefixSumPipeline`,layout:n,compute:{module:t,entryPoint:`prefixSum`}}),this.sortParticlesPipeline=this.device.createComputePipeline({label:`SortParticlesPipeline`,layout:n,compute:{module:t,entryPoint:`sortParticles`}}),this.computeForcePipeline=this.device.createComputePipeline({label:`ComputeForcePipeline`,layout:n,compute:{module:t,entryPoint:`computeForce`}})}createRenderPipeline(){let e=this.device.createShaderModule({code:t,label:`RenderShader`}),n=this.device.createPipelineLayout({label:`RenderPipelineLayout`,bindGroupLayouts:[this.renderBindGroupLayout]});this.renderPipeline=this.device.createRenderPipeline({label:`ParticleRenderPipeline`,layout:n,vertex:{module:e,entryPoint:`vertexMain`},fragment:{module:e,entryPoint:`fragmentMain`,targets:[{format:this.format,blend:{color:{srcFactor:`one`,dstFactor:`one-minus-src-alpha`,operation:`add`},alpha:{srcFactor:`one`,dstFactor:`one-minus-src-alpha`,operation:`add`}}}]},primitive:{topology:`triangle-list`}})}update(e){this.updateComputeParams(e),this.updateRenderParams(e);let t=this.device.createCommandEncoder(),r=Math.ceil(this.gridSizeX*this.gridSizeY/n),i=Math.ceil(this.numParticles/n),a=t.beginComputePass();a.setPipeline(this.clearGridPipeline),a.setBindGroup(0,this.computeBindGroupA),a.dispatchWorkgroups(r),a.end();let o=t.beginComputePass();o.setPipeline(this.fillGridPipeline),o.setBindGroup(0,this.computeBindGroupA),o.dispatchWorkgroups(i),o.end();let s=t.beginComputePass();s.setPipeline(this.prefixSumPipeline),s.setBindGroup(0,this.computeBindGroupA),s.dispatchWorkgroups(1),s.end();let c=t.beginComputePass();c.setPipeline(this.sortParticlesPipeline),c.setBindGroup(0,this.computeBindGroupA),c.dispatchWorkgroups(i),c.end();let l=t.beginComputePass();l.setPipeline(this.computeForcePipeline),l.setBindGroup(0,this.computeBindGroupB),l.dispatchWorkgroups(i),l.end(),this.device.queue.submit([t.finish()])}render(){let e=this.device.createCommandEncoder(),t=e.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:0},loadOp:`clear`,storeOp:`store`}]});t.setPipeline(this.renderPipeline),t.setBindGroup(0,this.renderBindGroup),t.draw(6,this.numParticles),t.end(),this.device.queue.submit([e.finish()])}setBoundary(e){this.boundary=e,this.updateComputeParams(0),this.updateRenderParams(0)}getSimSize(){return{width:this.simWidth,height:this.simHeight}}setCamera(e,t,n,r){this.cameraCenterX=e,this.cameraCenterY=t,this.cameraScaleX=n,this.cameraScaleY=r,this.writeCameraBuffer()}panCameraByPixels(e,t,n,r){let i=e*2/n/Math.abs(this.cameraScaleX),a=t*2/r/Math.abs(this.cameraScaleY);this.setCamera(this.cameraCenterX-i,this.cameraCenterY-a,this.cameraScaleX,this.cameraScaleY)}zoomCameraAt(e,t,n,r,i){if(e<=0||!Number.isFinite(e))return;let a=t/r*2-1,o=1-n/i*2,s=this.cameraCenterX+a/this.cameraScaleX,c=this.cameraCenterY+o/this.cameraScaleY,l=this.cameraScaleX*e,u=this.cameraScaleY*e,d=s-a/l,f=c-o/u;this.setCamera(d,f,l,u)}updateWorldSize(e,t){this.simWidth=e,this.simHeight=t,this.createGridBuffers(),this.createCameraBuffer(),this.createComputeBindGroup(),this.updateComputeParams(0),this.updateRenderParams(0)}async readParticles(){let e=h(this.numParticles,n)*r*Float32Array.BYTES_PER_ELEMENT,t=await this.readBuffer(this.particleBufferA,e);return new Float32Array(t.slice(0,this.numParticles*r*Float32Array.BYTES_PER_ELEMENT))}async readGridOffsets(){let e=(this.gridSizeY*this.gridSizeX+1)*Uint32Array.BYTES_PER_ELEMENT,t=await this.readBuffer(this.gridCellOffsetBuffer,e);return new Uint32Array(t.slice(0,e))}async readBuffer(e,t){let n=this.device.createBuffer({label:`ReadbackBuffer`,size:t,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),r=this.device.createCommandEncoder({label:`ReadbackEncoder`});r.copyBufferToBuffer(e,0,n,0,t),this.device.queue.submit([r.finish()]),await n.mapAsync(GPUMapMode.READ);let i=n.getMappedRange().slice(0);return n.unmap(),n.destroy(),i}},u=(e,t,n)=>{e=(e%360+360)%360;let r=(1-Math.abs(2*n-1))*t,i=e/60,a=r*(1-Math.abs(i%2-1)),o=n-r/2;return i<1?[r+o,a+o,o]:i<2?[a+o,r+o,o]:i<3?[o,r+o,a+o]:i<4?[o,a+o,r+o]:i<5?[a+o,o,r+o]:[r+o,o,a+o]},d=(e,t,n)=>{let r=new Float32Array(e*3);for(let i=0;i<e;i++){let[a,o,s]=u(i/e*360,t,n);r[i*3+0]=a,r[i*3+1]=o,r[i*3+2]=s}return r},f=(e,t,n,r)=>{let a=new Float32Array(e*i),o=d(e,n,r);for(let n=0;n<e;n++){let e=n*i;a[e+0]=t,a[e+1]=o[n*3+0],a[e+2]=o[n*3+1],a[e+3]=o[n*3+2],a[e+4]=1}return a},p=(e,t,n,i)=>{let a=new Float32Array(e*r);for(let o=0;o<e;o++){let e=o*r;a[e+0]=Math.random()*n,a[e+1]=Math.random()*i,a[e+2]=0,a[e+3]=0,a[e+4]=Math.floor(Math.random()*t),a[e+5]=0}return a},m=e=>{let t=new Float32Array(e*e*a);for(let n=0;n<e*e;n++){let e=Math.random()*2-1,r=Math.random(),i=Math.random();t[n*a+0]=e,t[n*a+1]=Math.min(r,i),t[n*a+2]=Math.max(r,i)}return t},h=(e,t)=>Math.ceil(e/t)*t;async function g(){let e=await(await navigator.gpu?.requestAdapter())?.requestDevice();if(!e)throw Error(`WebGPU not supported`);let t=document.querySelector(`canvas`);if(!t)throw Error(`未找到 Canvas 元素`);let n=t.getContext(`webgpu`);if(!n)throw Error(`WebGPU context not available`);let r=navigator.gpu.getPreferredCanvasFormat(),i=t.clientWidth,a=t.clientHeight;t.width=i,t.height=a,n.configure({device:e,format:r,alphaMode:`premultiplied`});let o=new l(e,n,r,{numParticles:1e5,numTypes:8,maxDist:50,forceFactor:200,frictionFactor:.7,simWidth:i,simHeight:a,boundary:0,pointSize:4}),s=!1,c=0,u=0;t.addEventListener(`pointerdown`,e=>{s=!0,c=e.clientX,u=e.clientY,t.setPointerCapture(e.pointerId),t.style.cursor=`grabbing`}),t.addEventListener(`pointermove`,e=>{if(!s)return;let n=e.clientX-c,r=e.clientY-u;c=e.clientX,u=e.clientY,o.panCameraByPixels(n,r,t.width,t.height)});let d=e=>{s&&(s=!1,t.releasePointerCapture(e.pointerId),t.style.cursor=`grab`)};t.addEventListener(`pointerup`,d),t.addEventListener(`pointercancel`,d),t.style.cursor=`grab`,t.addEventListener(`wheel`,e=>{e.preventDefault();let n=Math.exp(-e.deltaY*.001),r=t.getBoundingClientRect(),i=(e.clientX-r.left)/r.width*t.width,a=(e.clientY-r.top)/r.height*t.height;o.zoomCameraAt(n,i,a,t.width,t.height)},{passive:!1});let f=performance.now();function p(e){let t=Math.min((e-f)/1e3,.05);f=e,o.update(t),o.render(),requestAnimationFrame(p)}requestAnimationFrame(p)}g();