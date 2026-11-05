import * as T from "three/webgpu";

// Thin helpers for one-shot GPU work on the renderer's own device. Everything
// the film shows is generated here at load: no texture or model files exist.

export function storage2D(renderer, size, { format = "rgba8", mips = false, wrap = true, name = "" } = {}) {
  const t = new T.StorageTexture(size, size);
  t.name = name;
  if (format === "rgba32f") t.type = T.FloatType;
  else if (format === "rgba16f") t.type = T.HalfFloatType;
  else t.type = T.UnsignedByteType;
  t.format = T.RGBAFormat;
  t.wrapS = t.wrapT = wrap ? T.RepeatWrapping : T.ClampToEdgeWrapping;
  t.magFilter = T.LinearFilter;
  t.minFilter = mips ? T.LinearMipmapLinearFilter : T.LinearFilter;
  t.generateMipmaps = mips;
  t.mipmapsAutoUpdate = false;
  t.anisotropy = mips ? 8 : 1;
  renderer.initTexture(t);
  return { texture: t, gpu: renderer.backend.get(t).texture, size };
}

export function storage3D(renderer, size, name = "") {
  const t = new T.Storage3DTexture(size, size, size);
  t.name = name;
  t.type = T.UnsignedByteType;
  t.format = T.RGBAFormat;
  t.wrapS = t.wrapT = t.wrapR = T.RepeatWrapping;
  t.magFilter = T.LinearFilter;
  t.minFilter = T.LinearFilter;
  t.generateMipmaps = false;
  t.mipmapsAutoUpdate = false;
  renderer.initTexture(t);
  return { texture: t, gpu: renderer.backend.get(t).texture, size };
}

export function dispatch(renderer, code, resources, groups, label = "bake") {
  const device = renderer.backend.device;
  const pipeline = device.createComputePipeline({
    label,
    layout: "auto",
    compute: { module: device.createShaderModule({ label, code }), entryPoint: "main" },
  });
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: resources.map((resource, binding) => ({ binding, resource })),
  });
  const enc = device.createCommandEncoder({ label });
  const pass = enc.beginComputePass({ label });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(...groups);
  pass.end();
  device.queue.submit([enc.finish()]);
}

const MIP_WGSL = (fmt) => `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<${fmt}, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy) * 2;
  textureStore(dst, vec2i(id.xy), (textureLoad(src, p, 0) + textureLoad(src, p + vec2i(1, 0), 0)
    + textureLoad(src, p + vec2i(0, 1), 0) + textureLoad(src, p + vec2i(1, 1), 0)) * 0.25);
}`;

export function buildMips(renderer, tex, fmt = "rgba8unorm") {
  const device = renderer.backend.device;
  const levels = tex.gpu.mipLevelCount;
  if (levels <= 1) return;
  const module = device.createShaderModule({ code: MIP_WGSL(fmt), label: "mips" });
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
  const enc = device.createCommandEncoder({ label: "mips" });
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  for (let m = 1; m < levels; m++) {
    pass.setBindGroup(0, device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tex.gpu.createView({ baseMipLevel: m - 1, mipLevelCount: 1 }) },
        { binding: 1, resource: tex.gpu.createView({ baseMipLevel: m, mipLevelCount: 1 }) },
      ],
    }));
    const n = Math.ceil(Math.max(1, tex.size >> m) / 8);
    pass.dispatchWorkgroups(n, n);
  }
  pass.end();
  device.queue.submit([enc.finish()]);
}

export async function readback(renderer, gpuTexture, size, bytesPerPixel = 16) {
  const device = renderer.backend.device;
  const row = size * bytesPerPixel;
  const buffer = device.createBuffer({ size: row * size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: gpuTexture }, { buffer, bytesPerRow: row }, [size, size]);
  device.queue.submit([enc.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return out;
}

// Shared WGSL noise library for the bakes.
export const NOISE_WGSL = /* wgsl */ `
fn hash12(p: vec2f) -> f32 { var q = fract(vec3f(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
fn hash22(p: vec2f) -> vec2f { var q = fract(vec3f(p.xyx) * vec3f(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
fn hash33(p0: vec3f) -> vec3f { var p = fract(p0 * vec3f(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
// Value noise with analytic derivatives: (value, d/dx, d/dy).
fn noised(p: vec2f) -> vec3f {
  let i = floor(p); let f = p - i;
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  let a = hash12(i); let b = hash12(i + vec2f(1, 0)); let c = hash12(i + vec2f(0, 1)); let d = hash12(i + vec2f(1, 1));
  let k1 = b - a; let k2 = c - a; let k4 = a - b - c + d;
  return vec3f(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * (vec2f(k1, k2) + k4 * u.yx));
}
fn fbm2(p0: vec2f, oct: i32) -> f32 {
  var p = p0; var a = 0.5; var s = 0.0;
  for (var i = 0; i < oct; i++) { s += a * noised(p).x; p = mat2x2f(1.6, 1.2, -1.2, 1.6) * p + vec2f(17.1, 9.2); a *= 0.5; }
  return s;
}
`;
