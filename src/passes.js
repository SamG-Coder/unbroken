import * as T from "three/webgpu";
import * as N from "three/tsl";

// A fullscreen effect rendered into its own (usually reduced) target, ordered
// inside the node graph so it can read this frame's depth.
export class SubPass extends T.Node {
  static get type() { return "SubPass"; }
  constructor(build, scale = 0.5, { type = T.HalfFloatType } = {}) {
    super("vec4");
    this.makeFragment = build;
    this.scale = scale;
    this.updateBeforeType = T.NodeUpdateType.FRAME;
    this.rt = new T.RenderTarget(1, 1, { depthBuffer: false, type, format: T.RGBAFormat });
    this.rt.texture.minFilter = this.rt.texture.magFilter = T.LinearFilter;
    this.material = new T.NodeMaterial();
    this.material.name = "SubPass";
    this.quad = new T.QuadMesh(this.material);
    this.textureNode = N.passTexture(this, this.rt.texture);
    this.enabled = true;
    this._size = new T.Vector2();
  }
  getTextureNode() { return this.textureNode; }
  updateBefore({ renderer }) {
    if (!this.enabled) return;
    renderer.getDrawingBufferSize(this._size);
    const w = Math.max(1, Math.round(this._size.x * this.scale)), h = Math.max(1, Math.round(this._size.y * this.scale));
    if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    const prev = renderer.getRenderTarget();
    const mrt = renderer.getMRT();
    renderer.setMRT(null);
    renderer.setRenderTarget(this.rt);
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
    renderer.setMRT(mrt);
  }
  setup(builder) {
    this.material.fragmentNode = this.makeFragment();
    this.material.needsUpdate = true;
    return this.textureNode;
  }
}

export const subPass = (build, scale, opts) => {
  const node = new SubPass(build, scale, opts);
  const tex = node.getTextureNode();
  tex.passNode = node;
  return tex;
};

// World-space view ray and position reconstructed from a depth sample.
export const rayFromUV = (uv, camera) => {
  const clip = N.vec4(uv.x.mul(2).sub(1), N.float(1).sub(uv.y).mul(2).sub(1), 0.5, 1);
  const view = N.cameraProjectionMatrixInverse.mul(clip);
  const w = N.cameraWorldMatrix.mul(N.vec4(view.xyz.div(view.w), 0)).xyz;
  return N.normalize(w);
};

export const blueNoiseish = (coord, frame) => {
  // Interleaved gradient noise, animated by a golden-ratio frame offset.
  const p = coord.add(frame.mul(5.588238));
  return N.fract(N.fract(p.x.mul(0.06711056).add(p.y.mul(0.00583715))).mul(52.9829189));
};
