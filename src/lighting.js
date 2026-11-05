import * as T from "three/webgpu";
import * as N from "three/tsl";

// PhysicalLightingModel plus two things every AAA foliage shader has: an extra
// visibility term (baked sun horizon) and transmitted light through thin matter.
export class FoliageModel extends T.PhysicalLightingModel {
  constructor(visibility, translucency, tint, diffuseOnly) {
    super();
    this.diffuseOnly = diffuseOnly;
    this.visibility = visibility;
    this.translucency = translucency;
    this.tint = tint;
  }
  direct(args, builder) {
    const { lightDirection, reflectedLight } = args;
    if (this.visibility) args.lightColor = args.lightColor.mul(this.visibility);
    if (this.translucency) {
      // Back light scatters through: strongest looking towards the sun.
      const v = N.positionViewDirection;
      const n = N.normalView;
      const through = N.clamp(lightDirection.negate().dot(v), 0, 1).pow(5).mul(0.11).add(N.clamp(n.dot(lightDirection).negate(), 0, 1).mul(0.08));
      reflectedLight.directDiffuse.addAssign(
        args.lightColor.mul(through).mul(this.translucency).mul(this.tint).mul(1 / Math.PI),
      );
    }
    if (this.diffuseOnly) {
      // Rough matter in a low sun: Schlick Fresnel would turn every grazing surface
      // into a mirror of the sun. Grass, leaves and soil scatter; they do not gleam.
      const dotNL = N.clamp(N.normalView.dot(lightDirection), 0, 1);
      reflectedLight.directDiffuse.addAssign(dotNL.mul(args.lightColor).mul(N.diffuseColor.rgb).mul(1 / Math.PI));
      return;
    }
    super.direct(args, builder);
  }
}

export class LitStandard extends T.MeshStandardNodeMaterial {
  constructor(params, { visibility = null, translucency = null, tint = null, diffuseOnly = false } = {}) {
    super(params);
    this._model = { visibility, translucency, tint, diffuseOnly };
  }
  setupLightingModel() {
    return new FoliageModel(this._model.visibility, this._model.translucency, this._model.tint, this._model.diffuseOnly);
  }
}
