import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

import { THEMES, THEME_LIST, DEFAULT_THEME, themeValues } from './themes/index.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BBOX = { minLat: 40.700, maxLat: 40.762, minLon: -74.019, maxLon: -73.968 };
const CENTER_LON = (BBOX.minLon + BBOX.maxLon) / 2;
const CENTER_LAT = (BBOX.minLat + BBOX.maxLat) / 2;

// Shown top-right. Kept next to the BBOX deliberately: move the bbox and you're
// looking straight at the label that has to move with it. The coordinates below
// are derived from the bbox, so those can't fall out of sync on their own.
const LOCATION = { name: 'Manhattan', region: 'New York City' };

// Scene units: 1 unit = 10 metres. Keeps the whole borough inside a few
// hundred units so the camera/shadow/bloom ranges stay well conditioned.
const UNITS_PER_METRE = 0.1;
const METRES_PER_DEG_LAT = 111320;

// The buildings are one merged mesh and one draw call, so the cap buys almost
// nothing at runtime — it is a guard on load time and memory, not on frame rate.
// At 9,000 it was clipping more than half of Manhattan's footprints (the bbox
// yields ~19,000) purely as a leftover from when each building was its own mesh
// and its own texture. The stats panel says "N of M" when it bites, so you can see
// when it does.
const MAX_BUILDINGS = 24000;

// The main thread sits ~87% idle and the frame is capped by vsync, not by the
// simulation, so the traffic can afford to be much denser than this was.
const TAXI_COUNT = 1600;

// Seconds for a road's glow to fade by half. Short leaves a clipped comet behind
// each taxi; long lets the arterials stay lit end to end, so the picture reads as
// accumulated flow rather than individual cars.
const TRAIL_DECAY = { short: 1.1, long: 5.0 };

const SKIPPED_HIGHWAYS = new Set([
  'footway', 'path', 'cycleway', 'steps', 'pedestrian',
  'track', 'corridor', 'bridleway', 'proposed', 'construction',
]);

// ---------------------------------------------------------------------------
// Renderer, scene, camera
// ---------------------------------------------------------------------------

const app = document.querySelector('#app');
const loadingIndicator = document.querySelector('#loading-indicator');
const loadingLabel = document.querySelector('[data-loading-label]');
const loadingBar = document.querySelector('[data-loading-bar]');

const scene = new THREE.Scene();
scene.background = new THREE.Color('#04050a');
scene.fog = new THREE.FogExp2('#04050a', 0.0011);

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 1, 4000);
camera.position.set(-130, 88, 175);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
app.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 40;
controls.maxDistance = 1200;
controls.maxPolarAngle = Math.PI / 2.05;
controls.target.set(-10, 0, 15);

// Where the camera was pointed when the page opened. Captured before anything can
// move it, so "Reset view" has a home to return to that isn't just the origin.
const HOME_VIEW = {
  position: camera.position.clone(),
  target: controls.target.clone(),
};

// Camera state, kept apart from `settings` on purpose. `settings` is owned by the
// theme — its reset snaps the palette back to the theme's baseline, and a camera
// speed has no business being dragged along with a change of colour.
const view = {
  dragMode: 'orbit',
  orbitSpeed: 1.0,
  panSpeed: 1.0,
  zoomSpeed: 1.0,
  damping: 0.06,
  autoOrbit: false,
  autoOrbitSpeed: 0.35,
};

// What the left button does in each mode. The right button always picks up whichever
// of orbit/pan the left one just gave away, so choosing a mode can never strand you
// with no way to turn the city — that's the failure that makes mode selectors feel
// like a trap rather than a convenience.
const DRAG_MODES = {
  orbit: { left: THREE.MOUSE.ROTATE, right: THREE.MOUSE.PAN, touch: THREE.TOUCH.ROTATE },
  pan: { left: THREE.MOUSE.PAN, right: THREE.MOUSE.ROTATE, touch: THREE.TOUCH.PAN },
  zoom: { left: THREE.MOUSE.DOLLY, right: THREE.MOUSE.ROTATE, touch: THREE.TOUCH.ROTATE },
};

const DRAG_HINTS = {
  orbit: 'Right-drag pans. Scroll zooms.',
  pan: 'Right-drag orbits. Scroll zooms.',
  zoom: 'Right-drag orbits. Scroll zooms.',
};

function applyView(key, value) {
  view[key] = value;

  switch (key) {
    case 'dragMode': {
      const mode = DRAG_MODES[value] ?? DRAG_MODES.orbit;
      controls.mouseButtons.LEFT = mode.left;
      controls.mouseButtons.RIGHT = mode.right;
      // One finger mirrors the left button. Two fingers stay on dolly+pan whatever the
      // mode is, because that's the gesture people already have in their hands.
      controls.touches.ONE = mode.touch;
      break;
    }
    case 'orbitSpeed':
      controls.rotateSpeed = value;
      break;
    case 'panSpeed':
      controls.panSpeed = value;
      break;
    case 'zoomSpeed':
      controls.zoomSpeed = value;
      break;
    case 'damping':
      // Zero would leave enableDamping on with no damping, which reads as a stutter
      // rather than as "off" — so turn the feature off instead.
      controls.enableDamping = value > 0.001;
      controls.dampingFactor = Math.max(0.001, value);
      break;
    case 'autoOrbit':
      controls.autoRotate = value;
      break;
    case 'autoOrbitSpeed':
      controls.autoRotateSpeed = value;
      break;
    default:
      break;
  }
}

function resetView() {
  camera.position.copy(HOME_VIEW.position);
  controls.target.copy(HOME_VIEW.target);
  controls.update();
}

// Live-adjustable look. Everything the panel touches lives here so there is one
// place to read the current state from, and one place to persist it.
// Structural toggles live outside the theme bundles on purpose: switching palette
// should not silently turn your buildings or lights back on.
const settings = {
  theme: DEFAULT_THEME.id,
  buildingsVisible: true,
  buildingOpacity: 1.0,
  buildingRoughness: 0.72,
  buildingGrain: 0.35,
  buildingVariation: 0.35,
  reflectTrails: true,
  showEdges: true,
  depthOfField: true,
  dofStrength: 0.45,
  // Read fresh every frame by decayHeat, so there is nothing to apply on change.
  trailDecay: 'long',
  trailOpacity: 0.82,
  ...themeValues(DEFAULT_THEME),
};

// EffectComposer's default render target has no multisampling, which silently
// throws away the renderer's `antialias: true` the moment you post-process —
// every road line and building edge comes back stair-stepped. Hand it a 4x MSAA
// target so the lines resolve clean.
const drawSize = renderer.getDrawingBufferSize(new THREE.Vector2());
const renderTarget = new THREE.WebGLRenderTarget(drawSize.x, drawSize.y, {
  type: THREE.HalfFloatType,
  samples: 4,
});

const composer = new EffectComposer(renderer, renderTarget);
composer.addPass(new RenderPass(scene, camera));

// Depth of field. The focus plane is not a setting — it is pinned every frame to
// whatever the camera is orbiting (see animate), so the block you are looking at
// is always the sharp one and the city falls off behind it. A fixed focus
// distance would go out of focus the moment you zoomed.
//
// `aperture` is how fast blur builds with distance from that plane, `maxblur` is
// the ceiling in UV — the cap is what keeps a wide shot from dissolving into
// soup, since half of Manhattan is thousands of units past the focus plane. Blur
// is symmetric about the plane, so foreground towers soften too, which is what
// makes it read as a lens rather than as haze.
const DOF_MAX_APERTURE = 5e-5;
const DOF_MAX_BLUR = 0.008;

const bokeh = new BokehPass(scene, camera, {
  focus: 200,
  aperture: settings.dofStrength * DOF_MAX_APERTURE,
  maxblur: DOF_MAX_BLUR,
});
composer.addPass(bokeh);

// It runs before the bloom on purpose: bloom applied to a defocused frame spreads
// the glow of an out-of-focus light the way a real lens does. The other way round,
// the bloom's sharp highlights would survive the blur and the trails would come
// back crisp over a soft city.
//
// Disabled means EffectComposer skips the pass entirely, so switching it off costs
// nothing — worth having, because the pass re-renders the scene once for depth.
function applyDepthOfField() {
  bokeh.enabled = settings.depthOfField;
  bokeh.uniforms.aperture.value = settings.dofStrength * DOF_MAX_APERTURE;
}

applyDepthOfField();

const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  settings.bloom, // strength
  0.30, // radius — keep it tight, a wide radius smears 25k lines into milk
  0.45, // threshold — the cold baseline road must fall *below* this, so only
        //             lanes with traffic on them actually glow
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// Contrast runs *after* OutputPass, so it works on final display-referred sRGB
// rather than on linear light — pivoting around 0.5 in linear space would crush
// the mid-tones and turn the whole city to mud.
const contrastPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    contrast: { value: settings.contrast },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float contrast;
    varying vec2 vUv;
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 color = (texel.rgb - 0.5) * contrast + 0.5;
      gl_FragColor = vec4(clamp(color, 0.0, 1.0), texel.a);
    }
  `,
});
composer.addPass(contrastPass);

// ---------------------------------------------------------------------------
// Environment: a dark sky with a warm sodium-vapour haze at the horizon. This
// is what the building glass actually reflects, so it does most of the work of
// the look — the lights below only shape the silhouettes.
// ---------------------------------------------------------------------------

function buildEnvironment(hex) {
  const tint = new THREE.Color(hex);
  const rgb = (scale, alpha) => {
    const r = Math.round(tint.r * 255 * scale);
    const g = Math.round(tint.g * 255 * scale);
    const b = Math.round(tint.b * 255 * scale);
    return alpha === undefined ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');

  const sky = ctx.createLinearGradient(0, 0, 0, 512);
  sky.addColorStop(0.00, '#05070d');
  sky.addColorStop(0.42, '#0a0d16');
  sky.addColorStop(0.50, rgb(0.16));
  sky.addColorStop(0.56, rgb(0.28));
  sky.addColorStop(0.70, rgb(0.07));
  sky.addColorStop(1.00, '#07080c');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 1024, 512);

  // A few hot pools along the horizon so reflections have some variation
  // instead of one perfectly even band.
  for (let i = 0; i < 6; i += 1) {
    const x = (i + 0.5) * (1024 / 6) + (Math.random() - 0.5) * 90;
    const glow = ctx.createRadialGradient(x, 268, 0, x, 268, 150);
    glow.addColorStop(0, rgb(1, 0.55));
    glow.addColorStop(1, rgb(1, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(x - 150, 118, 300, 300);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromEquirectangular(texture).texture;
  pmrem.dispose();
  return { envMap, equirect: texture };
}

// Kept alive rather than disposed: the reflection probe temporarily swaps it in
// as the scene background so its cubemap capture contains the sky glow as well
// as the roads. Without it the probe sees only geometry against a near-black
// void, and buildings that switch to the probe go dark.
let envEquirect = null;

function applyEnvironment(hex) {
  // PMREM targets are GPU render targets — replacing one without disposing the
  // old leaks a texture on every colour tweak, and this fires on every drag of
  // the slider.
  scene.environment?.dispose();
  envEquirect?.dispose();

  const { envMap, equirect } = buildEnvironment(hex);
  scene.environment = envMap;
  envEquirect = equirect;
}

applyEnvironment(settings.envColor);

// Grayscale noise, used three ways on the buildings: as a roughness map (so the
// specular breaks up instead of smearing), as a bump map (so flat facades catch
// light unevenly) and as a faint albedo grain. `low`/`high` set the range —
// a tight range near white gives grain, a wide one gives blotchy panelling.
function buildNoiseTexture(repeat, low = 70, high = 200) {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const image = ctx.createImageData(size, size);
  const span = high - low;
  for (let i = 0; i < image.data.length; i += 4) {
    const value = low + Math.random() * span;
    image.data[i] = value;
    image.data[i + 1] = value;
    image.data[i + 2] = value;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  return texture;
}

// Cool sky, warm ground: the up-facing planes go slightly blue while the lower
// storeys pick up the sodium bounce off the street. Cheap, and it does most of
// the work of making the massing readable without lifting the black.
const ambient = new THREE.HemisphereLight(0x35425e, 0x4a2410, 0.55);
scene.add(ambient);

const sun = new THREE.DirectionalLight(settings.sunColor, settings.sunIntensity);
sun.position.set(-300, 400, 200);
scene.add(sun);

// Two big white softboxes well above the city, tilted down at it. A rect area
// light gives a broad wrapped falloff across the facades that a directional
// can't — the point is to lift the massing out of black, not to cast a key.
// Neutral white by design: the palette comes from the env map and the trails.
//
// They sit high and wide rather than low and close for a specific reason: the
// ground is near-mirror (metalness 0.85), so it reflects the light *rectangle*
// like any other object would. Low and bright puts a hard specular pool of the
// quad on the street. High, large and dim spreads that reflection out until it
// reads as ambient sheen instead of a blown-out hotspot.
RectAreaLightUniformsLib.init();

const AREA_LIGHT_INTENSITY = 0.55;

for (const position of [[-360, 620, 260], [380, 680, -240]]) {
  const light = new THREE.RectAreaLight(0xffffff, AREA_LIGHT_INTENSITY, 700, 460);
  light.position.set(...position);
  light.lookAt(0, 0, 0);
  scene.add(light);
}

// No rim/fill light: a second directional puts a hard specular hit on every
// rooftop at once, which the bloom then smears into one blue blob over midtown.
// Reflections come from the environment map instead.

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

// Longitude degrees shrink with latitude — without the cos() factor Manhattan
// comes out ~24% too wide at 40.7°N.
const METRES_PER_DEG_LON = METRES_PER_DEG_LAT * Math.cos((CENTER_LAT * Math.PI) / 180);

const toLocal = (lon, lat) => ({
  x: (lon - CENTER_LON) * METRES_PER_DEG_LON * UNITS_PER_METRE,
  z: (CENTER_LAT - lat) * METRES_PER_DEG_LAT * UNITS_PER_METRE,
});

const groundSpanX = (BBOX.maxLon - BBOX.minLon) * METRES_PER_DEG_LON * UNITS_PER_METRE;
const groundSpanZ = (BBOX.maxLat - BBOX.minLat) * METRES_PER_DEG_LAT * UNITS_PER_METRE;

// Land and sea are the same plane and the same material. The signed distance field
// built further down decides, per pixel, which one it is — so there is no second
// mesh to keep in register with the first, no z-fighting along the shore, and the
// waterline can fall wherever it likes inside a texel instead of on a polygon edge.
//
// Until the field loads this is a 1×1 texture reading "land everywhere", so the city
// comes up dry rather than flooded if Overpass is down.
const DRY_FIELD = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat);
DRY_FIELD.needsUpdate = true;

// How far either side of the shore the field can still measure, in world units. Past
// this it saturates, which is all anything needs: nothing here cares *how* deep the
// deep water is, only where the shallows are. Lives up here because the shader has to
// decode the field with the same number the builder encoded it with.
const WATER_RANGE = 24;

// World units per texel of the field, and therefore the finest shoreline it can hold.
const WATER_TEXEL = 2.0;

const waterUniforms = {
  uWaterField: { value: DRY_FIELD },
  uWaterRange: { value: WATER_RANGE },
  uWaterTime: { value: 0 },
  uWaterColor: { value: new THREE.Color('#05070c') },

  // Water is a dielectric, not a mirror. Dropping metalness on the wet pixels is
  // what separates it from the asphalt: the road keeps its flat sheen, while the
  // water goes dark face-on and lights up at grazing angles, which is the whole
  // look of a river at night.
  uWaterRoughness: { value: 0.09 },
  uWaterMetalness: { value: 0.22 },

  // Wavelength of the largest swell, in world units, and how hard it tilts the
  // surface. Strength is a normal perturbation, not a displacement — the plane
  // stays flat and only the *lighting* ripples, which at this altitude is
  // indistinguishable from real chop and costs nothing in geometry.
  //
  // Tilt gently. Push it and the ripples stop scattering the reflection and start
  // shattering it, and the river turns to cottage cheese.
  uWaveScale: { value: 0.18 },
  uWaveStrength: { value: 0.30 },

  // Wind. Isotropic noise gives a surface of round blobs, which is the one thing open
  // water never looks like — swell is always drawn out along the wind. Squashing the
  // noise domain on one axis stretches every octave into streaks running with it.
  uWindAxis: { value: new THREE.Vector2(1.0, 0.45).normalize() },

  // How far out from the beach the swell takes to reach full height. Real water
  // goes slack in the shallows, and this is the single cue that most sells the
  // shoreline as a shoreline rather than a colour change.
  uShallowFade: { value: 9.0 },

  // How far the land stands proud of the water, in world units — 0.25 is 2.5 m, which
  // is about what Manhattan actually manages. Small on purpose: enough that the bank
  // catches an edge and the island stops looking painted onto the river, not so much
  // that the city sits on a plinth.
  //
  // There is only one plane, so this can't be a transform on some separate land mesh —
  // the same field that says "wet" lifts the vertex that says "dry".
  uLandRise: { value: 0.25 },

  // Metres of shore over which it climbs. Wider than the waterline blend in the
  // fragment shader, so the bank is a beach rather than a kerb.
  uBankWidth: { value: 3.0 },

  // Size of the plane in world units, and of one field texel in uv. Together they turn
  // a difference between two texels into a real-world slope, which is what lets the
  // bank be *lit* as a slope instead of being a lifted-but-flat-shaded step.
  uPlaneSize: { value: new THREE.Vector2(groundSpanX * 2.4, groundSpanZ * 2.4) },
  uFieldTexel: { value: new THREE.Vector2(1, 1) },
};

const groundMaterial = new THREE.MeshStandardMaterial({
  color: '#05070c',
  roughness: 0.42,
  metalness: 0.85,
  roughnessMap: buildNoiseTexture(28),
  envMapIntensity: 0.7,
});

groundMaterial.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, waterUniforms);

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', /* glsl */`
      #include <common>
      varying vec2 vWaterUv;
      varying vec2 vWaterWorld;
      varying vec3 vWaterTangent;
      varying vec3 vWaterBitangent;

      uniform sampler2D uWaterField;
      uniform float uWaterRange;
      uniform float uLandRise;
      uniform float uBankWidth;
      uniform vec2 uPlaneSize;
      uniform vec2 uFieldTexel;

      // Height of the land at a point, in world units above the waterline.
      float landHeight(vec2 at) {
        float sd = (texture2D(uWaterField, at).r - 0.5) * 2.0 * uWaterRange;
        return uLandRise * smoothstep(-uBankWidth, uBankWidth, sd);
      }
    `)
    // The bank has to be lit as a slope or the whole thing is invisible: a lifted but
    // flat-shaded island takes exactly the same light as it did lying flat, and all
    // you'd get for the rise is a silhouette at grazing angles. Central differences
    // across one texel give the real gradient.
    .replace('#include <beginnormal_vertex>', /* glsl */`
      #include <beginnormal_vertex>
      {
        // Not named "step" — that's a GLSL builtin, and shadowing it is a compile
        // error on some drivers and a silent oddity on others.
        vec2 texel = uFieldTexel;
        float hL = landHeight(uv - vec2(texel.x, 0.0));
        float hR = landHeight(uv + vec2(texel.x, 0.0));
        float hD = landHeight(uv - vec2(0.0, texel.y));
        float hU = landHeight(uv + vec2(0.0, texel.y));

        // uv → world, so the slope is a real gradient and not a per-texel one.
        vec2 span = 2.0 * texel * uPlaneSize;
        objectNormal = normalize(vec3(-(hR - hL) / span.x, -(hU - hD) / span.y, 1.0));
      }
    `)
    .replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      vWaterUv = uv;
      vWaterWorld = (modelMatrix * vec4(position, 1.0)).xz;
      // The plane is flat and axis-aligned, so its tangent frame is the same at every
      // vertex — carrying it as a varying costs nothing and saves the fragment shader
      // from reconstructing a basis it already knows.
      vWaterTangent = normalize(normalMatrix * vec3(1.0, 0.0, 0.0));
      vWaterBitangent = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));

      // Stand the dry land up out of the water. The plane is built lying in XY and
      // rotated flat, so its local +Z is world *up* — the lift goes on transformed.z,
      // not .y, and putting it on .y would shove the whole city sideways into the
      // Hudson rather than raising it.
      transformed.z += landHeight(uv);
    `);

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', /* glsl */`
      #include <common>
      varying vec2 vWaterUv;
      varying vec2 vWaterWorld;
      varying vec3 vWaterTangent;
      varying vec3 vWaterBitangent;

      uniform sampler2D uWaterField;
      uniform float uWaterRange;
      uniform float uWaterTime;
      uniform vec3 uWaterColor;
      uniform float uWaterRoughness;
      uniform float uWaterMetalness;
      uniform float uWaveScale;
      uniform float uWaveStrength;
      uniform vec2 uWindAxis;
      uniform float uShallowFade;

      // Ashima's simplex noise. Gradient noise rather than value noise, so the swell
      // has no lattice in it — a grid of ripples aligned to the world axes is the one
      // artefact that would give the whole thing away as a texture.
      vec3 waterMod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
      vec4 waterMod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
      vec4 waterPermute(vec4 x) { return waterMod289(((x * 34.0) + 1.0) * x); }
      vec4 waterInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

      float snoise(vec3 v) {
        const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
        const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

        vec3 i = floor(v + dot(v, C.yyy));
        vec3 x0 = v - i + dot(i, C.xxx);

        vec3 g = step(x0.yzx, x0.xyz);
        vec3 l = 1.0 - g;
        vec3 i1 = min(g.xyz, l.zxy);
        vec3 i2 = max(g.xyz, l.zxy);

        vec3 x1 = x0 - i1 + C.xxx;
        vec3 x2 = x0 - i2 + C.yyy;
        vec3 x3 = x0 - D.yyy;

        i = waterMod289(i);
        vec4 p = waterPermute(waterPermute(waterPermute(
          i.z + vec4(0.0, i1.z, i2.z, 1.0)) +
          i.y + vec4(0.0, i1.y, i2.y, 1.0)) +
          i.x + vec4(0.0, i1.x, i2.x, 1.0));

        float n_ = 0.142857142857;
        vec3 ns = n_ * D.wyz - D.xzx;

        vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
        vec4 x_ = floor(j * ns.z);
        vec4 y_ = floor(j - 7.0 * x_);

        vec4 x = x_ * ns.x + ns.yyyy;
        vec4 y = y_ * ns.x + ns.yyyy;
        vec4 h = 1.0 - abs(x) - abs(y);

        vec4 b0 = vec4(x.xy, y.xy);
        vec4 b1 = vec4(x.zw, y.zw);

        vec4 s0 = floor(b0) * 2.0 + 1.0;
        vec4 s1 = floor(b1) * 2.0 + 1.0;
        vec4 sh = -step(h, vec4(0.0));

        vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
        vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

        vec3 p0 = vec3(a0.xy, h.x);
        vec3 p1 = vec3(a0.zw, h.y);
        vec3 p2 = vec3(a1.xy, h.z);
        vec3 p3 = vec3(a1.zw, h.w);

        vec4 norm = waterInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
        p0 *= norm.x;
        p1 *= norm.y;
        p2 *= norm.z;
        p3 *= norm.w;

        vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
        m = m * m;
        return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
      }

      // Time is the third axis of the noise rather than a scroll of the second, so the
      // swell evolves in place instead of sliding across the river like a conveyor.
      // Each octave runs on its own clock and its own offset, which stops them ever
      // beating back into phase with each other.
      //
      // The footprint is how much of the noise's own space a single pixel covers, and
      // every octave finer than that is dropped. Without it the swell doesn't smooth
      // out with distance, it *sparkles*: the fine octaves land under a pixel each and
      // alias into a field of glitter, which is precisely what a real sea doesn't do.
      // Fading them out instead lets the water go glassy as it recedes — and it means
      // the detail is still there when the camera comes down to the water.
      float waterHeight(vec2 p, float footprint) {
        float sum = 0.0;
        float amp = 0.5;
        float freq = 1.0;
        for (int i = 0; i < 4; i++) {
          float fade = 1.0 - smoothstep(0.3, 1.0, footprint * freq);
          if (fade > 0.001) {
            sum += amp * fade * snoise(vec3(p * freq, uWaterTime * (0.35 + 0.22 * float(i))));
          }
          amp *= 0.5;
          freq *= 2.03; // not quite 2, so octaves never line back up into a lattice
          p += vec2(1.7, -2.3);
        }
        return sum;
      }
    `)

    // Everything downstream needs to know how wet this pixel is, and colour is the
    // first stage that runs — so the field is sampled here and the result reused.
    .replace('#include <color_fragment>', /* glsl */`
      #include <color_fragment>
      float waterSd = (texture2D(uWaterField, vWaterUv).r - 0.5) * 2.0 * uWaterRange;

      // Half a texel of blend. The field is bilinear, so the waterline lands wherever
      // it truly falls inside the texel rather than snapping to its edge.
      float waterMask = smoothstep(1.0, -1.0, waterSd);
      diffuseColor.rgb = mix(diffuseColor.rgb, uWaterColor, waterMask);
    `)
    .replace('#include <roughnessmap_fragment>', /* glsl */`
      #include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, uWaterRoughness, waterMask);
    `)
    .replace('#include <metalnessmap_fragment>', /* glsl */`
      #include <metalnessmap_fragment>
      metalnessFactor = mix(metalnessFactor, uWaterMetalness, waterMask);
    `)
    .replace('#include <normal_fragment_begin>', /* glsl */`
      #include <normal_fragment_begin>
      if (waterMask > 0.002) {
        // Slack at the beach, full swell once it's deep. -waterSd is metres of water.
        float swell = uWaveStrength * smoothstep(0.0, uShallowFade, -waterSd);

        // Central differences on the height field give the surface normal. The offset
        // is in the noise's own space, so it tracks uWaveScale automatically — and it
        // never drops below the pixel footprint, or the difference would be measuring
        // detail this pixel cannot see.
        // Into the wind's frame, then squashed across it: what the noise sees as a
        // round blob comes out on the water as a crest drawn along the wind.
        vec2 along = uWindAxis;
        vec2 across = vec2(-along.y, along.x);
        vec2 world = vWaterWorld * uWaveScale;
        vec2 p = vec2(dot(world, along) * 0.45, dot(world, across));

        float footprint = length(fwidth(p));
        float e = max(0.06, footprint * 0.5);
        float hx = waterHeight(p + vec2(e, 0.0), footprint) - waterHeight(p - vec2(e, 0.0), footprint);
        float hz = waterHeight(p + vec2(0.0, e), footprint) - waterHeight(p - vec2(0.0, e), footprint);

        // Those two differences are slopes in the wind's frame, not the world's, so
        // they have to be rotated back before they can tilt anything — otherwise the
        // crests run with the wind but catch the light as though they ran across it.
        float slopeAlong = (hx / (2.0 * e)) * 0.45;
        float slopeAcross = hz / (2.0 * e);
        vec2 slope = along * slopeAlong + across * slopeAcross;

        vec3 ripple = normalize(
          normal
          - vWaterTangent * slope.x * swell
          - vWaterBitangent * slope.y * swell
        );
        normal = normalize(mix(normal, ripple, waterMask));
      }
    `);
};

// A single quad has no interior vertices, so there would be nothing for the land rise
// above to push on. Tessellating at half the field's resolution gives the shoreline a
// vertex roughly every 40 m — the bank is a soft 30 m ramp anyway, so finer buys
// nothing, and this stays one static draw call.
const groundSegX = Math.round((groundSpanX * 2.4) / (WATER_TEXEL * 2));
const groundSegZ = Math.round((groundSpanZ * 2.4) / (WATER_TEXEL * 2));

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(groundSpanX * 2.4, groundSpanZ * 2.4, groundSegX, groundSegZ),
  groundMaterial,
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.4;
scene.add(ground);

// ---------------------------------------------------------------------------
// Loading UI
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stats readout
// ---------------------------------------------------------------------------

let mapSource = 'Unknown';
let buildingCount = 0;
let buildingCandidates = 0;

const statsPanel = document.querySelector('#stats');
const formatNumber = (value) => value.toLocaleString('en-US');

function publishStats(values) {
  for (const [key, value] of Object.entries(values)) {
    const cell = statsPanel?.querySelector(`[data-stat="${key}"]`);
    if (cell) cell.textContent = typeof value === 'number' ? formatNumber(value) : value;
  }
}

// Sampled over a rolling second rather than from the frame delta: a per-frame
// figure jitters far too much to read.
let fpsFrames = 0;
let fpsElapsed = 0;
const fpsCell = statsPanel?.querySelector('[data-stat="fps"]');

function trackFps(dt) {
  // Skip the readout entirely while collapsed — no point touching the DOM every
  // second for something nobody is looking at.
  if (!fpsCell || statsPanel.hasAttribute('data-collapsed')) return;

  fpsFrames += 1;
  fpsElapsed += dt;
  if (fpsElapsed < 1) return;

  fpsCell.textContent = Math.round(fpsFrames / fpsElapsed);
  fpsFrames = 0;
  fpsElapsed = 0;
}

// Degrees and decimal minutes, the convention the reference maps use:
// 40°43.860'N / 73°59.610'W. Note the hemisphere letter carries the sign, so the
// number itself is always the absolute value.
function formatCoord(value, positive, negative) {
  const hemisphere = value >= 0 ? positive : negative;
  const absolute = Math.abs(value);
  const degrees = Math.floor(absolute);
  const minutes = (absolute - degrees) * 60;
  return `${degrees}°${minutes.toFixed(3)}'${hemisphere}`;
}

function setupPlaceLabel() {
  const name = document.querySelector('[data-place-name]');
  const region = document.querySelector('[data-place-region]');
  const coords = document.querySelector('[data-place-coords]');
  if (!name || !region || !coords) return;

  name.textContent = LOCATION.name;
  region.textContent = LOCATION.region;
  coords.textContent = [
    formatCoord(CENTER_LAT, 'N', 'S'),
    formatCoord(CENTER_LON, 'E', 'W'),
  ].join(' / ');
}

function setupStats() {
  const toggle = document.querySelector('#stats-toggle');
  toggle.addEventListener('click', () => {
    const collapsed = statsPanel.toggleAttribute('data-collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.querySelector('.chevron').textContent = collapsed ? '+' : '−';
    fpsFrames = 0;
    fpsElapsed = 0;
  });
}

function setLoadingState(progress, label) {
  if (!loadingIndicator || !loadingLabel || !loadingBar) return;
  loadingIndicator.hidden = false;
  loadingLabel.textContent = label;
  loadingBar.style.width = `${Math.max(4, Math.min(100, progress))}%`;
}

function hideLoadingIndicator() {
  if (loadingIndicator) loadingIndicator.hidden = true;
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

// ---------------------------------------------------------------------------
// OpenStreetMap
// ---------------------------------------------------------------------------

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
// Must exceed the [timeout:90] the query itself declares, plus transfer time —
// a shorter abort would kill responses that were about to succeed.
const REQUEST_TIMEOUT = 150000;
const CACHE_NAME = 'taxitaxi-osm-v1';

function sortElements(payload) {
  const buildings = [];
  const roads = [];

  for (const element of payload.elements || []) {
    if (element.type !== 'way' || !element.geometry) continue;
    const tags = element.tags || {};
    if (tags.building) buildings.push(element);
    else if (tags.highway && !SKIPPED_HIGHWAYS.has(tags.highway)) roads.push(element);
  }
  return { buildings, roads };
}

// Returns the raw Overpass payload, and whether it came off the disk. The query
// text *is* the cache key, so changing a query can never serve you the previous
// query's answer — and the water query below gets its own entry rather than
// invalidating the tens-of-megabytes city one.
async function overpassQuery(query, cachedLabel) {
  const cacheKey = `https://taxitaxi.local/osm?${encodeURIComponent(query)}`;

  // Overpass is a free, rate-limited, frequently-504ing service, and this data
  // never changes under us. Re-running on every page reload gets you throttled
  // fast, so keep the response and only ever fetch it once.
  const cache = 'caches' in window ? await caches.open(CACHE_NAME).catch(() => null) : null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      if (cachedLabel) setLoadingState(30, cachedLabel);
      return { payload: await hit.json(), cached: true };
    }
  }

  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    // Without an abort, a hung mirror stalls the whole page indefinitely — the
    // fallback endpoint is only useful if we actually give up on the first one.
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), REQUEST_TIMEOUT);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      if (cache) await cache.put(cacheKey, response.clone());
      return { payload: await response.json(), cached: false };
    } catch (error) {
      lastError = error;
      console.warn('Overpass request failed:', endpoint, error);
    } finally {
      window.clearTimeout(timer);
    }
  }
  throw lastError ?? new Error('Overpass unavailable');
}

async function loadOsmData() {
  const bbox = `${BBOX.minLat},${BBOX.minLon},${BBOX.maxLat},${BBOX.maxLon}`;
  const query = `[out:json][timeout:90];(way["building"](${bbox});way["highway"](${bbox}););out body geom;`;

  const { payload, cached } = await overpassQuery(query, 'Reading cached map…');
  mapSource = cached ? 'Cache' : 'OpenStreetMap';
  return sortElements(payload);
}

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------
// OSM does not hand you the sea. Inside this bbox the `natural=water` polygons are
// fountains, memorial pools and dry docks; the Hudson and the East River aren't
// areas at all. They're `natural=coastline` — open lines, carrying nothing but the
// convention that land lies to the *left* of the way's direction of travel. So the
// water can't be read off the map, it has to be derived from the shoreline.
//
// What we derive is a signed distance field over the ground plane: positive on land,
// negative in the water, zero at the shore. A plain inside/outside mask would be
// enough to colour the two apart, but the distance is what makes it read as a sea.
// It damps the swell as it comes into the shallows, and it puts a soft edge on the
// shoreline instead of a staircase of texels.
//
// The one thing a coastline can't tell you is which side you're on *globally* — so
// every texel takes its sign from the nearest piece of shore, which needs no closed
// rings, no stitching of the 56 fragments, and no special case for the chains that
// run off the edge of the map.

// The ground plane runs 2.4× the bbox, and the shoreline has to be known across all
// of it or New Jersey and Brooklyn come out as open ocean. Coastline is a few dozen
// ways, so the wider query is nearly free — and it is a separate cache entry, so it
// doesn't invalidate the city.
const WATER_QUERY_SPAN = 2.6;

const waterPlaneW = groundSpanX * 2.4;
const waterPlaneD = groundSpanZ * 2.4;

async function loadWaterData() {
  const halfLat = ((BBOX.maxLat - BBOX.minLat) / 2) * WATER_QUERY_SPAN;
  const halfLon = ((BBOX.maxLon - BBOX.minLon) / 2) * WATER_QUERY_SPAN;
  const bbox = [
    CENTER_LAT - halfLat, CENTER_LON - halfLon,
    CENTER_LAT + halfLat, CENTER_LON + halfLon,
  ].join(',');

  // `out geom` returns a way's *complete* geometry even where it leaves the bbox,
  // so a coastline clipped by the query still arrives whole.
  const query = `[out:json][timeout:90];(way["natural"="coastline"](${bbox});way["natural"="water"](${bbox});way["waterway"="riverbank"](${bbox});relation["natural"="water"](${bbox}););out body geom;`;

  const { payload } = await overpassQuery(query);
  const shoreline = [];
  const pools = [];

  const ring = (geometry) => geometry.map(({ lon, lat }) => toLocal(lon, lat));

  for (const element of payload.elements || []) {
    const tags = element.tags || {};

    if (element.type === 'way' && element.geometry) {
      if (tags.natural === 'coastline') shoreline.push(ring(element.geometry));
      else if (element.geometry.length > 3) pools.push(ring(element.geometry));
    } else if (element.type === 'relation') {
      // A multipolygon lake. Its holes (role `inner`) are islands, and dropping them
      // just means a wooded islet reads as water — a far smaller lie than dropping
      // the lake, and it keeps the rasteriser to one code path.
      for (const member of element.members || []) {
        if (member.type === 'way' && member.role !== 'inner' && member.geometry?.length > 3) {
          pools.push(ring(member.geometry));
        }
      }
    }
  }

  return { shoreline, pools };
}

// Squared distance from a point to a segment, and where along it the foot landed.
// `t` matters as much as the distance: a foot pinned to an endpoint means the point
// is out beyond the end of this segment, and the sign there can't be trusted to the
// segment alone.
function closestOnSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSq)) : 0;
  const cx = ax + t * dx;
  const cz = az + t * dz;
  return { t, cx, cz, distSq: (px - cx) ** 2 + (pz - cz) ** 2 };
}

// Builds the signed distance field and returns it as a texture.
//
// Nearest-shore-by-brute-force would be 400k texels × 10k segments, so instead the
// segments are stamped into the grid and the distances flood outward from them
// (dead reckoning: each texel carries the *coordinates* of the nearest shore point
// it has heard about, and two sweeps — one down, one back up — are enough for every
// texel to hear about the true nearest one from a neighbour). Linear in the grid,
// and it comes out exact to within a fraction of a texel.
function buildWaterField({ shoreline, pools }) {
  const nx = Math.round(waterPlaneW / WATER_TEXEL);
  const nz = Math.round(waterPlaneD / WATER_TEXEL);
  const stepX = waterPlaneW / nx;
  const stepZ = waterPlaneD / nz;

  // Texel (i, j) is at uv ((i+.5)/nx, (j+.5)/nz), and the ground plane's uv maps
  // straight onto the world: +u east, +v *north* (the plane is rotated flat, which
  // flips v against z). Getting this backwards mirrors the coastline about the
  // river, which looks plausible enough at a glance to cost you an hour.
  const worldX = (i) => ((i + 0.5) / nx - 0.5) * waterPlaneW;
  const worldZ = (j) => (0.5 - (j + 0.5) / nz) * waterPlaneD;

  // Flat segment soup. `prev`/`next` link a segment to its neighbours in the same
  // chain, which is what lets the sign survive a sharp corner (see below).
  const ax = [], az = [], bx = [], bz = [], prev = [], next = [];
  for (const chain of shoreline) {
    const base = ax.length;
    for (let i = 0; i + 1 < chain.length; i += 1) {
      ax.push(chain[i].x); az.push(chain[i].z);
      bx.push(chain[i + 1].x); bz.push(chain[i + 1].z);
      prev.push(i === 0 ? -1 : base + i - 1);
      next.push(i + 2 < chain.length ? base + i + 1 : -1);
    }
  }

  const count = nx * nz;
  const nearX = new Float32Array(count);
  const nearZ = new Float32Array(count);
  const nearSeg = new Int32Array(count).fill(-1);
  const dist = new Float32Array(count).fill(Infinity);

  const offer = (i, j, sx, sz, seg) => {
    if (i < 0 || j < 0 || i >= nx || j >= nz) return;
    const index = j * nx + i;
    const d = Math.hypot(worldX(i) - sx, worldZ(j) - sz);
    if (d >= dist[index]) return;
    dist[index] = d;
    nearX[index] = sx;
    nearZ[index] = sz;
    nearSeg[index] = seg;
  };

  // Seed: walk each segment and hand its closest point to the texels it passes
  // through, plus their immediate neighbours — a segment that clips the corner of a
  // texel still has to seed it, or the flood starts from a hole.
  for (let s = 0; s < ax.length; s += 1) {
    const length = Math.hypot(bx[s] - ax[s], bz[s] - az[s]);
    const steps = Math.max(1, Math.ceil(length / (WATER_TEXEL * 0.5)));
    for (let k = 0; k <= steps; k += 1) {
      const t = k / steps;
      const px = ax[s] + (bx[s] - ax[s]) * t;
      const pz = az[s] + (bz[s] - az[s]) * t;
      const i0 = Math.round((px / waterPlaneW + 0.5) * nx - 0.5);
      const j0 = Math.round((0.5 - pz / waterPlaneD) * nz - 0.5);
      for (let dj = -1; dj <= 1; dj += 1) {
        for (let di = -1; di <= 1; di += 1) {
          const i = i0 + di;
          const j = j0 + dj;
          if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
          const foot = closestOnSegment(worldX(i), worldZ(j), ax[s], az[s], bx[s], bz[s]);
          offer(i, j, foot.cx, foot.cz, s);
        }
      }
    }
  }

  // Flood. Each sweep only has to look at the neighbours it has already visited, so
  // between the two of them every texel has seen every direction.
  const sweep = (order, neighbours) => {
    for (const index of order) {
      const i = index % nx;
      const j = (index - i) / nx;
      for (const [di, dj] of neighbours) {
        const n = (j + dj) * nx + (i + di);
        if (i + di < 0 || j + dj < 0 || i + di >= nx || j + dj >= nz) continue;
        if (nearSeg[n] < 0) continue;
        offer(i, j, nearX[n], nearZ[n], nearSeg[n]);
      }
    }
  };

  const forward = new Int32Array(count);
  for (let k = 0; k < count; k += 1) forward[k] = k;
  const backward = Int32Array.from(forward).reverse();
  sweep(forward, [[-1, -1], [0, -1], [1, -1], [-1, 0]]);
  sweep(backward, [[1, 1], [0, 1], [-1, 1], [1, 0]]);

  // Sign. Land lies to the left of the coastline's direction of travel — but our z
  // runs *south* while OSM's latitude runs north, and that flip turns the geographic
  // left into a right-hand cross product here: land is where (dz·px − dx·pz) > 0.
  //
  // At a sharp corner the nearest point is a shared vertex, and testing against
  // either segment alone misreads the wedge beyond the tip — a pier would trail a
  // wrong-signed wake out into the river. Averaging the two directions that meet
  // there tests against the bisector instead, which is the side the corner as a
  // whole faces.
  const signed = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const s = nearSeg[index];
    if (s < 0) { signed[index] = WATER_RANGE; continue; } // no coast at all: call it land

    const i = index % nx;
    const j = (index - i) / nx;
    const px = worldX(i);
    const pz = worldZ(j);

    const foot = closestOnSegment(px, pz, ax[s], az[s], bx[s], bz[s]);
    let dx = bx[s] - ax[s];
    let dz = bz[s] - az[s];

    const join = foot.t <= 0.0001 ? prev[s] : foot.t >= 0.9999 ? next[s] : -1;
    if (join >= 0) {
      const length = Math.hypot(dx, dz) || 1;
      const otherX = bx[join] - ax[join];
      const otherZ = bz[join] - az[join];
      const otherLength = Math.hypot(otherX, otherZ) || 1;
      dx = dx / length + otherX / otherLength;
      dz = dz / length + otherZ / otherLength;
    }

    const land = dz * (px - foot.cx) - dx * (pz - foot.cz) > 0;
    signed[index] = land ? dist[index] : -dist[index];
  }

  // Lakes, reservoirs, ponds, docks — the water that *is* mapped as areas, merged in
  // on top of the coastline's verdict.
  //
  // Merging two distance fields is a min(), not a paint: a texel takes the distance
  // to the nearest water of *either* kind. Stamping only the wet insides would have
  // been enough to colour a lake blue, but it would leave the dry texel next door
  // still holding its "miles inland" saturated distance — and the shoreline blend,
  // which needs small values on *both* sides to find the waterline, would collapse
  // to a hard aliased edge around every pond. So the bank is walked from outside too,
  // and that means padding the scan by the range the field can actually represent.
  const pad = Math.ceil(WATER_RANGE / WATER_TEXEL);

  for (const poly of pools) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }

    const i0 = Math.max(0, Math.floor((minX / waterPlaneW + 0.5) * nx) - pad);
    const i1 = Math.min(nx - 1, Math.ceil((maxX / waterPlaneW + 0.5) * nx) + pad);
    const j0 = Math.max(0, Math.floor((0.5 - maxZ / waterPlaneD) * nz) - pad);
    const j1 = Math.min(nz - 1, Math.ceil((0.5 - minZ / waterPlaneD) * nz) + pad);

    for (let j = j0; j <= j1; j += 1) {
      for (let i = i0; i <= i1; i += 1) {
        const px = worldX(i);
        const pz = worldZ(j);

        // Crossing count for the side, nearest bank for the distance — one pass over
        // the ring gives both.
        let inside = false;
        let bankSq = Infinity;
        for (let a = 0, b = poly.length - 1; a < poly.length; b = a, a += 1) {
          const pa = poly[a];
          const pb = poly[b];
          if ((pa.z > pz) !== (pb.z > pz)
            && px < ((pb.x - pa.x) * (pz - pa.z)) / (pb.z - pa.z) + pa.x) inside = !inside;
          bankSq = Math.min(bankSq, closestOnSegment(px, pz, pa.x, pa.z, pb.x, pb.z).distSq);
        }

        const bank = Math.sqrt(bankSq);
        const index = j * nx + i;
        signed[index] = Math.min(signed[index], inside ? -bank : bank);
      }
    }
  }

  // 0.5 is the waterline. Eight bits over ±24 units is ~2 cm per step near the
  // shore, which is far past what the blend below can resolve.
  const data = new Uint8Array(count);
  for (let k = 0; k < count; k += 1) {
    const encoded = 0.5 + signed[k] / (2 * WATER_RANGE);
    data[k] = Math.round(Math.max(0, Math.min(1, encoded)) * 255);
  }

  const texture = new THREE.DataTexture(data, nx, nz, THREE.RedFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  const water = signed.reduce((n, v) => (v < 0 ? n + 1 : n), 0);
  return { texture, coverage: water / count };
}

// ---------------------------------------------------------------------------
// Buildings — one merged mesh, one shared material. The original built a fresh
// 256×256 canvas texture and a fresh MeshStandardMaterial per building, which
// is thousands of textures, thousands of shader programs and thousands of draw
// calls for geometry that all looks the same.
// ---------------------------------------------------------------------------

function parseBuildingHeight(tags) {
  const height = parseFloat(tags.height);
  if (Number.isFinite(height) && height > 1) return height;

  const levels = parseInt(tags['building:levels'] ?? tags.levels ?? '0', 10);
  if (levels > 0) return levels * 3.2;

  return 10 + Math.random() * 14;
}

function footprintArea(coords) {
  let area = 0;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i, i += 1) {
    area += (coords[j].x + coords[i].x) * (coords[j].z - coords[i].z);
  }
  return Math.abs(area / 2);
}

function buildingGeometry(element) {
  const coords = element.geometry.map(({ lon, lat }) => toLocal(lon, lat));
  // Overpass closes rings by repeating the first node; Shape closes it for us.
  if (coords.length > 1) {
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first.x === last.x && first.z === last.z) coords.pop();
  }
  if (coords.length < 3) return null;
  if (footprintArea(coords) < 0.6) return null; // sub-60m² noise: sheds, kiosks

  // The shape's Y axis carries the footprint's world Z, and the rotateX(-90°)
  // below maps (x, y, z) → (x, z, -y) — so whatever goes in as Y comes out
  // *negated* in world Z. Feed it -z here and the rotation flips it back.
  // Without this the footprints are mirrored about the Z axis, which on a street
  // grid tilted off north (Manhattan's is ~29°) reads as a bulk rotation rather
  // than a flip, and the buildings sit at an angle to the roads.
  const shape = new THREE.Shape();
  shape.moveTo(coords[0].x, -coords[0].z);
  for (let i = 1; i < coords.length; i += 1) shape.lineTo(coords[i].x, -coords[i].z);
  shape.closePath();

  const metres = Math.min(320, Math.max(6, parseBuildingHeight(element.tags || {})));
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: metres * UNITS_PER_METRE,
    bevelEnabled: false,
  });
  // Extrude builds on XY and pushes along +Z; lay it down so depth becomes height.
  geometry.rotateX(-Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}

let buildingMesh = null;
let buildingMaterial = null;
let buildingEdges = null;
let edgeMaterial = null;

// Every building is one merged mesh sharing one material, so the only per-building
// channel left is the vertex data. Each footprint carries two values, repeated
// across all of its vertices: `variant` picks one of the three variation colours,
// and `lean` says how far this particular building drifts from the base colour
// toward that variation colour. The `color` attribute is the baked result, and the
// material colour is left white so the vertex colour *is* the facade colour —
// which is what lets a colour picker set an absolute shade rather than a tint.
//
// Squaring the random skews `lean` toward 0, i.e. toward the base colour: most of
// the city stays on-palette and a minority of blocks drift far enough to notice,
// which reads as variation rather than as noise.
//
// Keeping variant and lean on the geometry means every control below rebakes the
// colours in place — no rebuilding the city to recolour it.
function variationAttributes(vertexCount) {
  const variant = Math.floor(Math.random() * 3);
  const lean = Math.random() ** 2;

  return {
    variant: new THREE.Float32BufferAttribute(new Float32Array(vertexCount).fill(variant), 1),
    lean: new THREE.Float32BufferAttribute(new Float32Array(vertexCount).fill(lean), 1),
  };
}

// THREE.Color parses hex as sRGB and stores it in the linear working space, which
// is the space vertex colours are already assumed to be in — so these go straight
// into the attribute with no further conversion.
const baseColor = new THREE.Color();
const variantColors = [new THREE.Color(), new THREE.Color(), new THREE.Color()];
const bakedColor = new THREE.Color();

function applyBuildingPalette() {
  if (!buildingMesh) return;

  const geometry = buildingMesh.geometry;
  const variant = geometry.getAttribute('variant');
  const lean = geometry.getAttribute('lean');
  const color = geometry.getAttribute('color');
  if (!variant || !lean || !color) return;

  baseColor.set(settings.buildingColor);
  variantColors[0].set(settings.variationColorA);
  variantColors[1].set(settings.variationColorB);
  variantColors[2].set(settings.variationColorC);

  for (let i = 0; i < color.count; i += 1) {
    const target = variantColors[variant.getX(i)];
    bakedColor.copy(baseColor).lerp(target, lean.getX(i) * settings.buildingVariation);
    color.setXYZ(i, bakedColor.r, bakedColor.g, bakedColor.b);
  }
  color.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Reflection probe.
//
// The painted environment map can't reflect the trails — it doesn't know they
// exist. So render the *actual scene* into a cubemap from the middle of the city
// a few times a second, run it through PMREM (which prefilters it into roughness
// mips), and hand that to the buildings as their envMap. Now the glowing road
// grid genuinely shows up on the facades, and because the material is rough the
// PMREM blur turns it into a soft diffused sheen rather than a mirror image.
//
// 128px and 4Hz because it is 6 scene renders per update. The eye cannot follow
// a reflection that soft, so a low rate is free.
// ---------------------------------------------------------------------------

const PROBE_INTERVAL = 0.25; // seconds
const probeTarget = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
const probeCamera = new THREE.CubeCamera(1, 3000, probeTarget);
probeCamera.position.set(0, 40, 20);

const probePMREM = new THREE.PMREMGenerator(renderer);
probePMREM.compileCubemapShader();

let probeEnv = null;
let probeClock = 0;

// A cubemap of a mostly-black city carries far less irradiance than the painted
// sky, whose warm band wraps the whole horizon — so switching the probe on would
// otherwise dim every facade. This gain buys that back, and keeps the Reflection
// slider meaning the same thing whichever mode you're in.
const PROBE_GAIN = 2.1;

function applyBuildingEnvIntensity() {
  if (!buildingMaterial) return;
  const gain = settings.reflectTrails ? PROBE_GAIN : 1;
  buildingMaterial.envMapIntensity = settings.envIntensity * gain;
}

function applyReflectionProbe(enabled) {
  if (!buildingMaterial) return;

  // Falling back to null makes the material use scene.environment again, so the
  // Environment colour control resumes driving the buildings when this is off.
  buildingMaterial.envMap = enabled ? probeEnv : null;
  buildingMaterial.needsUpdate = true;
  applyBuildingEnvIntensity();
}

function updateReflectionProbe(dt) {
  if (!settings.reflectTrails || !buildingMaterial) return;

  probeClock -= dt;
  if (probeClock > 0) return;
  probeClock = PROBE_INTERVAL;

  // Hide the buildings while capturing: the probe camera sits inside the city, so
  // it would otherwise be looking at the inside of whatever tower it's standing
  // in. We want it to see the road grid and the sky.
  const wasVisible = buildingMesh ? buildingMesh.visible : false;
  const edgesWereVisible = buildingEdges ? buildingEdges.visible : false;
  if (buildingMesh) buildingMesh.visible = false;
  if (buildingEdges) buildingEdges.visible = false;

  // Swap the flat background colour for the painted sky so the capture picks up
  // the horizon glow. Otherwise the probe is roads-on-black and the buildings
  // lose every bit of ambient they used to get from the environment map.
  const background = scene.background;
  scene.background = envEquirect;

  probeCamera.update(renderer, scene);

  scene.background = background;
  if (buildingMesh) buildingMesh.visible = wasVisible;
  if (buildingEdges) buildingEdges.visible = edgesWereVisible;

  const next = probePMREM.fromCubemap(probeTarget.texture).texture;
  probeEnv?.dispose(); // fromCubemap allocates a fresh target every call
  probeEnv = next;

  // Only flag a recompile the first time, when the envMap define actually
  // changes. Swapping one texture for another of the same type does not need it,
  // and doing it 4x/second would rebuild the shader 4x/second.
  const firstAssignment = buildingMaterial.envMap === null;
  buildingMaterial.envMap = probeEnv;
  if (firstAssignment) buildingMaterial.needsUpdate = true;
}

// Transparency on a single merged mesh can't sort against itself, so at anything
// below opaque we drop depth writes. Buildings then stop hiding each other and
// the whole block reads as glass — which is the point of the slider, and also
// what lets the road heat show through from underneath.
function applyBuildingOpacity(value) {
  if (!buildingMaterial) return;

  const opaque = value >= 0.99;
  const wasTransparent = buildingMaterial.transparent;

  buildingMaterial.opacity = value;
  buildingMaterial.transparent = !opaque;
  buildingMaterial.depthWrite = opaque;

  // Toggling .transparent changes the shader's blending setup, so the program
  // has to be rebuilt — without this the mesh stays stubbornly solid.
  if (wasTransparent !== buildingMaterial.transparent) buildingMaterial.needsUpdate = true;
}

async function addBuildings(elements) {
  const ranked = elements
    .map((element) => ({ element, geometry: buildingGeometry(element) }))
    .filter((entry) => entry.geometry !== null);

  buildingCandidates = ranked.length;

  const geometries = ranked.slice(0, MAX_BUILDINGS).map((entry) => entry.geometry);
  ranked.slice(MAX_BUILDINGS).forEach((entry) => entry.geometry.dispose());
  if (geometries.length === 0) return;

  // mergeGeometries only accepts geometries with identical attribute sets, so the
  // colour attribute goes on here empty and is baked once the mesh exists.
  for (const geometry of geometries) {
    const count = geometry.getAttribute('position').count;
    const { variant, lean } = variationAttributes(count);
    geometry.setAttribute('variant', variant);
    geometry.setAttribute('lean', lean);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  }

  await nextFrame();
  const merged = mergeGeometries(geometries, false);
  geometries.forEach((geometry) => geometry.dispose());
  if (!merged) return;

  // Grain: a near-white noise map on albedo (so the facade isn't a flat fill),
  // the same noise on bump (so it catches the light unevenly at grazing angles),
  // and a wider-range noise on roughness (so the reflection is broken up rather
  // than mirror-smooth). Together they're what makes the reflected trails read as
  // a soft bloom on concrete instead of a sharp mirrored streak.
  const grain = buildNoiseTexture(5, 205, 255);

  buildingMaterial = new THREE.MeshStandardMaterial({
    // White: the facade colour lives in the vertex colours, which the shader
    // multiplies this by. Tinting here as well would double-apply the palette.
    color: 0xffffff,
    roughness: settings.buildingRoughness,
    metalness: 0.30,
    map: grain,
    bumpMap: grain,
    bumpScale: settings.buildingGrain,
    roughnessMap: buildNoiseTexture(6),
    vertexColors: true,
  });

  buildingCount = geometries.length;

  buildingMesh = new THREE.Mesh(merged, buildingMaterial);
  buildingMesh.visible = settings.buildingsVisible;
  scene.add(buildingMesh);
  applyBuildingPalette();
  applyBuildingOpacity(settings.buildingOpacity);
  applyReflectionProbe(settings.reflectTrails);

  await nextFrame();

  // A 25° crease threshold keeps the silhouette and the storey-height creases but
  // discards the triangulation of each flat wall and roof — a plain wireframe
  // would draw every internal triangle edge and turn the city into mush.
  edgeMaterial = new THREE.LineBasicMaterial({
    color: settings.edgeColor,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });

  buildingEdges = new THREE.LineSegments(new THREE.EdgesGeometry(merged, 25), edgeMaterial);
  buildingEdges.visible = settings.buildingsVisible && settings.showEdges;
  buildingEdges.renderOrder = 1;
  scene.add(buildingEdges);
}

// ---------------------------------------------------------------------------
// Road network — rendered as fat additive lines whose vertex colours carry a
// per-segment "heat" value. Taxis deposit heat as they drive; heat decays. That
// decaying tail *is* the light trail, so it lies on the road instead of being a
// separate arc floating over the city.
// ---------------------------------------------------------------------------

// `width` and `rise` are in SCENE UNITS (1 unit = 10 m), so a road holds a real,
// physical size on the ground the way a painted carriageway does: it stays put
// under the city as you zoom, and the motorways read as visibly fatter than the
// side streets from any altitude. `speed` is metres per second.
//
// Widths are deliberately *under* a real carriageway (2.8 m / 1.8 m / 1.1 m).
// Drawn at true width the grid fuses into one white sheet before any single trail
// is legible — the trail has to read as a drawn line, not as a painted road.
//
// `rise` is how far a trail lifts off the tarmac. Every road is a thin flat ribbon
// plus two vertical fins standing on its long edges, but the fins are lit by HEAT
// ALONE — see the fragment shader. So an empty street is a flat drawn line with no
// height at all, and the third dimension belongs to the traffic: it rises with the
// car, travels with it, and sinks back into the road as the trail cools.
const ROAD_CLASSES = [
  { match: ['motorway', 'motorway_link', 'trunk', 'trunk_link'], width: 0.28, rise: 0.72, speed: 24 },
  { match: ['primary', 'primary_link', 'secondary', 'secondary_link'], width: 0.18, rise: 0.50, speed: 15 },
  { match: null, width: 0.11, rise: 0.36, speed: 10 }, // everything else
];

// How far apart, in scene units, the heat samples sit along a road. THIS is the
// resolution of the light trail, and it is why the trail no longer comes out in
// blocks: heat used to live only at a segment's two endpoints, so a taxi halfway
// down a block deposited half into each end and lit the WHOLE block uniformly —
// there was nowhere to record where on it the car actually was. Sampling every few
// metres instead gives the glow somewhere to be, and it slides along the ribbon
// with the car rather than snapping from one segment to the next.
//
// It is decoupled from the OSM geometry on purpose: the driving graph still uses
// real road segments (the whole cornering model is written in terms of them), and
// only the *rendering* is resampled. Shrinking this buys smoothness at a linear
// cost in vertices and in the per-frame heat upload.
const SAMPLE_SPACING = 0.4; // 4 m

function roadClassIndex(tags) {
  const highway = tags?.highway ?? '';
  for (let i = 0; i < ROAD_CLASSES.length - 1; i += 1) {
    if (ROAD_CLASSES[i].match.includes(highway)) return i;
  }
  return ROAD_CLASSES.length - 1;
}

const nodes = []; // { x, z, edges: [edgeIndex] }
const edges = []; // { a, b, length, klass, sampleStart, sampleCount, quadStart }
const roadLayers = []; // one mesh per class, plus its heat buffers

function buildRoadNetwork(elements) {
  const nodeIds = new Map();
  const positions = ROAD_CLASSES.map(() => []);
  const quadCounts = ROAD_CLASSES.map(() => 0);
  const sampleCounts = ROAD_CLASSES.map(() => 0);

  // One pair of endpoints per edge — the whole network in a single draw call, and
  // static, so it never touches the bus again after it is uploaded.
  const linePoints = [];
  const lineWeights = [];

  const nodeId = (lon, lat) => {
    const key = `${lon.toFixed(6)},${lat.toFixed(6)}`;
    let id = nodeIds.get(key);
    if (id === undefined) {
      const local = toLocal(lon, lat);
      id = nodes.length;
      nodes.push({ x: local.x, z: local.z, edges: [] });
      nodeIds.set(key, id);
    }
    return id;
  };

  for (const element of elements) {
    const klass = roadClassIndex(element.tags);
    const geometry = element.geometry;

    for (let i = 1; i < geometry.length; i += 1) {
      const a = nodeId(geometry[i - 1].lon, geometry[i - 1].lat);
      const b = nodeId(geometry[i].lon, geometry[i].lat);
      if (a === b) continue;

      const na = nodes[a];
      const nb = nodes[b];
      const length = Math.hypot(nb.x - na.x, nb.z - na.z);
      if (length < 1e-4) continue;

      // Chop the segment into quads no longer than SAMPLE_SPACING, with a heat
      // sample at every join. Two samples (one quad) is the floor — a segment
      // shorter than the spacing is already finer than the trail resolution.
      const quads = Math.max(1, Math.round(length / SAMPLE_SPACING));
      const samples = quads + 1;

      const quadStart = quadCounts[klass];
      const sampleStart = sampleCounts[klass];
      quadCounts[klass] += quads;
      sampleCounts[klass] += samples;

      const { width, rise } = ROAD_CLASSES[klass];
      const half = width / 2;
      const dx = (nb.x - na.x) / length;
      const dz = (nb.z - na.z) / length;
      const px = -dz * half; // sideways, to offset the ribbon's two long edges
      const pz = dx * half;

      for (let q = 0; q < quads; q += 1) {
        // Push the segment's two OUTER ends lengthways by the half-width so that
        // touching segments overlap into their shared corner instead of leaving a
        // notch at every bend and junction. The interior joins between quads are
        // collinear and already flush, so they must not be extended — doing so
        // would double the geometry up on itself and put a bright seam every few
        // metres down an otherwise even road.
        const from = (q / quads) * length - (q === 0 ? half : 0);
        const to = ((q + 1) / quads) * length + (q === quads - 1 ? half : 0);

        const ax = na.x + dx * from;
        const az = na.z + dz * from;
        const bx = na.x + dx * to;
        const bz = na.z + dz * to;

        // Four corners on the tarmac, then the same four lifted by `rise`. The
        // lifted ring is not a lid — there is no top face. It is the upper edge of
        // two vertical fins hanging off the ribbon's long sides.
        positions[klass].push(
          ax + px, 0, az + pz, // 0 — start, left
          ax - px, 0, az - pz, // 1 — start, right
          bx + px, 0, bz + pz, // 2 — end, left
          bx - px, 0, bz - pz, // 3 — end, right

          ax + px, rise, az + pz, // 4 — start, left, lifted
          ax - px, rise, az - pz, // 5 — start, right, lifted
          bx + px, rise, bz + pz, // 6 — end, left, lifted
          bx - px, rise, bz - pz, // 7 — end, right, lifted
        );
      }

      linePoints.push(na.x, 0, na.z, nb.x, 0, nb.z);
      lineWeights.push(ROAD_LINE_WEIGHT[klass], ROAD_LINE_WEIGHT[klass]);

      const index = edges.length;
      edges.push({ a, b, length, klass, sampleStart, sampleCount: samples, quadStart });
      na.edges.push(index);
      nb.edges.push(index);
    }
  }

  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePoints, 3));
  lineGeometry.setAttribute('weight', new THREE.Float32BufferAttribute(lineWeights, 1));

  const roadLines = new THREE.LineSegments(lineGeometry, new THREE.ShaderMaterial({
    uniforms: trailUniforms, // shared, so the lines retint with the theme for free
    vertexShader: ROAD_LINE_VERTEX_SHADER,
    fragmentShader: ROAD_LINE_FRAGMENT_SHADER,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  roadLines.position.y = 0.14; // a hair under the trail mesh, so it never z-fights
  roadLines.renderOrder = 2;
  scene.add(roadLines);

  ROAD_CLASSES.forEach((klass, i) => {
    const count = quadCounts[i];
    if (count === 0) {
      roadLayers.push(null);
      return;
    }

    // The live simulation state: one float of heat per sample point along every
    // road. This is what the taxis write into and what decays.
    const samples = new Float32Array(sampleCounts[i]);

    // One BYTE of heat per vertex, not three floats of colour. Every hot edge
    // dirties its whole class buffer, so this array is re-uploaded to the GPU each
    // frame — at ~100k quads, colour-per-vertex meant several megabytes a frame
    // and it dragged the frame rate to a crawl. The gradient is a pure function of
    // heat, so let the fragment shader evaluate it instead of shipping the result.
    const heat = new Uint8Array(count * 8); // 8 verts × heat

    // How far up its fin a vertex sits: 0 on the tarmac, 1 at the top. Static, so
    // it uploads once and the fragment shader reads it as the fade.
    const rise = new Uint8Array(count * 8);

    const index = new Uint32Array(count * 18);
    for (let s = 0; s < count; s += 1) {
      const v = s * 8;
      const o = s * 18;

      // The ground ribbon.
      index[o] = v; index[o + 1] = v + 2; index[o + 2] = v + 1;
      index[o + 3] = v + 2; index[o + 4] = v + 3; index[o + 5] = v + 1;

      // The left fin, standing on the ribbon's left edge (verts 0 and 2)...
      index[o + 6] = v; index[o + 7] = v + 2; index[o + 8] = v + 4;
      index[o + 9] = v + 2; index[o + 10] = v + 6; index[o + 11] = v + 4;

      // ...and the right, on verts 1 and 3.
      index[o + 12] = v + 1; index[o + 13] = v + 3; index[o + 14] = v + 5;
      index[o + 15] = v + 3; index[o + 16] = v + 7; index[o + 17] = v + 5;

      rise[v + 4] = 255;
      rise[v + 5] = 255;
      rise[v + 6] = 255;
      rise[v + 7] = 255;
    }

    // BufferAttribute keeps the array we hand it. Float32BufferAttribute and
    // friends COPY it, which would leave us writing heat into an array the GPU
    // never sees.
    const heatAttribute = new THREE.BufferAttribute(heat, 1, true); // normalized: 0..255 → 0..1
    heatAttribute.setUsage(THREE.DynamicDrawUsage);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions[i], 3));
    geometry.setAttribute('heat', heatAttribute);
    geometry.setAttribute('rise', new THREE.BufferAttribute(rise, 1, true));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));

    const material = new THREE.ShaderMaterial({
      uniforms: trailUniforms, // shared by all three layers — set once, applies to all
      vertexShader: TRAIL_VERTEX_SHADER,
      fragmentShader: TRAIL_FRAGMENT_SHADER,
      transparent: true,
      // Additive so overlapping ribbons pile up into a hotter junction rather than
      // punching a hard edge through each other, and so an unlit road sinks into
      // the ground instead of sitting on it as a grey slab.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = 0.15;
    mesh.renderOrder = 2;
    scene.add(mesh);

    // Mutate the heat buffers in place rather than rebuilding them every frame.
    roadLayers.push({ mesh, material, samples, heat, attribute: heatAttribute });
  });
}

// Read the pickers' channels as *already linear* (LinearSRGBColorSpace) instead
// of letting Color.set() apply the usual sRGB→linear decode. These numbers are
// an emission ramp, not a surface albedo — decoding them would drag a mid-bright
// orange down to near-zero green and blue and the whole city would glow red.
const tailColor = new THREE.Color().setStyle(settings.trailTail, THREE.LinearSRGBColorSpace);
const headColor = new THREE.Color().setStyle(settings.trailHead, THREE.LinearSRGBColorSpace);

// Heat *is* distance behind the vehicle: the point a taxi is on right now sits at
// 1 and everything it has already left is decaying toward 0. So mapping the
// head→tail gradient onto heat gives the comet for free — hot tip in the head
// colour, cooling body fading through the tail colour, unlit road at the far end.
//
// HEAD_BIAS > 1 keeps the head colour concentrated at the very tip rather than
// smeared down the whole trail; without it the gradient's midpoint sits at the
// middle of the tail and the whole thing washes toward the head colour.
const HEAD_BIAS = 2.2;

const trailUniforms = {
  // The Color objects are mutated in place by applyTrailGradient, and a uniform
  // holding an object re-reads it every frame — so recolouring the whole network
  // costs nothing and touches no geometry.
  tail: { value: tailColor },
  head: { value: headColor },
  opacity: { value: settings.trailOpacity },
};

// How the fins shade from their base to their top.
//
// FIN_TOP is the fraction of the ground line's brightness the fin still carries at
// full height, and it is what decides whether the trail reads as a solid bar of
// light or as a glow evaporating off the tarmac. Near 0 the top dissolves; at 0.55
// the fin stays plainly lit all the way up and the trail has a body to it. Keep it
// under 1 so the very top edge still softens rather than ending on a hard line.
//
// RISE_FALLOFF shapes the ramp between the two. Below 1 the fin holds its base
// brightness most of the way up and only gives way near the top, which is what
// keeps it looking solid rather than gradient-y.
const FIN_TOP = 0.55;
const RISE_FALLOFF = 0.7;

// The cold road is not drawn by this mesh at all — it is a separate GL_LINES pass
// (see ROAD_LINE_* below), so the ribbon and its fins carry heat and nothing else.
// That is what lets an empty street be a bare 1px vector line while a travelled one
// grows a body: there is no floor here to hold the geometry visible.
//
// How bright a cold road's hairline sits, and how much of that each class gets. A
// line is a fraction of the area the old ribbon covered, so it has to be brighter
// per pixel than the 0.03 ember it replaces or the network vanishes.
const ROAD_LINE_LEVEL = 0.16;
const ROAD_LINE_WEIGHT = [1.0, 0.7, 0.45]; // motorway, primary, everything else

const TRAIL_VERTEX_SHADER = /* glsl */`
  attribute float heat;
  attribute float rise;
  varying float vHeat;
  varying float vRise;

  void main() {
    // Interpolated across the quad, so the glow ramps smoothly ALONG the road
    // between the two ends rather than the block flipping brightness as a whole.
    vHeat = heat;
    vRise = rise;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TRAIL_FRAGMENT_SHADER = /* glsl */`
  uniform vec3 tail;
  uniform vec3 head;
  uniform float opacity;
  varying float vHeat;
  varying float vRise;

  void main() {
    float h = clamp(vHeat, 0.0, 1.0);
    float t = pow(h, ${HEAD_BIAS.toFixed(1)});
    float lift = clamp(vRise, 0.0, 1.0);

    // Heat is the ONLY term. There is no floor, so an untravelled road contributes
    // nothing here and the whole third dimension belongs to the traffic: light
    // rises out of the road under a car, travels with it, and sinks back flat as
    // the trail cools. The road itself is the GL_LINES pass underneath.
    float level = h * mix(${FIN_TOP.toFixed(2)}, 1.0, pow(1.0 - lift, ${RISE_FALLOFF.toFixed(1)}));

    // No tone mapping and no colour-space conversion on the way out: these are an
    // emission ramp already in linear space, and the OutputPass tone maps the
    // whole frame at the end.
    gl_FragColor = vec4(mix(tail, head, t) * level, opacity);
  }
`;

// The road network as bare vector lines. GL_LINES are rasterised one pixel wide
// whatever the hardware, and — unlike the ribbon — that width is in SCREEN space,
// so a street stays a hairline whether you are on top of it or half a mile up. It
// is a line drawing of the city that the trails then light up.
const ROAD_LINE_VERTEX_SHADER = /* glsl */`
  attribute float weight;
  varying float vWeight;

  void main() {
    vWeight = weight;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ROAD_LINE_FRAGMENT_SHADER = /* glsl */`
  uniform vec3 tail;
  uniform float opacity;
  varying float vWeight;

  void main() {
    gl_FragColor = vec4(tail * ${ROAD_LINE_LEVEL.toFixed(2)} * vWeight, opacity);
  }
`;

function applyTrailGradient(key, hex) {
  const target = key === 'trailHead' ? headColor : tailColor;
  target.setStyle(hex, THREE.LinearSRGBColorSpace);
}

// Push an edge's sample heats out to its quads' vertices. Quad q spans samples q
// and q+1, and each of its two ends carries that sample's heat on all four of its
// vertices — two on the tarmac and two at the top of the fins. The hardware then
// interpolates between consecutive samples, so the glow ramps smoothly ALONG the
// road rather than any piece of it flipping brightness as a whole.
function paintEdge(edge) {
  const layer = roadLayers[edge.klass];
  if (!layer) return;

  const { samples, heat } = layer;
  const quads = edge.sampleCount - 1;

  for (let q = 0; q < quads; q += 1) {
    const a = samples[edge.sampleStart + q] * 255;
    const b = samples[edge.sampleStart + q + 1] * 255;
    const offset = (edge.quadStart + q) * 8;

    heat[offset] = a;
    heat[offset + 1] = a;
    heat[offset + 2] = b;
    heat[offset + 3] = b;
    heat[offset + 4] = a;
    heat[offset + 5] = a;
    heat[offset + 6] = b;
    heat[offset + 7] = b;
  }
}

// ---------------------------------------------------------------------------
// Taxis — a biased random walk over the graph. Full A* routing between fares
// would look the same from 300 units up and cost far more; what sells the image
// is continuous flow, with the arterials carrying the load.
// ---------------------------------------------------------------------------

const taxis = [];
const hotEdges = new Set();

function edgeExit(edge, fromNode) {
  return edge.a === fromNode ? edge.b : edge.a;
}

// How hard a corner is taken, from the cosine of the turn: straight on keeps full
// speed, a right-angle drops to a third of it, a U-turn crawls. This is the whole
// reason the flow reads as traffic — cars slow for their turn and wind back up out
// of it, so a stream of them bunches at the junction and stretches out along the
// straight, the way real ones do.
const cornerSpeed = (straightness) => 0.33 + 0.67 * Math.max(0, straightness);

// Metres per second squared. Braking beats acceleration, as it does in a car.
const ACCELERATION = 3.0;
const BRAKING = 7.0;

// Fractions of an edge spent winding back up out of the last corner, and easing
// down into the next one.
const CORNER_EXIT = 0.35;
const CORNER_ENTRY = 0.30;

// Some drivers stop. A light, a fare, a delivery van in the way — the cause doesn't
// matter, only that a fraction of the flow is briefly stationary at any moment while
// the rest streams past. A city where every car is permanently in motion reads as a
// mechanism; a few halted ones are what make the rest look like traffic.
//
// The trait belongs to the taxi, not the trip: only STOPPER_SHARE of them ever stop,
// so the same cars keep pulling over and the others never do. Spreading a small
// chance across all of them instead would give every car the same twitchy character,
// which is the tell we're avoiding.
const STOPPER_SHARE = 0.30;
const STOP_CHANCE = 0.14;      // per block entered, for a driver who stops at all
const STOP_SECONDS = [0.9, 3.2];

// A car needs room to brake and to pull away again. On anything shorter the stop
// lands on top of the corner it's already slowing for and just reads as a stall.
const STOP_MIN_METRES = 45;

// Where on the block it happens. Biased past the middle so most stops sit near the
// junction ahead, where a queue would form anyway, without pinning them all to it.
function rollStop(taxi, edge) {
  taxi.stopAt = null;
  taxi.halt = 0;
  if (!taxi.stopper || Math.random() > STOP_CHANCE) return;
  if (edge.length / UNITS_PER_METRE < STOP_MIN_METRES) return;

  const at = 0.45 + Math.random() * 0.45;

  // A car that crossed a junction mid-frame is already some way into this block, and
  // a stop behind it is one it can never reach — it would sit there waiting to arrive
  // at a mark it had passed. Let it run the block through instead.
  if (at <= taxi.progress) return;

  taxi.stopAt = at;
  taxi.stopFor = STOP_SECONDS[0] + Math.random() * (STOP_SECONDS[1] - STOP_SECONDS[0]);
}

// Returns the chosen edge *and* how sharp the turn onto it is, because the taxi
// needs the second number to brake on approach — before it has committed to the
// turn. Picking early and remembering the choice is also what lets it stay
// committed: re-rolling every frame would have it dithering at the junction.
function chooseNextEdge(taxi) {
  const node = nodes[taxi.node];
  const candidates = node.edges;
  if (candidates.length === 0) return null;

  const current = edges[taxi.edge];
  const from = nodes[edgeExit(current, taxi.node)];
  const inX = node.x - from.x;
  const inZ = node.z - from.z;
  const inLength = Math.hypot(inX, inZ) || 1;

  let total = 0;
  const weights = [];
  const straightnesses = [];

  for (const index of candidates) {
    const edge = edges[index];
    const next = nodes[edgeExit(edge, taxi.node)];
    const outX = next.x - node.x;
    const outZ = next.z - node.z;
    const outLength = Math.hypot(outX, outZ) || 1;

    // Prefer going straight on, and prefer the bigger road.
    const straightness = (inX * outX + inZ * outZ) / (inLength * outLength);
    let weight = Math.pow(Math.max(0.05, (straightness + 1) / 2), 3);
    weight *= [3.0, 1.6, 1.0][edge.klass];
    if (index === taxi.edge && candidates.length > 1) weight *= 0.02; // no U-turns

    weights.push(weight);
    straightnesses.push(straightness);
    total += weight;
  }

  let pick = candidates.length - 1;
  let roll = Math.random() * total;
  for (let i = 0; i < candidates.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) {
      pick = i;
      break;
    }
  }

  return { index: candidates[pick], corner: cornerSpeed(straightnesses[pick]) };
}

// The speed this taxi wants to be doing *right now* — not the speed it is doing.
// updateTaxis chases this value at a finite acceleration, and that gap between
// wanted and actual is where the fluidity comes from.
function targetSpeed(taxi, edge) {
  const cruise = ROAD_CLASSES[edge.klass].speed * taxi.cruise * (1 + taxi.drift);

  // Winding back up out of the corner just taken...
  const exit = taxi.corner + (1 - taxi.corner) * Math.min(1, taxi.progress / CORNER_EXIT);

  // ...and easing down into the one coming up. On a short block the two overlap,
  // and taking the lower of the pair means the car never accelerates into a turn
  // it is already braking for.
  const ahead = taxi.pending ? taxi.pending.corner : 1;
  const approach = (taxi.progress - (1 - CORNER_ENTRY)) / CORNER_ENTRY;
  const entry = 1 + (ahead - 1) * Math.min(1, Math.max(0, approach));

  const want = cruise * Math.min(exit, entry);
  if (taxi.stopAt === null) return want;

  // The fastest this car can be going and still be stationary by the time it reaches
  // the stop, from v² = 2as. Falling out of the same braking constant the corners
  // use means the car eases down over exactly the distance it needs and no more — a
  // fixed brake zone would either clip a stop at the end of a long block or make a
  // car on a short one drop its speed the moment it turned in.
  const metres = Math.max(0, (taxi.stopAt - taxi.progress) * edge.length / UNITS_PER_METRE);
  return Math.min(want, Math.sqrt(2 * BRAKING * metres));
}

function placeTaxi(taxi) {
  const index = Math.floor(Math.random() * edges.length);
  const edge = edges[index];
  taxi.edge = index;
  taxi.node = Math.random() < 0.5 ? edge.a : edge.b; // node it is heading toward
  taxi.progress = Math.random();
  taxi.corner = 1; // no corner was taken to get here
  taxi.pending = null;
  taxi.speed = ROAD_CLASSES[edge.klass].speed * taxi.cruise;

  // Dropped in mid-block at speed, so no stop on this one: it could land behind the
  // car, and a stop already passed would never be reached. It rolls for one at the
  // next junction like everybody else.
  taxi.stopAt = null;
  taxi.halt = 0;
}

// How fast this driver takes a road, as a fraction of what the road is worth. Two
// uniform rolls averaged is a triangular distribution — a cheap bell — so most cabs
// sit near the speed of the road and the extremes are rare. A flat uniform roll put
// as many cars at the slow end as at the middle, and a fleet where a third of the
// traffic is conspicuously dawdling doesn't read as variation, it reads as two
// separate speeds of car.
const cruiseTrait = () => 0.82 + ((Math.random() + Math.random()) / 2) * 0.36;

// On top of that fixed trait, a slow wander: ±3%, over a cycle of roughly half a
// minute. No real driver holds one speed for the length of a trip, and the frozen
// multiplier was the last thing keeping each car's motion perfectly rigid. It is
// deliberately below the threshold of being *seen* as a car speeding up — the eye
// reads it as the flow breathing rather than as any one cab doing something.
const DRIFT_AMOUNT = 0.03;
const DRIFT_PERIOD = [22, 38]; // seconds for a full cycle

// No sprite for the vehicle itself. A billboarded glow blob is a *disc* — at
// altitude it reads as a headlight, but zoomed in it is unmistakably a circle
// pasted over the road, and 650 of them strung along a street is the opposite of
// a clean Tron line. The hot leading edge of the heat trail already marks where
// each taxi is, and it's the right shape, because it *is* the road.
function spawnTaxis() {
  for (let i = 0; i < TAXI_COUNT; i += 1) {
    // `cruise` is the driver, not the trip: it belongs to the taxi for its whole
    // life rather than being re-rolled at every junction. Re-rolling made each car
    // twitch to a new speed on entering a block, which is exactly the mechanical
    // tell we are trying to get rid of.
    const taxi = {
      edge: 0, node: 0, progress: 0, speed: 0,
      cruise: cruiseTrait(),
      corner: 1,
      pending: null,

      // Each cab wanders on its own clock, from its own starting point in the cycle.
      // Sharing either would have the whole fleet surging and easing in unison — a
      // tide, not traffic.
      drift: 0,
      driftPhase: Math.random() * Math.PI * 2,
      driftRate: (Math.PI * 2) / (DRIFT_PERIOD[0] + Math.random() * (DRIFT_PERIOD[1] - DRIFT_PERIOD[0])),
      stopper: Math.random() < STOPPER_SHARE,
      stopAt: null,   // progress along the current edge to stop at, or null
      stopFor: 0,     // seconds to sit there once reached
      halt: 0,        // seconds left of the stop in progress
    };
    placeTaxi(taxi);
    taxis.push(taxi);
  }
}

// Heat laid down per second by a taxi. Deposit is per unit TIME, not per unit
// distance, so a car crawling through a turn burns its mark in harder than one
// flying down a motorway — junctions and jams glow, which is what the long-exposure
// photograph this is imitating actually does.
//
// A car now only lights the two samples it is between rather than a whole segment,
// so it has far less road to charge up and a correspondingly shorter time in which
// to do it. The rate is up to match: a taxi passing a sample point has to leave it
// saturated, or the head of the trail never reaches the hot head colour.
const HEAT_RATE = 5.0;

// `toB` is how far along the edge the car is, from its A node (0) to its B (1).
// Convert that to a position in the edge's sample array and split the deposit
// between the two samples it falls between, in proportion to how close it is to
// each. That linear split is what makes the bright spot slide *continuously* down
// the road with the car instead of hopping from sample to sample.
function depositHeat(edge, toB, amount) {
  const layer = roadLayers[edge.klass];
  if (!layer) return;

  const { samples } = layer;
  const last = edge.sampleCount - 1;

  // Clamping the index (rather than the position) keeps toB === 1 in bounds: it
  // lands on the final pair with a fraction of 1, so the whole deposit goes to the
  // last sample, which is exactly right.
  const at = toB * last;
  const i = Math.min(last - 1, Math.max(0, Math.floor(at)));
  const frac = at - i;

  const a = edge.sampleStart + i;
  samples[a] = Math.min(1, samples[a] + amount * (1 - frac));
  samples[a + 1] = Math.min(1, samples[a + 1] + amount * frac);

  hotEdges.add(edge);
}

function updateTaxis(dt) {
  for (let i = 0; i < taxis.length; i += 1) {
    const taxi = taxis[i];
    let edge = edges[taxi.edge];

    // Commit to the next turn before reaching it, so there is something to brake
    // for. The choice is made once and held until the junction is crossed.
    if (!taxi.pending) taxi.pending = chooseNextEdge(taxi);

    taxi.driftPhase += taxi.driftRate * dt;
    taxi.drift = Math.sin(taxi.driftPhase) * DRIFT_AMOUNT;

    // Sitting at a stop. It still deposits heat below — a stationary car burns its
    // mark into one spot, and that hot bead left behind on the road as it pulls away
    // is what a stopped car looks like in the long exposure this is imitating.
    if (taxi.halt > 0) {
      taxi.halt -= dt;
      taxi.speed = 0;
      depositHeat(edge, taxi.node === edge.b ? taxi.progress : 1 - taxi.progress, HEAT_RATE * dt);
      continue;
    }

    const target = targetSpeed(taxi, edge);
    const gap = target - taxi.speed;
    const rate = gap > 0 ? ACCELERATION : BRAKING;
    taxi.speed += Math.sign(gap) * Math.min(Math.abs(gap), rate * dt);

    taxi.progress += (taxi.speed * UNITS_PER_METRE * dt) / edge.length;

    // Reached the stop. Pinning progress to the mark rather than wherever the frame
    // happened to land keeps the car from creeping past it, and clearing stopAt is
    // what lets targetSpeed hand back the full cruise speed again the moment the
    // clock runs out — so it pulls away under the same acceleration it braked with.
    if (taxi.stopAt !== null && taxi.progress >= taxi.stopAt) {
      taxi.progress = taxi.stopAt;
      taxi.stopAt = null;
      taxi.speed = 0;
      taxi.halt = taxi.stopFor;
    }

    // A taxi can cross several short blocks in one frame at speed.
    let guard = 0;
    while (taxi.progress >= 1 && guard < 8) {
      guard += 1;
      const arrived = taxi.node;
      const next = taxi.pending ?? chooseNextEdge(taxi);
      if (next === null) {
        placeTaxi(taxi);
        edge = edges[taxi.edge];
        break;
      }

      // Mark the block being left all the way to its far end, or a car that
      // cleared it inside one frame would leave a trail that stops short.
      depositHeat(edge, taxi.node === edge.b ? 1 : 0, HEAT_RATE * dt);

      taxi.edge = next.index;
      taxi.corner = next.corner;
      taxi.pending = null;
      edge = edges[next.index];
      taxi.node = edgeExit(edge, arrived);
      taxi.progress -= 1;
      rollStop(taxi, edge);
    }
    if (taxi.progress >= 1) taxi.progress = 0;

    // Fraction of the way from the segment's A end to its B end. `progress` runs
    // toward whichever node the taxi happens to be heading for, which is only the
    // B end half the time.
    const toB = taxi.node === edge.b ? taxi.progress : 1 - taxi.progress;
    depositHeat(edge, toB, HEAT_RATE * dt);
  }
}

function decayHeat(dt) {
  if (hotEdges.size === 0) return;

  const halfLife = TRAIL_DECAY[settings.trailDecay] ?? TRAIL_DECAY.long;
  const decay = Math.pow(0.5, dt / halfLife);
  const touched = new Set();

  for (const edge of hotEdges) {
    const layer = roadLayers[edge.klass];
    if (!layer) continue;

    const { samples } = layer;
    const start = edge.sampleStart;
    const end = start + edge.sampleCount;

    // An edge only leaves the hot set once EVERY sample along it has gone cold —
    // one still-warm sample at the far end is a piece of trail that has to keep
    // fading, and dropping the edge early would freeze it there permanently.
    let peak = 0;
    for (let s = start; s < end; s += 1) {
      const value = samples[s] * decay;
      samples[s] = value;
      if (value > peak) peak = value;
    }

    if (peak < 0.004) {
      samples.fill(0, start, end);
      hotEdges.delete(edge);
    }

    paintEdge(edge);
    touched.add(edge.klass);
  }

  for (const klass of touched) {
    const layer = roadLayers[klass];
    if (layer) layer.attribute.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Fallback city — Overpass is rate limited and does go down. Rather than a
// blank screen, generate a grid that exercises the same code paths.
// ---------------------------------------------------------------------------

function syntheticCity() {
  const roads = [];
  const buildings = [];
  const lonStep = (BBOX.maxLon - BBOX.minLon) / 26;
  const latStep = (BBOX.maxLat - BBOX.minLat) / 40;

  for (let i = 0; i <= 26; i += 1) {
    const lon = BBOX.minLon + i * lonStep;
    const highway = i % 6 === 0 ? 'primary' : 'residential';
    roads.push({
      tags: { highway },
      geometry: [
        { lon, lat: BBOX.minLat },
        { lon, lat: BBOX.maxLat },
      ],
    });
  }

  for (let j = 0; j <= 40; j += 1) {
    const lat = BBOX.minLat + j * latStep;
    const highway = j % 8 === 0 ? 'motorway' : 'residential';
    roads.push({
      tags: { highway },
      geometry: [
        { lon: BBOX.minLon, lat },
        { lon: BBOX.maxLon, lat },
      ],
    });
  }

  for (let i = 0; i < 26; i += 1) {
    for (let j = 0; j < 40; j += 1) {
      const lon = BBOX.minLon + (i + 0.5) * lonStep;
      const lat = BBOX.minLat + (j + 0.5) * latStep;
      const w = lonStep * 0.3;
      const h = latStep * 0.3;
      buildings.push({
        tags: { height: 12 + Math.random() ** 3 * 180 },
        geometry: [
          { lon: lon - w, lat: lat - h },
          { lon: lon + w, lat: lat - h },
          { lon: lon + w, lat: lat + h },
          { lon: lon - w, lat: lat + h },
        ],
      });
    }
  }

  return { roads, buildings };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init() {
  setLoadingState(10, 'Downloading map data…');

  let data;
  try {
    data = await loadOsmData();
  } catch (error) {
    console.error('Falling back to a synthetic grid:', error);
    data = syntheticCity();
    mapSource = 'Synthetic';
  }

  // Non-fatal on purpose. A city with no river is a smaller loss than no city, and
  // the field defaults to dry land — so a dead Overpass mirror or a synthetic grid
  // just means the ground stays asphalt all the way out.
  setLoadingState(38, 'Charting the shoreline…');
  await nextFrame();
  try {
    const field = buildWaterField(await loadWaterData());
    waterUniforms.uWaterField.value = field.texture;
    waterUniforms.uFieldTexel.value.set(1 / field.texture.image.width, 1 / field.texture.image.height);

    // The one number that catches an inverted sign at a glance: Manhattan's frame is
    // about a quarter water, so a reading of 4% or 96% means the rivers came out
    // inside out and the city is under the sea.
    console.info(`Water: ${(field.coverage * 100).toFixed(1)}% of the ground plane.`);
  } catch (error) {
    console.warn('No water data; the ground stays dry:', error);
  }

  setLoadingState(45, 'Tracing the street network…');
  await nextFrame();
  buildRoadNetwork(data.roads);

  setLoadingState(65, 'Extruding buildings…');
  await nextFrame();
  await addBuildings(data.buildings);

  setLoadingState(90, 'Dispatching taxis…');
  await nextFrame();
  if (edges.length > 0) spawnTaxis();

  // `roads` counts OSM ways (a named street), `edges` counts the straight
  // segments they decompose into — the second is always much larger, and it is
  // the one that actually costs anything to draw.
  // MAX_BUILDINGS clamps what gets drawn, so a bare "9,000" would look like the
  // real count when it is actually just the cap. Say so when it bites.
  const capped = buildingCandidates > buildingCount;
  const buildings = capped
    ? `${formatNumber(buildingCount)} of ${formatNumber(buildingCandidates)}`
    : formatNumber(buildingCount);

  publishStats({
    taxis: taxis.length,
    buildings,
    roads: data.roads.length,
    segments: edges.length,
    nodes: nodes.length,
    source: mapSource,
  });

  setLoadingState(100, 'Ready');
  window.setTimeout(hideLoadingIndicator, 400);
  console.info(`${nodes.length} nodes, ${edges.length} road segments, ${taxis.length} taxis`);
}

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.05); // clamp: tab-switch stalls
  controls.update();

  waterUniforms.uWaterTime.value += dt;

  // After controls.update(), so the focus plane tracks the damped camera rather
  // than lagging a frame behind it during a drag.
  if (bokeh.enabled) {
    bokeh.uniforms.focus.value = camera.position.distanceTo(controls.target);
  }

  if (taxis.length > 0) {
    updateTaxis(dt);
    decayHeat(dt);
  }

  updateReflectionProbe(dt);
  composer.render();
  trackFps(dt);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  // The road ribbons are ordinary world-space geometry, so a resize costs them
  // nothing — the camera projection alone takes care of them.
});

// ---------------------------------------------------------------------------
// Control panel
// ---------------------------------------------------------------------------

function applySetting(key, value) {
  settings[key] = value;

  switch (key) {
    case 'exposure':
      renderer.toneMappingExposure = value;
      break;
    case 'contrast':
      contrastPass.uniforms.contrast.value = value;
      break;
    case 'bloom':
      bloom.strength = value;
      break;
    case 'depthOfField':
    case 'dofStrength':
      applyDepthOfField();
      break;
    case 'trailHead':
    case 'trailTail':
      applyTrailGradient(key, value);
      break;
    case 'trailOpacity':
      trailUniforms.opacity.value = value;
      break;
    case 'envColor':
      applyEnvironment(value);
      break;
    case 'envIntensity':
      // The ground is asphalt and water, not glass — it should stay markedly
      // duller than the towers, so it tracks the same slider at a fraction.
      applyBuildingEnvIntensity();
      groundMaterial.envMapIntensity = value * 0.44;
      break;
    case 'buildingsVisible':
      if (buildingMesh) buildingMesh.visible = value;
      if (buildingEdges) buildingEdges.visible = value && settings.showEdges;
      break;
    case 'buildingColor':
    case 'variationColorA':
    case 'variationColorB':
    case 'variationColorC':
    case 'buildingVariation':
      applyBuildingPalette();
      break;
    case 'buildingOpacity':
      applyBuildingOpacity(value);
      break;
    case 'buildingRoughness':
      if (buildingMaterial) buildingMaterial.roughness = value;
      break;
    case 'buildingGrain':
      if (buildingMaterial) buildingMaterial.bumpScale = value;
      break;
    case 'reflectTrails':
      applyReflectionProbe(value);
      break;
    case 'showEdges':
      if (buildingEdges) buildingEdges.visible = value && settings.buildingsVisible;
      break;
    case 'edgeColor':
      if (edgeMaterial) edgeMaterial.color.set(value);
      break;
    case 'background':
      // Fog has to track the background or distant geometry fades toward a
      // colour that isn't there, and the horizon shows a visible seam.
      scene.background.set(value);
      scene.fog.color.set(value);
      break;
    case 'groundColor':
      groundMaterial.color.set(value);
      // The water is the same colour as the ground, only deeper — every theme's
      // river then arrives for free, and none of them can drift out of key with the
      // city around it. What separates water from asphalt is the gloss and the
      // ripple, not the hue.
      waterUniforms.uWaterColor.value.set(value).multiplyScalar(0.55);
      break;
    case 'skyLight':
      ambient.color.set(value);
      break;
    case 'groundLight':
      ambient.groundColor.set(value);
      break;
    case 'sunColor':
      sun.color.set(value);
      break;
    case 'sunIntensity':
      sun.intensity = value;
      break;
    case 'accent':
      // The panel is styled entirely off this one custom property, so the UI
      // re-tints with the map instead of leaving orange chrome over a green city.
      document.documentElement.style.setProperty('--accent', value);
      break;
  }
}

function applyTheme(id) {
  const theme = THEMES[id];
  if (!theme) return;

  settings.theme = id;
  for (const [key, value] of Object.entries(themeValues(theme))) {
    applySetting(key, value);
  }
}

// The buttons are built from the bundles rather than written out in the markup,
// so a new theme file is the only edit needed to get a new button.
function buildThemeButtons(panel) {
  const row = panel.querySelector('.themes');

  row.replaceChildren(...THEME_LIST.map((theme) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.theme = theme.id;

    const swatch = document.createElement('i');
    swatch.style.background = theme.swatch;
    button.append(swatch, theme.label);

    return button;
  }));

  return [...row.querySelectorAll('[data-theme]')];
}

// Everything both cards do the same way: bind the [data-setting] inputs to a state
// object, keep the readouts and the filled track in step, and run the collapse
// chevrons. The cards differ only in what state they own and what applying a key
// means, so those two are the arguments — the rest would otherwise be a second copy
// drifting out of step with the first.
function wirePanel(panel, state, apply) {
  const inputs = [...panel.querySelectorAll('[data-setting]')];

  const syncInput = (input) => {
    const key = input.dataset.setting;
    const value = state[key];

    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;

    if (input.type === 'range') {
      const min = parseFloat(input.min);
      const max = parseFloat(input.max);
      const pct = ((value - min) / (max - min)) * 100;
      input.style.setProperty('--pct', `${pct}%`);
    }

    const readout = panel.querySelector(`[data-value="${key}"]`);
    if (readout) readout.textContent = Number(value).toFixed(2);
  };

  for (const input of inputs) {
    input.addEventListener('input', () => {
      const key = input.dataset.setting;
      let value;
      if (input.type === 'checkbox') value = input.checked;
      else if (input.type === 'range') value = parseFloat(input.value);
      else value = input.value;

      apply(key, value);
      syncInput(input);
    });
  }

  const toggle = panel.querySelector('.panel-toggle');
  toggle.addEventListener('click', () => {
    const collapsed = panel.toggleAttribute('data-collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.querySelector('.chevron').textContent = collapsed ? '+' : '−';
  });

  // Per-section accordions. The open/closed state is markup-driven (a
  // data-collapsed attribute in the HTML sets the defaults), so this only has to
  // keep the attribute, the chevron and aria-expanded in step.
  for (const button of panel.querySelectorAll('.section-toggle')) {
    button.addEventListener('click', () => {
      const section = button.closest('section');
      const collapsed = section.toggleAttribute('data-collapsed');
      button.setAttribute('aria-expanded', String(!collapsed));
      button.querySelector('.chev').textContent = collapsed ? '+' : '−';
    });
  }

  return { syncInputs: () => inputs.forEach(syncInput) };
}

function setupControls() {
  const panel = document.querySelector('#panel');
  const themeButtons = buildThemeButtons(panel);
  const { syncInputs } = wirePanel(panel, settings, applySetting);

  const syncAll = () => {
    syncInputs();
    themeButtons.forEach((button) => {
      button.classList.toggle('is-active', button.dataset.theme === settings.theme);
    });
  };

  for (const button of themeButtons) {
    button.addEventListener('click', () => {
      applyTheme(button.dataset.theme);
      syncAll();
    });
  }

  panel.querySelector('.panel-reset').addEventListener('click', () => {
    // Back to the theme's own baseline, not to the ember theme — "reset" should
    // undo your tweaks, not silently drag you off the palette you picked.
    applyTheme(settings.theme);
    syncAll();
  });

  syncAll();
}

function setupCamera() {
  const panel = document.querySelector('#nav');
  const { syncInputs } = wirePanel(panel, view, applyView);

  const modeButtons = [...panel.querySelectorAll('[data-drag]')];
  const hint = panel.querySelector('[data-drag-hint]');

  const setMode = (mode) => {
    applyView('dragMode', mode);
    for (const button of modeButtons) {
      button.classList.toggle('is-active', button.dataset.drag === mode);
      button.setAttribute('aria-pressed', String(button.dataset.drag === mode));
    }
    hint.textContent = DRAG_HINTS[mode];
  };

  for (const button of modeButtons) {
    button.addEventListener('click', () => setMode(button.dataset.drag));
  }

  // "Reset view" flies the camera home; it deliberately leaves the speeds and the
  // drag mode alone, because those are how you like to fly, not where you are.
  panel.querySelector('.panel-reset').addEventListener('click', resetView);

  // Push the defaults through the same path a click takes, so OrbitControls starts
  // out agreeing with what the panel is showing.
  for (const key of Object.keys(view)) applyView(key, view[key]);
  setMode(view.dragMode);
  syncInputs();
}

setupPlaceLabel();
setupStats();
setupControls();
setupCamera();
init();
animate();
