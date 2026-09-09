import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { smaa } from "three/addons/tsl/display/SMAANode.js";
import {
  cross,
  dFdx,
  dFdy,
  dot,
  emissive,
  Fn,
  faceDirection,
  float,
  If,
  materialColor,
  materialRoughness,
  max,
  mix,
  mrt,
  mx_noise_float,
  normalMap,
  normalView,
  output,
  pass,
  positionView,
  positionWorld,
  smoothstep,
  texture,
  uniform,
  uv,
  vec3,
} from "three/tsl";
import * as THREE from "three/webgpu";
import type { BanzhuanDeviceState } from "../../../hooks/useDeviceState.js";
import type { ResolvedTheme } from "../../../hooks/useResolvedTheme.js";
import { unpadRows } from "./art-export-math.js";
import { advanceLift, createLiftPose } from "./lift.js";
import {
  applyCloudy,
  cardHourFor,
  hourDelta,
  lightingAt,
  STATE_TARGETS,
  timeWeights,
  type WeatheredLighting,
} from "./lighting.js";
import { pictureChanged, type ShownPicture } from "./render-gate.js";

/**
 * The 3D device card's scene (ADR 0057 §2, amended §2.1b: the pale room):
 * the owner's Cycles-baked HRT-001 study (reference_UX_design/
 * banzhuan-3d-demo, main-webgpu.js + baked-material.js + device-surface.js)
 * reduced to what the app card needs, in the study's "Previous · pale
 * room" configuration with the room's surfaces taken to the card's white.
 *
 * Kept from the study: the compact mesh and its atlases, the baked ring
 * illumination and daylight bounce, the alcove (its pale-room light
 * exchange bakes), the live key / fill / rim / sky / softbox lights with
 * VSM shadows on the device and the room, the night outline spotlight and
 * exposure adaptation, the satin-mineral surface refinement, MSAA (2×, the
 * study's 4× halved for an iGPU, §2.9) + emissive bloom + SMAA, on-demand
 * rendering with an idle governor. The study's LTC softbox is a
 * directional light here (§2.9).
 *
 * Dropped: the mineral-room material noise and shaped light, weather, the
 * time slider and day playback, the compare wipe, the quality and
 * asset-profile selectors, the source-texture fallbacks (a machine that
 * cannot transcode KTX2 keeps the flat card). Time of day follows the
 * CLOCK in the light theme, folded so the card never leaves daylight, and
 * is the study's midnight in the dark theme (lighting.ts `cardHourFor`).
 *
 * Loaded lazily by DeviceScene.tsx — three.js stays out of the boot bundle.
 */

/** Design units → metres (the GLB is physical; the study's camera and light
 *  positions are in the old Blender display units). */
const UNIT = 0.05;
/** The flat card's preview box, CSS px, and the device's height in it: the
 *  art's visible silhouette is 934/1403 of the box, 179.74 px, and the 3D
 *  device is framed to the same height. The art is rendered from this
 *  scene at that framing (§2.14), so the two agree by construction. */
export const FLAT_BOX_CSS = { width: 216, height: 270 } as const;
const DEVICE_HEIGHT_PX = (FLAT_BOX_CSS.height * 934) / 1403;
/** The rail card's content box at the resting rail width (338 × 330 less
 *  its border): the canvas's own size, which the bundled frost picture
 *  is rendered for (§2.13). The narrow layout's 298 × 298 card stretches
 *  it a little under the blur. */
export const CARD_BOX_CSS = { width: 336, height: 328 } as const;
/** The study's card-mode buffer policy: ≥1.5× at DPR 1, honour up to 2×,
 *  cap the long edge at 768 px. */
const MAX_LONG_EDGE_PX = 768;
/** Idle governor (after DeviceGlow / AuraVisual, which breathe at 30): the
 *  loop TICKS at 20 Hz while breathing — every third vsync; its fastest
 *  cycle is 1.35 s, so a tick moves the lamp under 1/255 of its range —
 *  and DRAWS only the ticks that would change the picture (render-gate.ts,
 *  §2.10: about a third of them at idle). Motion draws at 60, and the loop
 *  parks after 5 s unfocused. Every drawn frame is a full scene render on
 *  the GPU, so the draw rate is the power lever (ADR 0057 §2.9). */
const CALM_FPS = 20;
const MOVING_FPS = 60;
/** Both shadow maps: the key's 10-unit frustum at 512² is a 0.02-unit
 *  texel, about one canvas pixel, under the VSM blur; 1024² cost four times
 *  the depth and blur passes for no visible gain (ADR 0057 §2.9). */
const SHADOW_MAP_SIZE = 512;
/** The scene pass's MSAA (§2.9: the study's 4× halved). */
const SCENE_MSAA_SAMPLES = 2;
const PARK_UNFOCUSED_MS = 5000;
/** How often a resting loop is nudged to follow the clock. A breathing
 *  card re-reads the clock every frame anyway; this is for reduced motion,
 *  where the loop stops between events. */
const CLOCK_WAKE_MS = 60_000;

/** The room's surfaces (linear RGB, roughness), a white room: the card's
 *  frost is about 0.9 linear, the walls sit just under it so the key's
 *  shadow and the ring's spill still read on them; the left wall a step
 *  darker for separation, as in the study's pale box. */
const ROOM_SURFACES = {
  ground: { color: [0.84, 0.855, 0.86] as const, roughness: 0.88 },
  back: { color: [0.88, 0.895, 0.9] as const, roughness: 0.9 },
  left: { color: [0.8, 0.82, 0.83] as const, roughness: 0.92 },
};

export interface DeviceSceneInputs {
  readonly state: BanzhuanDeviceState;
  readonly theme: ResolvedTheme;
  readonly reducedMotion: boolean;
  readonly paused: boolean;
  /** The drag hook's lift target in CSS px (0 when released). */
  readonly liftPx: number;
}

export interface DeviceSceneOptions {
  readonly canvas: HTMLCanvasElement;
  readonly forceWebGL: boolean;
  readonly assetUrl: (file: string) => string;
  readonly initial: DeviceSceneInputs;
  /** Enable GPU timestamp queries and report `gpuMs` in the canvas dataset
   *  beside the always-on fps / submitMs / draws. Costs a little per frame;
   *  off unless a developer asks (localStorage `herta.deviceScene.profile`). */
  readonly profile?: boolean;
  /** Awaited between the asynchronous pipeline compile and the synchronous
   *  first frame (§2.12): the compile takes seconds, so whatever quiet the
   *  caller waited for before building is over — this lets it wait again. */
  readonly awaitQuiet?: () => Promise<void>;
  /** The scene can no longer draw (device lost, context lost). The caller
   *  returns the card to its flat renders; the handle is already disposed. */
  readonly onFallback: (reason: string) => void;
  /**
   * Driven a moment at a time by the caller (a film renderer, a still):
   * no frame loop, no clock, nothing scheduled — `renderAt` draws exactly
   * the moment it is given, synchronously, so a frame is a pure function
   * of its inputs. `pixelRatio` sizes the drawing buffer in place of the
   * window's; `context` is a WebGL2 context the caller made (with
   * `forceWebGL`), for attributes the scene does not set itself —
   * preserveDrawingBuffer, say, so a screenshot finds the frame.
   */
  readonly driven?: {
    readonly pixelRatio: number;
    readonly context?: WebGL2RenderingContext;
  };
}

/** One moment of the driven scene (`DeviceSceneOptions.driven`). */
export interface DeviceSceneMoment {
  /** The card's hour, 0–24. The theme's clock fold does not apply — the
   *  caller says the hour; the lighting tables are the same. */
  readonly hour: number;
  /** Seconds elapsed: the indicator's breath and the cloud drift. */
  readonly seconds: number;
  /** The lift in CSS px, settled (no spring). 0 when absent. */
  readonly liftPx?: number;
}

export interface DeviceSceneStats {
  readonly backend: "webgpu" | "webgl2";
  /** Renderer init → assets loaded, ms. */
  readonly loadMs: number;
  /** The scene materials' asynchronous pipeline compilation, ms (§2.12:
   *  on Dawn's worker threads, the app stays responsive meanwhile). */
  readonly compileMs: number;
  /** The synchronous first frame, ms (shadow and post pipelines, uploads). */
  readonly firstFrameMs: number;
  /** Submission → the frame on screen, ms (the GPU's own compile tail). */
  readonly presentMs: number;
}

export interface DeviceSceneHandle {
  readonly stats: DeviceSceneStats;
  update(inputs: DeviceSceneInputs): void;
  /** A small JPEG data URL of what the card shows right now — the frame
   *  rendered once more into an offscreen target at a quarter of the
   *  buffer and read back (§2.13's frosted glass for the next launch).
   *  Null when the scene is gone or the backend cannot read back. */
  snapshot(): Promise<string | null>;
  /** Driven mode only (`DeviceSceneOptions.driven`): draw one moment. In
   *  loop mode the next tick overwrites it. */
  renderAt(moment: DeviceSceneMoment): void;
  dispose(): void;
}

/** The snapshot's size as a fraction of the drawing buffer: ~126 × 123
 *  for the card, ~4 KB as a JPEG; it is shown under an 8 px blur. */
const SNAPSHOT_DIVISOR = 4;

/** RGBA bytes → an opaque JPEG data URL. The WebGPU readback is top-down,
 *  and its rows may be padded to 256 bytes (a diagonal smear if read as
 *  tight rows): `unpadRows` takes the stride from the buffer's length. */
function encodeSnapshot(
  pixels: Uint8Array,
  width: number,
  height: number,
): string | null {
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (ctx === null) return null;
  const rgba = unpadRows(pixels, width, height);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return out.toDataURL("image/jpeg", 0.72);
}

// ── Baked material ──────────────────────────────────────────────────────────

/** The TSL node shapes this file passes around. three's typings tag nodes by
 *  GLSL type; a few proxies (normalMap, texture swizzles) come back untagged
 *  at the type level and are cast at the boundary — the runtime objects all
 *  carry the same method set. */
type Vec3Node = THREE.Node<"vec3">;
type FloatNode = THREE.Node<"float">;

/**
 * Three's lightMap hook expects irradiance. Cycles' colour-excluded diffuse
 * bake is unit-albedo reflected radiance, so E = π·L (Lambertian); the live
 * PBR BRDF then applies the receiver's albedo exactly once.
 */
class BakedStandardMaterial extends THREE.MeshStandardNodeMaterial {
  bakedIrradiance: Vec3Node | null = null;

  override setupLightMap(builder: THREE.NodeBuilder): THREE.Node {
    if (this.bakedIrradiance !== null) {
      return new THREE.IrradianceNode(this.bakedIrradiance);
    }
    return super.setupLightMap(builder);
  }
}

/** Scalar PBR maps need one byte per texel: keep the source channel exactly
 *  in an R8 texture rather than uploading RGBA. */
function scalarTexture(
  source: THREE.Texture,
  channel: number,
): THREE.DataTexture {
  const image = source.image as HTMLImageElement | ImageBitmap;
  const { width, height } = image;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("2d context unavailable");
  context.drawImage(image, 0, 0);
  const rgba = context.getImageData(0, 0, width, height).data;
  const red = new Uint8Array(width * height);
  for (let i = 0; i < red.length; i += 1) red[i] = rgba[i * 4 + channel] ?? 0;
  const result = new THREE.DataTexture(
    red,
    width,
    height,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  source.dispose();
  return result;
}

/** The per-frame knobs the baked shaders read. */
function makeUniforms() {
  return {
    ringColor: uniform(new THREE.Color()),
    ringStrength: uniform(0),
    weights: uniform(new THREE.Vector4(0, 1, 0, 0)),
    bounceStrength: uniform(0),
    roomStrength: uniform(0),
    lift: uniform(0),
    /** Contact-shadow strength (0 = none) and its centre, world metres. */
    contact: uniform(0),
    contactBase: uniform(new THREE.Vector3(0, 0, 0)),
    /** The weather's tint on the baked daylight bounce (§2.11). */
    daylightTint: uniform(new THREE.Color(1, 1, 1)),
  };
}
type BakeUniforms = ReturnType<typeof makeUniforms>;

/** Σ preset_i · weight_i over the three baked daylight presets. */
function daylightBounce(
  nodes: readonly Vec3Node[],
  weights: BakeUniforms["weights"],
): Vec3Node {
  let sum: Vec3Node = vec3(0);
  const lanes = ["x", "y", "z"] as const;
  nodes.forEach((node, i) => {
    const lane = lanes[i];
    if (lane === undefined) return;
    sum = sum.add(node.mul(weights[lane]));
  });
  return sum;
}

type DeviceTextures = Record<
  | "basecolor"
  | "normal"
  | "roughness"
  | "cavity"
  | "ring-diffuse"
  | "ring-channel"
  | "lamp-device"
  | "lamp-space"
  | "device-morning"
  | "device-midday"
  | "device-evening"
  | "space-morning"
  | "space-midday"
  | "space-evening",
  THREE.Texture
>;

const DEVICE_LDR = ["basecolor", "normal"] as const;
const DEVICE_SCALAR = ["roughness", "cavity"] as const;
const DEVICE_HDR = ["ring-diffuse", "ring-channel"] as const;
const SPACE_HDR = [
  "lamp-device",
  "lamp-space",
  "device-morning",
  "device-midday",
  "device-evening",
  "space-morning",
  "space-midday",
  "space-evening",
] as const;

function configureAtlas(tex: THREE.Texture, colorSpace: string): void {
  // EXR-derived atlases were baked bottom-up; the PNG-derived ones and the
  // glTF UVs use the opposite V convention. The shaders flip V for the HDR
  // reads (uv(1).flipY()); every atlas stays unflipped on upload.
  tex.flipY = false;
  tex.channel = 1;
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const compressed =
    (tex as { isCompressedTexture?: boolean }).isCompressedTexture === true;
  tex.generateMipmaps =
    !compressed && !(tex.mipmaps !== undefined && tex.mipmaps.length > 0);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
}

/** The satin-mineral refinement (device-surface.js, always on): patches and
 *  mesoscopic grain in physical units, anchored to the device through its
 *  lift, composed onto the baked normal with the surface-gradient bump. */
function refineDeviceSurface(
  mat: BakedStandardMaterial,
  baseRoughness: FloatNode,
  normalTexture: THREE.Texture,
  colorTexture: THREE.Texture,
  lift: BakeUniforms["lift"],
): void {
  const p = positionWorld.sub(vec3(0, lift, 0));
  const dx = dFdx(p);
  const dy = dFdy(p);
  const footprint2 = max(dot(dx, dx), dot(dy, dy));
  const broad = mx_noise_float(p.mul(68).add(vec3(1.4, 2.1, 4.7)));
  const meso = mx_noise_float(p.mul(210).add(vec3(3.2, 7.8, 1.6))).div(
    footprint2.mul(210 ** 2 * 4).add(1),
  );
  const polish = smoothstep(-0.38, 0.34, broad);
  const grain = smoothstep(-0.28, 0.34, meso);

  const albedo = texture(colorTexture, uv(1)).rgb;
  const tint = vec3(0.925, 0.932, 0.936)
    .add(polish.mul(0.05))
    .mul(meso.mul(0.06).add(1));
  mat.colorNode = albedo.mul(tint);
  mat.metalness = 0; // mineral ceramic is a dielectric

  const mapped = normalMap(
    texture(normalTexture, uv(1)),
  ) as unknown as Vec3Node;
  const height = meso.mul(0.00013).mul(polish.mul(-0.55).add(1));
  const dpdx = dFdx(positionView);
  const dpdy = dFdy(positionView);
  const r1 = cross(dpdy, mapped);
  const r2 = cross(mapped, dpdx);
  const det = dot(dpdx, r1).mul(faceDirection);
  const grad = r1
    .mul(dFdx(height))
    .add(r2.mul(dFdy(height)))
    .mul(det.sign());
  const perturbed = mapped.mul(det.abs().max(1e-12)).sub(grad).normalize();
  mat.normalNode = perturbed;

  const satin = mix(baseRoughness, 0.39, polish.mul(0.84));
  const refined = satin.add(grain.mul(-0.075).add(0.075)).clamp(0.38, 0.82);
  const ndx = dFdx(perturbed);
  const ndy = dFdy(perturbed);
  const variance = max(dot(ndx, ndx), dot(ndy, ndy));
  mat.roughnessNode = refined
    .mul(refined)
    .add(variance.mul(0.18).min(0.028))
    .min(1)
    .sqrt();
}

function copyMaterialBasics(
  from: THREE.MeshStandardMaterial,
  to: BakedStandardMaterial,
): void {
  to.name = from.name;
  to.color.copy(from.color);
  to.map = from.map;
  to.metalness = from.metalness;
  to.metalnessMap = from.metalnessMap;
  to.roughness = from.roughness;
  to.roughnessMap = from.roughnessMap;
  to.normalMap = from.normalMap;
  to.normalScale.copy(from.normalScale);
  to.aoMap = from.aoMap;
  to.aoMapIntensity = from.aoMapIntensity;
  to.emissive.copy(from.emissive);
  to.emissiveIntensity = from.emissiveIntensity;
  to.emissiveMap = from.emissiveMap;
  to.opacity = from.opacity;
  to.transparent = from.transparent;
  to.side = from.side;
  to.depthWrite = from.depthWrite;
  to.envMapIntensity = from.envMapIntensity;
}

function makeDeviceMaterial(
  source: THREE.MeshStandardMaterial,
  lampChannel: boolean,
  tex: DeviceTextures,
  u: BakeUniforms,
  dayNodes: readonly Vec3Node[],
): BakedStandardMaterial {
  const mat = new BakedStandardMaterial();
  copyMaterialBasics(source, mat);
  const isRing = source.name.startsWith("Indicator");
  if (isRing) return mat;
  const ceramic = source.name.startsWith("Ceramic");
  if (ceramic) {
    mat.map = tex.basecolor;
    mat.color.setRGB(1, 1, 1);
    mat.roughnessMap = null;
    mat.roughness = 1;
    mat.normalMap = tex.normal;
    mat.normalScale.set(1, 1);
    mat.metalness = 0.025;
  }
  // Cavity is deliberately weak; the baked GI already carries self-occlusion.
  mat.aoMap = tex.cavity;
  mat.aoMapIntensity = 0.28;
  const st = uv(1).flipY();
  // Daylight bounce: the three baked presets mixed by the hour weights.
  const bounce = daylightBounce(dayNodes, u.weights);
  const localRing = texture(
    tex[lampChannel ? "ring-channel" : "ring-diffuse"],
    lampChannel ? uv(2).flipY() : st,
  ).rgb;
  // The annulus keeps its seamless channel bake; larger surfaces interpolate
  // toward the room-inclusive lamp transport rather than adding it twice.
  const lamp = lampChannel
    ? localRing
    : mix(localRing, texture(tex["lamp-device"], st).rgb, u.roomStrength);
  const ring = lamp.mul(u.ringColor).mul(u.ringStrength);
  mat.bakedIrradiance = bounce
    .mul(u.bounceStrength)
    .mul(u.daylightTint)
    .add(ring)
    .mul(Math.PI);
  // Derivative-based roughness filtering softens unresolved normal highlights.
  const dx = dFdx(normalView);
  const dy = dFdy(normalView);
  const variance = max(dot(dx, dx), dot(dy, dy));
  const roughness: FloatNode = ceramic
    ? (texture(tex.roughness, uv(1)).r as unknown as FloatNode)
    : (materialRoughness as unknown as FloatNode);
  const filtered = roughness
    .mul(roughness)
    .add(variance.mul(0.14).min(0.035))
    .min(1)
    .sqrt();
  mat.roughnessNode = filtered;
  if (ceramic) {
    refineDeviceSurface(mat, filtered, tex.normal, tex.basecolor, u.lift);
  }
  return mat;
}

function makeSpaceMaterial(
  source: THREE.MeshStandardMaterial,
  objectName: string,
  tex: DeviceTextures,
  u: BakeUniforms,
): BakedStandardMaterial {
  const mat = new BakedStandardMaterial();
  mat.name = source.name;
  const surface =
    ROOM_SURFACES[
      objectName.includes("ground")
        ? "ground"
        : objectName.includes("back")
          ? "back"
          : "left"
    ];
  const [cr, cg, cb] = surface.color;
  // The colour rides the material's own uniform, not a literal: a literal
  // made three textually different shaders for the three walls, and each
  // costs DXC half a second (§2.12). Same code → one program.
  mat.color.setRGB(cr, cg, cb);
  mat.roughness = surface.roughness;
  mat.metalness = 0;
  // The contact shadow, in the room's own albedo: an ellipsoid of
  // occlusion around the device's base darkens the floor under it and the
  // wall behind it, and fades as the device lifts. In the material rather
  // than as an overlay — the transparent overlays tried first came
  // through this MSAA + MRT pass either near-invisible (canvas alpha) or
  // as a light rectangle (multiply blending), bisected live 2026-09-06.
  const q = positionWorld
    .sub(u.contactBase)
    .div(vec3(CONTACT_REACH.x, CONTACT_REACH.y, CONTACT_REACH.z));
  const occlusion = u.contact.mul(smoothstep(0, 1, dot(q, q)).oneMinus());
  mat.colorNode = (materialColor as unknown as Vec3Node).mul(
    occlusion.oneMinus(),
  );
  const st = uv(1).flipY();
  // The ring's light on the room, and the room's own daylight bounce —
  // both colour-excluded bakes, so the white surfaces above receive them
  // like any albedo would.
  const ring = texture(tex["lamp-space"], st)
    .rgb.mul(u.ringColor)
    .mul(u.ringStrength)
    .mul(u.roomStrength);
  const bounce = daylightBounce(
    (["space-morning", "space-midday", "space-evening"] as const).map(
      (name) => texture(tex[name], st).rgb as unknown as Vec3Node,
    ),
    u.weights,
  );
  mat.bakedIrradiance = bounce
    .mul(u.bounceStrength)
    .mul(u.daylightTint)
    .add(ring)
    .mul(Math.PI);
  return mat;
}

/**
 * The study's cloud field (weather-light.js): a transmission factor on the
 * key's incoming radiance, evaluated per receiver by projecting it along
 * the sun ray onto one virtual sky plane, so a cloud is continuous across
 * the walls, the floor and the moving device. Two low-frequency noise
 * octaves, filtered by pixel footprint (this camera sees the floor at a
 * grazing angle), averaged out over the distant ground extension. No
 * geometry, texture or pass; `depth` 0 skips the noise (the night).
 * AnalyticLightNode uses a custom colorNode verbatim, so the radiance
 * carries the light's linear colour times its intensity.
 */
function attachCloudField(light: THREE.DirectionalLight) {
  const radiance = uniform(new THREE.Color());
  const direction = uniform(new THREE.Vector3(0, 1, 0));
  const depth = uniform(0);
  const phase = uniform(0);
  const transmission = Fn(() => {
    const result = float(1).toVar();
    If(depth.greaterThan(0.0001), () => {
      const p = positionWorld.add(
        direction.mul(
          float(0.6).sub(positionWorld.y).div(direction.y.max(0.05)),
        ),
      );
      const q = p.mul(5.5).add(vec3(phase.mul(0.045), 0, phase.mul(0.019)));
      const dx = dFdx(q);
      const dy = dFdy(q);
      const width2 = dot(dx, dx).max(dot(dy, dy)).mul(12);
      const field = mx_noise_float(q)
        .mul(0.78)
        .div(width2.add(1))
        .add(
          mx_noise_float(q.mul(2.13).add(4.7))
            .mul(0.22)
            .div(width2.mul(2.13 ** 2).add(1)),
        );
      const distance2 = dot(positionWorld.xz, positionWorld.xz).div(0.35 ** 2);
      const localField = field.div(distance2.mul(distance2).add(1));
      const cover = smoothstep(-0.24, 0.24, localField);
      result.assign(float(1).sub(cover.mul(depth)));
    });
    return result;
  })();
  (light as THREE.DirectionalLight & { colorNode: unknown }).colorNode =
    radiance.mul(transmission);
  return {
    /** Per frame, after the light's colour, intensity and position are set. */
    update(cloudDepth: number, cloudPhase: number): void {
      radiance.value.copy(light.color).multiplyScalar(light.intensity);
      // Source and target share the scene's uniform scale; it cancels.
      direction.value
        .copy(light.position)
        .sub(light.target.position)
        .normalize();
      depth.value = cloudDepth;
      phase.value = cloudPhase;
    },
  };
}

// ── Scene ───────────────────────────────────────────────────────────────────

function renderPixelRatio(width: number, height: number, dpr: number): number {
  const desired = Math.max(1.5, dpr);
  return Math.max(
    1,
    Math.min(2, desired, MAX_LONG_EDGE_PX / Math.max(width, height, 1)),
  );
}

/** The contact shadow's strength at rest: how dark the floor and the wall
 *  get right at the device's base (the flat card's shadow layer peaks at
 *  0.72 × 0.85). Fades as the device lifts. */
const CONTACT_STRENGTH = 0.45;
/** Its reach from the base, metres: a little past the footprint sideways,
 *  a few centimetres up the wall behind, and a long way FORWARD along the
 *  floor — this camera looks along the floor at 2°, so a centimetre of
 *  floor in front of the device is a third of a pixel; 40 cm of reach
 *  reads as a soft band about a dozen pixels tall under the base
 *  (measured: a 1 m reach at full strength darkened the floor down to
 *  ~30 px below the base line, 2026-09-06). */
const CONTACT_REACH = new THREE.Vector3(0.11, 0.05, 0.4);
/** How far (design units) the key or the device moves before the shadow
 *  maps are re-rendered: about one texel of the key's 10-unit frustum at
 *  512², under a canvas pixel — the VSM edge is 6 texels soft. */
const SHADOW_MOVE_UNITS = 0.02;

/** The last resolved frame's render passes in submission order, ms each
 *  (profiling only). three keys each pass's query by `r:<call>:<ctx>:f<n>`. */
function gpuPassBreakdown(renderer: THREE.WebGPURenderer): number[] {
  const pool = (
    renderer.backend as {
      timestampQueryPool?: {
        render?: { timestamps: Map<string, number>; frames: number[] };
      };
    }
  ).timestampQueryPool?.render;
  if (pool === undefined) return [];
  const last = pool.frames[pool.frames.length - 1];
  if (last === undefined) return [];
  const passes: Array<[number, number]> = [];
  for (const [uid, ms] of pool.timestamps) {
    const m = /^r:(\d+):\d+:f(\d+)$/.exec(uid);
    if (m !== null && Number(m[2]) === last) {
      passes.push([Number(m[1]), Math.round(ms * 100) / 100]);
    }
  }
  return passes.sort((a, b) => a[0] - b[0]).map((p) => p[1]);
}

/** Resolves once the GPU has finished the submitted work (WebGPU's queue
 *  promise; capped at 5 s) and the compositor has presented a frame after
 *  it. The WebGL2 backend has no queue promise and gets the frame alone. */
async function firstFramePresented(
  renderer: THREE.WebGPURenderer,
): Promise<void> {
  const device = (
    renderer.backend as {
      device?: { queue: { onSubmittedWorkDone(): Promise<void> } };
    }
  ).device;
  if (device !== undefined) {
    await Promise.race([
      device.queue.onSubmittedWorkDone().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function disposeMaterial(mat: THREE.Material): void {
  for (const value of Object.values(mat)) {
    if ((value as { isTexture?: boolean } | null)?.isTexture === true) {
      (value as THREE.Texture).dispose();
    }
  }
  mat.dispose();
}

export async function createDeviceScene(
  opts: DeviceSceneOptions,
): Promise<DeviceSceneHandle> {
  const { canvas, assetUrl } = opts;
  const t0 = performance.now();

  const profile = opts.profile === true;
  const driven = opts.driven;
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    alpha: false,
    // A decoration must never wake a laptop's discrete GPU.
    powerPreference: "low-power",
    forceWebGL: opts.forceWebGL,
    trackTimestamp: profile,
    // A caller-made WebGL2 context (driven mode): the WebGL backend takes
    // `parameters.context` in place of creating its own. Not in the
    // typings, hence the cast.
    ...(driven?.context !== undefined ? { context: driven.context } : {}),
  } as ConstructorParameters<typeof THREE.WebGPURenderer>[0]);
  await renderer.init();
  if (profile) {
    // Profiling only: lets a devtools probe read the renderer's caches.
    Object.defineProperty(canvas, "__renderer", {
      value: renderer,
      configurable: true,
    });
  }
  const expose = (name: string, value: unknown): void => {
    if (profile)
      Object.defineProperty(canvas, name, { value, configurable: true });
  };
  const backend: DeviceSceneStats["backend"] =
    (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
      ? "webgpu"
      : "webgl2";
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;

  const scene = new THREE.Scene();
  scene.scale.setScalar(UNIT);
  const background = new THREE.Color("#ffffff");
  scene.background = background;
  // Real-card framing has a 35 cm vertical span; the camera sits back along
  // its ray so the near plane clears the floor. Orthographic distance changes
  // neither the device scale nor its perspective.
  const camera = new THREE.OrthographicCamera(
    -4 * UNIT,
    4 * UNIT,
    3 * UNIT,
    -3 * UNIT,
    0.1 * UNIT,
    480 * UNIT,
  );
  camera.position.set(58.5, 6.3, 110).multiplyScalar(UNIT);
  camera.lookAt(0, 1.9 * UNIT, 0);
  const assembly = new THREE.Group();
  scene.add(assembly);

  // A clean photographic light tent, prefiltered for roughness-dependent
  // reflections; its panels exist only for this capture.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const studio = new THREE.Scene();
  studio.background = new THREE.Color(0.32, 0.32, 0.32);
  const panel = (
    position: [number, number, number],
    w: number,
    h: number,
    power: number,
  ): void => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicNodeMaterial({
        color: new THREE.Color(power, power, power),
        side: THREE.DoubleSide,
      }),
    );
    mesh.position.fromArray(position);
    mesh.lookAt(0, 1.9, 0);
    studio.add(mesh);
  };
  panel([-4, 5.5, 6], 6, 5, 4.5);
  panel([1, 7, -1], 4, 3, 1.6);
  panel([6, 2, 1], 3, 5, 0.12);
  const environment = pmrem.fromScene(studio, 0.04, 0.1, 100);
  studio.traverse((obj) => {
    const m = obj as THREE.Mesh;
    m.geometry?.dispose();
    (m.material as THREE.Material | undefined)?.dispose();
  });
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.8;

  const key = new THREE.DirectionalLight("#ffe4bd", 2.8);
  key.castShadow = true;
  key.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  // The shadow camera is placed in WORLD space from the light's position,
  // so these extents are metres (UNIT × design units) around the target —
  // wide enough for the device's shadow on the back wall and the floor
  // behind it, from a front-left key.
  Object.assign(key.shadow.camera, {
    left: -5 * UNIT,
    right: 5 * UNIT,
    top: 6 * UNIT,
    bottom: -4 * UNIT,
    near: 0.1 * UNIT,
    far: 30 * UNIT,
  });
  key.shadow.bias = -0.00008;
  key.shadow.normalBias = 0.00012;
  key.shadow.autoUpdate = false;
  key.shadow.needsUpdate = true;
  key.shadow.radius = 6;
  key.shadow.blurSamples = 12;
  key.target.position.set(0, 1.8, 0);
  const clouds = attachCloudField(key);
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight("#c3e6ff", 0.9);
  fill.position.set(4, 3, 4);
  scene.add(fill);
  const rim = new THREE.DirectionalLight("#d9efff", 1.8);
  rim.position.set(2, 5, -4);
  scene.add(rim);
  const sky = new THREE.HemisphereLight("#d9edf7", "#7f8b91", 0.9);
  scene.add(sky);
  // The study's softbox was a 5×5 RectAreaLight (LTC). As a directional
  // light from the same place it reads the same on these satin surfaces,
  // and the scene pass lost a third of its cost on an iGPU (ADR 0057 §2.9).
  // Its strength rides lighting.ts's SOFTBOX_PER_KEY.
  const softbox = new THREE.DirectionalLight("#ffffff", 0);
  softbox.position.set(-3.5, 5.5, 6);
  softbox.target.position.set(0, 1.9, 0);
  scene.add(softbox, softbox.target);
  // The weak night outline: grazes the upper-right edge through the open
  // side, casting live shadows; fades out with daylight.
  const contour = new THREE.SpotLight("#b6cced", 0, 0.9, 0.65, 1, 2);
  contour.position.set(4.8, 5.4, 2.4);
  contour.target.position.set(0, 1.9, 0);
  contour.castShadow = true;
  contour.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  contour.shadow.camera.near = 0.01;
  contour.shadow.camera.far = 0.9;
  contour.shadow.bias = -0.001;
  contour.shadow.normalBias = 0.0005;
  contour.shadow.radius = 4;
  contour.shadow.blurSamples = 8;
  contour.shadow.autoUpdate = false;
  contour.shadow.needsUpdate = true;
  scene.add(contour, contour.target);

  // Post: 2× MSAA scene pass with an emissive MRT lane → bloom on the lamp
  // only → SMAA over the composed picture (an opaque canvas: the room is
  // the card's content, so SMAA's alpha handling is moot here). The study
  // ran 4×; on an Intel iGPU that pass cost 9 ms a frame against 5.7 at 2×
  // with no difference SMAA did not cover (ADR 0057 §2.9). The emissive
  // lane is free: measured within noise of a single attachment.
  const scenePass = pass(scene, camera, { samples: SCENE_MSAA_SAMPLES });
  scenePass.setMRT(mrt({ output, emissive }));
  const graph = new THREE.RenderPipeline(renderer);
  const sceneColor = scenePass.getTextureNode("output");
  const bloomNode = bloom(
    scenePass.getTextureNode("emissive"),
    0.075,
    0.32,
    1.6,
  );
  const smaaNode = smaa(sceneColor.add(bloomNode));
  graph.outputNode = smaaNode;
  expose("__scenePass", scenePass);

  // ── assets ──
  const u = makeUniforms();
  const ktx = new KTX2Loader()
    .setTranscoderPath(assetUrl("basis/"))
    .setWorkerLimit(2)
    .detectSupport(renderer);
  const png = new THREE.TextureLoader();
  const loadKtx = async (
    file: string,
    colorSpace: string,
  ): Promise<THREE.Texture> => {
    const tex = await ktx.loadAsync(assetUrl(file));
    configureAtlas(tex, colorSpace);
    return tex;
  };
  const loadScalar = async (
    file: string,
    channel: number,
  ): Promise<THREE.Texture> => {
    const tex = scalarTexture(await png.loadAsync(assetUrl(file)), channel);
    configureAtlas(tex, THREE.NoColorSpace);
    return tex;
  };
  const tex = {} as DeviceTextures;
  await Promise.all([
    ...DEVICE_LDR.map(async (name) => {
      tex[name] = await loadKtx(
        `baked-v1-${name}.ktx2`,
        name === "basecolor" ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      );
    }),
    ...DEVICE_SCALAR.map(async (name) => {
      // Roughness lives in the source's green channel, cavity in red.
      tex[name] = await loadScalar(
        `baked-v1-${name}.png`,
        name === "roughness" ? 1 : 0,
      );
    }),
    ...DEVICE_HDR.map(async (name) => {
      tex[name] = await loadKtx(
        `baked-v1-${name}.ktx2`,
        THREE.LinearSRGBColorSpace,
      );
    }),
    ...SPACE_HDR.map(async (name) => {
      tex[name] = await loadKtx(
        `space-v1-${name}.ktx2`,
        THREE.LinearSRGBColorSpace,
      );
    }),
  ]);
  ktx.dispose();
  const dayNodes: Vec3Node[] = (
    ["device-morning", "device-midday", "device-evening"] as const
  ).map((name) => texture(tex[name], uv(1).flipY()).rgb as unknown as Vec3Node);

  const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const device = await gltfLoader.loadAsync(assetUrl("device.glb"));
  const ringMaterials: BakedStandardMaterial[] = [];
  /** The meshes wearing the indicator (the art export measures the LED's
   *  place from them, §2.14). */
  const ringMeshes: THREE.Mesh[] = [];
  device.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (mesh.geometry.attributes.uv1 === undefined) {
      throw new Error(`missing bake UV on ${mesh.name}`);
    }
    // The source tangents describe the material UV; the baked normals use
    // the bake UV, so the frame is rebuilt from that channel instead.
    mesh.geometry.deleteAttribute("tangent");
    const lampChannel = mesh.geometry.attributes.uv2 !== undefined;
    const sources = (
      Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    ) as THREE.MeshStandardMaterial[];
    const materials = sources.map((m) =>
      makeDeviceMaterial(m, lampChannel, tex, u, dayNodes),
    );
    mesh.material = Array.isArray(mesh.material)
      ? materials
      : (materials[0] as THREE.Material);
    for (const m of materials) {
      if (m.name.startsWith("Indicator")) ringMaterials.push(m);
    }
    if (materials.some((m) => m.name.startsWith("Indicator"))) {
      ringMeshes.push(mesh);
    }
  });
  device.scene.scale.setScalar(1 / UNIT);
  assembly.add(device.scene);
  expose("__view", { camera, device: device.scene });

  const space = await gltfLoader.loadAsync(assetUrl("alcove.glb"));
  const alcove = space.scene;
  alcove.scale.setScalar(1 / UNIT);
  alcove.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry.attributes.uv1 === undefined) {
      throw new Error("missing alcove bake UV");
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.material = makeSpaceMaterial(
      mesh.material as THREE.MeshStandardMaterial,
      mesh.name,
      tex,
      u,
    );
  });
  scene.add(alcove);
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3()
    .setFromObject(device.scene)
    .getSize(new THREE.Vector3());
  camera.updateMatrixWorld();
  const basis = camera.matrixWorldInverse.elements;
  const projectedDeviceHeight =
    bounds.x * Math.abs(basis[1] ?? 0) +
    bounds.y * Math.abs(basis[5] ?? 0) +
    bounds.z * Math.abs(basis[9] ?? 0);
  const loadMs = performance.now() - t0;

  // ── live state ──
  let inputs = opts.initial;
  let disposed = false;
  let ready = false;
  let raf: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastTime = 0;
  let activeUntil = 0;
  let focused = document.hasFocus();
  let unfocusedSince = 0;
  let stateEntered = performance.now();
  let stageWidth = 0;
  let stageHeight = 0;
  let liveHour = cardHourFor(inputs.theme, new Date());
  let liveIntensity = STATE_TARGETS[inputs.state].intensity;
  const liveColor = new THREE.Color(STATE_TARGETS[inputs.state].color);
  const targetColor = new THREE.Color(STATE_TARGETS[inputs.state].color);
  const pose = createLiftPose();
  let shadowStamp: number[] = [];
  const shadowDirty = { key: true, contour: true };
  /** What the last drawn frame showed (the render gate's memory). */
  let shown: ShownPicture | null = null;
  /** The cloud drift, seconds of daylight motion so far. */
  let cloudPhase = 0;
  // Once-a-second diagnostics on the canvas dataset (a DOM write per
  // second, never per frame): fps, mean CPU submit ms, draw calls, and with
  // `profile` the GPU time of the last resolved frame.
  let statFrames = 0;
  let statSubmit = 0;
  let statSince = performance.now();
  let gpuPending = false;
  let gpuUnresolved = 0;
  const report = (now: number, renderMs: number): void => {
    statFrames += 1;
    statSubmit += renderMs;
    gpuUnresolved += 1;
    const elapsed = now - statSince;
    const tick = elapsed >= 1000;
    if (tick) {
      canvas.dataset.fps = ((statFrames * 1000) / elapsed).toFixed(1);
      canvas.dataset.submitMs = (statSubmit / statFrames).toFixed(2);
      canvas.dataset.draws = String(renderer.info.render.drawCalls);
      canvas.dataset.tris = String(renderer.info.render.triangles);
      statFrames = 0;
      statSubmit = 0;
      statSince = now;
    }
    // The query pool holds ~50 frames of passes: resolve well before that.
    if (profile && !gpuPending && (tick || gpuUnresolved >= 16)) {
      gpuPending = true;
      gpuUnresolved = 0;
      renderer
        .resolveTimestampsAsync(THREE.TimestampQuery.RENDER)
        .then((ms) => {
          if (!tick) return;
          if (ms !== undefined && ms > 0) canvas.dataset.gpuMs = ms.toFixed(2);
          canvas.dataset.gpuPasses = JSON.stringify(gpuPassBreakdown(renderer));
        })
        .catch(() => undefined)
        .finally(() => {
          gpuPending = false;
        });
    }
  };

  const stopLoop = (): void => {
    if (raf !== null) cancelAnimationFrame(raf);
    if (timer !== null) clearTimeout(timer);
    raf = null;
    timer = null;
  };
  /** The art export (§2.14) owns the scene while it renders offscreen. */
  let exporting = false;
  const mayRun = (): boolean =>
    driven === undefined &&
    !disposed &&
    ready &&
    !inputs.paused &&
    !document.hidden &&
    !exporting;
  const schedule = (delay = 0): void => {
    if (raf !== null || timer !== null || !mayRun()) return;
    if (delay > 1) {
      timer = setTimeout(() => {
        timer = null;
        raf = requestAnimationFrame(frame);
      }, delay);
    } else {
      raf = requestAnimationFrame(frame);
    }
  };
  const wake = (duration = 0): void => {
    activeUntil = Math.max(activeUntil, performance.now() + duration);
    if (raf === null && timer === null) {
      lastTime = performance.now() - 16;
      schedule();
    }
  };

  /** Frame the device to the flat card's visible silhouette height in a
   *  box of this size (CSS px), not to the whole box. */
  const frameCamera = (boxWidth: number, boxHeight: number): void => {
    const span = (projectedDeviceHeight * boxHeight) / DEVICE_HEIGHT_PX;
    camera.left = (-span * boxWidth) / boxHeight / 2;
    camera.right = (span * boxWidth) / boxHeight / 2;
    camera.top = span / 2;
    camera.bottom = -span / 2;
    camera.updateProjectionMatrix();
  };
  const resize = (): void => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    stageWidth = width;
    stageHeight = height;
    frameCamera(stageWidth, stageHeight);
    const ratio = renderPixelRatio(
      stageWidth,
      stageHeight,
      driven?.pixelRatio ?? window.devicePixelRatio ?? 1,
    );
    if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
    renderer.setSize(stageWidth, stageHeight, false);
    wake(500);
  };

  // The recipe onto the scene, in the three parts the art export (§2.14)
  // also drives: the lights, the indicator, and the bake weights.
  /** The lighting onto the lights, the background and the exposure. */
  const applyLighting = (light: WeatheredLighting, phase: number): void => {
    background
      .set(light.background)
      .multiplyScalar(light.external * light.backgroundScale);
    key.color.set(light.keyColor);
    key.intensity = light.key;
    key.position.fromArray(light.position as unknown as number[]);
    clouds.update(light.cloudDepth, phase);
    fill.intensity = light.fill;
    rim.intensity = light.rim;
    sky.intensity = light.sky;
    softbox.intensity = light.softbox;
    softbox.color.copy(key.color);
    contour.intensity = light.contour;
    scene.environmentIntensity = light.environment;
    renderer.toneMappingExposure = light.exposure;
    scene.environmentRotation.y = light.rotation;
  };
  /** The indicator: the annulus's own emission and albedo, and the baked
   *  lamp transport onto the device and the room. */
  const applyRing = (color: THREE.Color, intensity: number): void => {
    for (const mat of ringMaterials) {
      mat.emissive.copy(color);
      mat.emissiveIntensity = intensity;
      mat.color.copy(color);
    }
    u.ringColor.value.copy(color);
    u.ringStrength.value = intensity;
  };
  /** Bake weights: daylight bounce by hour and weather, faded as the
   *  device leaves its baked pose. The contact shadow stays on the floor
   *  and fades as the device rises (gone by the 12 px ceiling), and goes
   *  with the daylight at night. */
  const applyBake = (
    hour: number,
    light: WeatheredLighting,
    lift: number,
    liftPx: number,
  ): void => {
    u.contact.value =
      CONTACT_STRENGTH * Math.max(0, 1 - liftPx / 12) * light.external;
    u.lift.value = lift * UNIT;
    u.weights.value.fromArray(timeWeights(hour));
    const poseValidity = Math.exp(-10 * Math.max(lift, 0));
    u.bounceStrength.value = poseValidity * light.external * light.bounce;
    u.daylightTint.value.setRGB(
      1 - 0.16 * light.cool,
      1 - 0.055 * light.cool,
      1,
    );
    u.roomStrength.value = poseValidity;
  };

  const frame = (now: number): void => {
    raf = null;
    if (!mayRun()) return;
    if (
      !focused &&
      now - unfocusedSince > PARK_UNFOCUSED_MS &&
      now > activeUntil
    ) {
      return;
    }
    const dt = Math.min((now - (lastTime || now)) / 1000, 0.05);
    lastTime = now;
    const ease = 1 - Math.exp(-dt * 5.5);

    // The clock, folded per theme; eased so a theme flip passes through
    // dusk and a minute's drift is invisible.
    const hourDiff = hourDelta(liveHour, cardHourFor(inputs.theme, new Date()));
    liveHour = (((liveHour + hourDiff * ease) % 24) + 24) % 24;
    const motion = !inputs.reducedMotion;
    // The weather (§2.11): clouds drift while there is daylight and motion
    // is allowed; frozen clouds are still clouds under reduced motion.
    const light = applyCloudy(lightingAt(liveHour), cloudPhase);
    if (motion && light.cloudDepth > 0 && light.external > 0.001) {
      cloudPhase += dt;
    }
    applyLighting(light, cloudPhase);

    const target = STATE_TARGETS[inputs.state];
    liveColor.lerp(targetColor, ease);
    liveIntensity = THREE.MathUtils.lerp(liveIntensity, target.intensity, ease);
    const seconds = (now - stateEntered) / 1000;
    const breath = motion
      ? 1 + Math.sin((now / 1000) * target.hz * Math.PI * 2) * target.depth
      : 1;
    let flash = 0;
    if (motion && inputs.state === "succeeded") {
      flash =
        Math.max(0, 1 - seconds / 1.5) * Math.min(seconds / 0.15, 1) * 1.5;
    }
    if (motion && inputs.state === "failed") {
      flash =
        Math.max(
          0,
          1 - Math.abs(seconds - 0.12) / 0.12,
          1 - Math.abs(seconds - 0.45) / 0.12,
        ) * 1.3;
    }
    const ringIntensity = liveIntensity * breath + flash;

    const held = inputs.liftPx > 0;
    const liftMoving = advanceLift(pose, dt, held);
    // Lift is measured in CSS px like the flat card, independent of DPR.
    const lift =
      (pose.liftPx * (camera.top - camera.bottom)) /
      (Math.max(1, stageHeight) * UNIT);
    // A flash is motion too: it draws at the moving rate for its half
    // second, not at the calm one.
    const moving = held || liftMoving || now < activeUntil || flash > 0;

    // The gate (§2.10): the state above advances every tick; the GPU is
    // asked only when the picture would change. At idle that is a third
    // of the ticks.
    const next: ShownPicture = {
      ring: ringIntensity,
      color: [liveColor.r, liveColor.g, liveColor.b],
      hour: liveHour,
      lift,
      cloud: light.cloudDepth > 0 ? cloudPhase : 0,
    };
    let renderMs = 0;
    if (moving || pictureChanged(shown, next)) {
      applyRing(liveColor, ringIntensity);
      (bloomNode.strength as { value: number }).value =
        (0.065 + light.night * 0.1) / Math.sqrt(light.adaptation);
      assembly.position.y = lift;
      applyBake(liveHour, light, lift, pose.liftPx);

      // Pulsing the indicator does not move the silhouette: shadow maps
      // are reused until the key or the device has moved by about a
      // shadow texel. (The clock drifts the key every frame; a finer
      // threshold re-rendered the shadow — three passes at 1024² — on
      // most frames of the day.)
      const nextStamp = [
        key.position.x,
        key.position.y,
        key.position.z,
        assembly.position.y,
      ];
      const changed = nextStamp.map(
        (v, i) =>
          Math.abs(v - (shadowStamp[i] ?? Number.POSITIVE_INFINITY)) >
          SHADOW_MOVE_UNITS,
      );
      if (changed.some(Boolean)) {
        shadowDirty.key = true;
        if (changed[3] === true) shadowDirty.contour = true;
        shadowStamp = nextStamp;
      }
      for (const [name, l] of [
        ["key", key],
        ["contour", contour],
      ] as const) {
        const explicit = l.shadow.needsUpdate;
        if (explicit) shadowDirty[name] = true;
        l.shadow.needsUpdate =
          shadowDirty[name] && (l.intensity > 0 || explicit);
        if (l.shadow.needsUpdate) shadowDirty[name] = false;
      }

      const renderStart = performance.now();
      graph.render();
      renderMs = performance.now() - renderStart;
      report(now, renderMs);
      shown = next;
    }

    if (motion || moving || Math.abs(hourDiff) > 0.005) {
      const fps = moving ? MOVING_FPS : CALM_FPS;
      schedule(Math.max(0, 1000 / fps - renderMs - 2));
    }
  };

  // ── wiring ──
  const onFocus = (): void => {
    focused = true;
    wake(500);
  };
  const onBlur = (): void => {
    focused = false;
    unfocusedSince = performance.now();
  };
  const onVisibility = (): void => {
    if (document.hidden) stopLoop();
    else wake(500);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);
  const clockTimer = setInterval(() => {
    if (inputs.theme === "light") wake(1100);
  }, CLOCK_WAKE_MS);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stopLoop();
    clearInterval(clockTimer);
    observer.disconnect();
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
    canvas.removeEventListener("webglcontextlost", onContextLost);
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose();
      const mats = mesh.material;
      if (mats !== undefined) {
        for (const m of Array.isArray(mats) ? mats : [mats]) disposeMaterial(m);
      }
    });
    for (const t of Object.values(tex)) t.dispose();
    scenePass.dispose();
    bloomNode.dispose();
    smaaNode.dispose();
    environment.dispose();
    pmrem.dispose();
    graph.dispose();
    renderer.dispose();
  };
  const fallback = (reason: string): void => {
    if (disposed) return;
    dispose();
    opts.onFallback(reason);
  };
  const onContextLost = (event: Event): void => {
    event.preventDefault();
    fallback("context lost");
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  renderer.onDeviceLost = (info) => {
    fallback(`device lost: ${info.reason ?? "unknown"}`);
  };

  // The scene's pipelines are compiled ASYNCHRONOUSLY before the first
  // frame (ADR 0057 §2.12). A synchronous createRenderPipeline is
  // compiled on the GPU process's main thread — the thread that also
  // presents every window frame — and each of these material shaders
  // takes DXC about a second on an Intel laptop: the traced boot showed
  // 1–2.6 s freezes of the WHOLE app, one per material, for eight seconds
  // after the first frame (the owner's "first click lags"). The async
  // variant compiles on Dawn's worker threads. PassNode.setup() would set
  // the target's sample count later; it is set here first so the async
  // pipelines carry the pass's own render state and the first frame finds
  // them in the cache. The shadow and post pipelines are small shaders
  // and stay on the synchronous first frame.
  resize();
  scenePass.renderTarget.samples = SCENE_MSAA_SAMPLES;
  const tCompile = performance.now();
  await scenePass.compileAsync(renderer);
  const compileMs = performance.now() - tCompile;
  if (disposed) throw new Error("disposed during compile");
  if (opts.awaitQuiet !== undefined) await opts.awaitQuiet();
  if (disposed) throw new Error("disposed while waiting");
  const t1 = performance.now();
  graph.render();
  const firstFrameMs = performance.now() - t1;
  // "Live" means the first frame is ON SCREEN, not merely submitted: the
  // GPU still compiles the last synchronous pipeline (~1 s, §2.12) after
  // this returns, and while it does the compositor presents nothing —
  // CSS transitions started meanwhile freeze and then skip to their end
  // (the focus cross-fade of §2.13 "suddenly changed"). So wait for the
  // queue to drain and for one presented frame before reporting.
  const tPresent = performance.now();
  await firstFramePresented(renderer);
  const presentMs = performance.now() - tPresent;
  if (disposed) throw new Error("disposed while presenting");
  ready = true;
  wake(1400);

  if (profile) {
    // The flat art's export (§2.14), profiling only: a script drives it
    // over CDP through `canvas.__export`; the module loads on demand.
    void import("./art-export.js").then(({ createArtExport }) => {
      if (disposed) return;
      expose(
        "__export",
        createArtExport({
          renderer,
          scene,
          camera,
          device: device.scene,
          room: alcove,
          ringMeshes,
          ringMaterials,
          shadowLights: [key, contour],
          contact: u.contact,
          frameFlatBox: () =>
            frameCamera(FLAT_BOX_CSS.width, FLAT_BOX_CSS.height),
          frameCardBox: () => {
            frameCamera(CARD_BOX_CSS.width, CARD_BOX_CSS.height);
            return CARD_BOX_CSS;
          },
          applyLighting,
          applyRing,
          applyBake,
          begin: () => {
            exporting = true;
            stopLoop();
          },
          end: () => {
            exporting = false;
            assembly.position.y = 0;
            key.shadow.needsUpdate = true;
            contour.shadow.needsUpdate = true;
            resize();
            wake(1000);
          },
        }),
      );
    });
  }

  const snapshot = async (): Promise<string | null> => {
    if (disposed || !ready || stageWidth === 0) return null;
    const ratio = renderer.getPixelRatio();
    const width = Math.max(
      1,
      Math.round((stageWidth * ratio) / SNAPSHOT_DIVISOR),
    );
    const height = Math.max(
      1,
      Math.round((stageHeight * ratio) / SNAPSHOT_DIVISOR),
    );
    const target = new THREE.RenderTarget(width, height, {
      depthBuffer: false,
    });
    try {
      // The post graph renders wherever the renderer's target points; the
      // pass nodes restore it after their own targets. One extra frame.
      renderer.setRenderTarget(target);
      graph.render();
      renderer.setRenderTarget(null);
      const pixels = await renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        width,
        height,
      );
      if (disposed) return null;
      return encodeSnapshot(
        pixels instanceof Uint8Array
          ? pixels
          : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
        width,
        height,
      );
    } catch {
      return null;
    } finally {
      renderer.setRenderTarget(null);
      target.dispose();
    }
  };

  /** Driven mode: the moment onto the scene and one render. The same
   *  three applications the loop makes — lighting, indicator, bake — from
   *  the moment's hour and seconds instead of the clock, the breath at
   *  its resting colour with no easing to catch up, the shadows always
   *  re-rendered (the key moves every frame here, and a still has no
   *  budget to keep). */
  const renderAt = (moment: DeviceSceneMoment): void => {
    if (disposed || !ready) return;
    liveHour = ((moment.hour % 24) + 24) % 24;
    const light = applyCloudy(lightingAt(liveHour), moment.seconds);
    applyLighting(light, moment.seconds);
    const target = STATE_TARGETS[inputs.state];
    liveColor.set(target.color);
    const breath =
      1 + Math.sin(moment.seconds * target.hz * Math.PI * 2) * target.depth;
    applyRing(liveColor, target.intensity * breath);
    (bloomNode.strength as { value: number }).value =
      (0.065 + light.night * 0.1) / Math.sqrt(light.adaptation);
    const liftPx = moment.liftPx ?? 0;
    const lift =
      (liftPx * (camera.top - camera.bottom)) /
      (Math.max(1, stageHeight) * UNIT);
    assembly.position.y = lift;
    applyBake(liveHour, light, lift, liftPx);
    key.shadow.needsUpdate = true;
    contour.shadow.needsUpdate = contour.intensity > 0;
    graph.render();
  };

  return {
    stats: { backend, loadMs, compileMs, firstFrameMs, presentMs },
    snapshot,
    renderAt,
    update(next) {
      const prev = inputs;
      inputs = next;
      if (next.state !== prev.state) {
        stateEntered = performance.now();
        targetColor.set(STATE_TARGETS[next.state].color);
        wake(1800);
      }
      if (next.theme !== prev.theme) wake(1100);
      if (next.liftPx !== prev.liftPx) {
        pose.targetLiftPx = next.liftPx;
        wake(400);
      }
      if (next.reducedMotion !== prev.reducedMotion) wake(700);
      if (next.paused !== prev.paused) {
        if (next.paused) stopLoop();
        else wake(500);
      }
    },
    dispose,
  };
}
