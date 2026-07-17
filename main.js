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
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

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

// Real NYC pickup demand, used to seed where taxis start their fares so the fleet's
// density matches where cabs actually work rather than being spread evenly. Source
// is the 2015 yellow-taxi trip records — the last era with true pickup lat/lon,
// before TLC anonymised locations to ~260 zones — queried live from NYC Open Data's
// Socrata API for this bbox. It's historical, not real-time (no such public feed
// exists), and carries no route, so the taxis still drive themselves; only their
// origins are data-driven. Everything degrades to the old random spawn if the fetch
// fails, exactly like the Overpass fallback.
const TAXI_DATA = {
  endpoint: 'https://data.cityofnewyork.us/resource/2yzn-sicd.json',
  limit: 30000,
  // Optional Socrata APP TOKEN — a public rate-limit identifier, safe in a browser
  // (NOT an API key secret, which a static site can't hide). Loaded from the
  // git-ignored config.local.js via window.TAXI_APP_TOKEN so it stays out of the
  // committed source; empty means anonymous, which is fine given the cache means
  // ~one request per user. Get one at data.cityofnewyork.us → sign in → profile →
  // Developer Settings → Create New App Token.
  appToken: (typeof window !== 'undefined' && window.TAXI_APP_TOKEN) || '',
};

// A taxi "completes its fare" after this many seconds and is re-placed at a fresh
// demand hotspot — what keeps the real-demand pattern anchored instead of diffusing
// away as the cars random-walk. Long and staggered, so only a handful of the fleet
// turn over per second and the churn stays invisible in aggregate. Only runs when
// live demand loaded; without it the cars flow on undisturbed as before.
const FARE_SECONDS = [120, 360];

// TAXI_COUNT is the peak fleet — the number on the road at the busiest hour. When
// live demand loads, the *active* fleet scales down from it by that hour's share of
// real trip volume, so the city thins out overnight and fills back up by evening.
// This floor keeps a few cabs roaming even at 4am rather than an empty grid.
const MIN_FLEET = 150;

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
const loaderOverlay = document.querySelector('#loader-overlay');
const loaderBar = document.querySelector('[data-loader-bar]');
const loaderPct = document.querySelector('[data-loader-pct]');
const loaderLog = document.querySelector('[data-loader-log]');
const loaderContinue = document.querySelector('#loader-continue');

const scene = new THREE.Scene();
// Seed the sky/fog from the default theme rather than a hardcoded colour, so a fresh
// load looks the same as it does after a theme switch. (They used to differ: only
// switching a theme ran applySetting('background'), so on first load the scene kept
// this near-black while every theme actually carries its own — ember's is a deep
// blue.) One source of truth = no more "the sky goes blue only after I switch".
scene.background = new THREE.Color(DEFAULT_THEME.background);
scene.fog = new THREE.FogExp2(DEFAULT_THEME.background, 0.0011);

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 1, 4000);
camera.position.set(-130, 88, 175);

const renderer = new THREE.WebGLRenderer({ antialias: true });
// Cap the render resolution below the display's native ratio. On a 2× Retina
// panel, rendering at full 2× means every post pass — RenderPass, Bokeh, Bloom,
// contrast — fills 4× the pixels, which is the dominant cost of this pipeline.
// 1.5 is the sweet spot: with MSAA and bloom softening the frame, the drop from
// 2× is nearly invisible, but it cuts pixel work by ~44%. Lower this toward 1.0
// for more speed, raise toward 2.0 for maximum sharpness.
const MAX_PIXEL_RATIO = 1.5;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;

// Soft shadows from the sun. The city and the sun are both static, so the shadow map
// is rendered once (after the buildings load) and then frozen — autoUpdate off keeps
// it off the per-frame budget entirely. PCFSoft + a small radius gives the soft edge.
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;

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

// These keys live in `view` and apply through applyView, not applySetting — but a
// theme can still carry them, so applyTheme uses this to route each key to the
// right handler and the right panel. Derived from `view` so a new camera setting
// is themeable the moment it's added there.
const VIEW_KEYS = new Set(Object.keys(view));

// Assigned by setupCamera once its panel exists. applyTheme can push camera values
// into `view` before that (nothing breaks — the sliders just sync when set up), so
// this stays a no-op until then.
let syncCameraPanel = () => {};

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

// Reset view flies the camera home rather than snapping: a cubic ease-out so it sets
// off promptly and glides to a stop at the home framing.
const RESET_DURATION = 1.1; // seconds
const easeOutCubic = (k) => 1 - Math.pow(1 - k, 3);
let resetTween = null;

function resetView() {
  resetTween = {
    fromPos: camera.position.clone(),
    toPos: HOME_VIEW.position.clone(),
    fromTarget: controls.target.clone(),
    toTarget: HOME_VIEW.target.clone(),
    elapsed: 0,
  };
  controls.enabled = false; // the tween owns the camera until it lands
}

// Advance the fly-home one frame. Returns true while running so the loop can skip
// controls.update() and let the tween drive the camera without OrbitControls fighting it.
function updateResetTween(dt) {
  if (!resetTween) return false;
  resetTween.elapsed += dt;
  const k = Math.min(1, resetTween.elapsed / RESET_DURATION);
  const e = easeOutCubic(k);
  camera.position.lerpVectors(resetTween.fromPos, resetTween.toPos, e);
  controls.target.lerpVectors(resetTween.fromTarget, resetTween.toTarget, e);
  camera.lookAt(controls.target);
  if (k >= 1) {
    resetTween = null;
    controls.enabled = true;
    controls.update(); // hand control back cleanly, now at the home framing
  }
  return true;
}

// Live-adjustable look. Everything the panel touches lives here so there is one
// place to read the current state from, and one place to persist it.
// Structural toggles live outside the theme bundles on purpose: switching palette
// should not silently turn your buildings or lights back on.
// Minutes since local midnight, 0..1439 — the unit the time-of-day slider and the
// clock display both work in.
function wallClockMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

const settings = {
  theme: DEFAULT_THEME.id,
  buildingsVisible: true,
  buildingOpacity: 1.0,
  buildingRoughness: 0.72,
  buildingMetalness: 0.15,
  // The two halves of the surface response, split out as classic diffuse/specular
  // levels. Specular scales the reflective highlight (and with it how hard the
  // trails reflect); diffuse scales the matte body independently, so you can set
  // a dark reflective clay (low diffuse, some specular) or a flat matte one.
  buildingSpecular: 1.0,
  buildingDiffuse: 1.0,
  // Sheen is the "clay" tell: a soft, broad grazing-angle glow layered over the
  // diffuse. Kept subtle — pushed hard it turns the facades milky. The colour is
  // a faint cool tone so it reads as matte solid rather than tinting the palette.
  buildingSheen: 0.4,
  // Per-theme: each theme carries its own dimmed sheen tone so the clay picks up
  // that palette's light. This is only the fallback if a theme omits it.
  buildingSheenColor: '#3d2417',
  buildingGrain: 0.35,
  buildingVariation: 0.35,
  reflectTrails: false,
  showEdges: true,
  depthOfField: true,
  dofStrength: 0.45,
  // Whether the glowing taxi trails are drawn. The dim road network stays either way.
  taxisVisible: true,
  // Read fresh every frame by decayHeat, so there is nothing to apply on change.
  trailDecay: 'long',
  trailOpacity: 0.82,
  // Time of day in minutes since midnight (0..1439). Drives which hour's real pickup
  // demand seeds the fleet and how many cabs are on the road, and shows on the clock.
  // Starts at the browser's wall-clock time; `liveTime` keeps it tracking the clock
  // until the user scrubs the slider, which switches to a frozen, manual time.
  timeOfDay: wallClockMinutes(),
  liveTime: true,
  // Density heatmap — a live choropleth painted onto the buildings from where the
  // fleets currently are. Two independent sources splat into one shared field, so
  // ticking both gives a merged taxi+bike density. A view mode, not a look, so it's
  // kept out of the themes. `heatmapGain` is the sensitivity: how much traffic a cell
  // needs before it reads as fully "hot".
  heatmapTaxi: false,
  heatmapBike: false,
  heatmapGain: 1.0,
  // Overlay data layers, also view modes kept out of the themes. Flows = origin→dropoff
  // arcs; events = 311 complaints. Both reveal by the hour on the time scrubber. Flows
  // has two independent sources (taxis, Citi Bike) sharing the width/window/opacity.
  flowsTaxi: false,
  flowsBike: false,
  flowOpacity: 0.8,
  flowWidth: 2.6,     // ribbon width in screen pixels
  flowWindow: 1.1,    // ± hours of trips shown around the clock
  events: false,
  eventOpacity: 0.9,
  eventSize: 110,     // point size in screen pixels
  eventWindow: 1.6,   // ± hours of complaints shown around the clock
  // Collisions (points), crime (points), Citi Bike (arcs) — extra datasets on the
  // reusable layer factories. Same knob shapes as their prototypes above.
  collisions: false,
  collisionSize: 120,
  collisionWindow: 1.4,
  collisionOpacity: 0.9,
  crime: false,
  crimeSize: 90,
  crimeWindow: 1.2,
  crimeOpacity: 0.85,
  // Citi Bike is a second light-trail fleet (bikes riding real start→dropoff routes),
  // so it carries the same trail controls as the taxis rather than arc controls.
  citibike: false,
  citibikeHead: '#e9fff2',
  citibikeTail: '#22c98a',
  citibikeDecay: 'long',
  citibikeOpacity: 0.85,
  // Optional wash of colour over the water (Environment section). Strength 0 = off. Each
  // theme carries its own pair; these are only the fallback if a theme omits them.
  waterTint: '#1f7fa8',
  waterTintStrength: 0.0,
  // Low-lying ground fog / mist (Environment section). Each theme carries its own set,
  // including whether it's on; these are only the fallback if a theme omits them. `fog`
  // toggles it, strength is coverage, noise is how patchy the perlin field makes it.
  fog: false,
  fogColor: '#ffffff',
  fogOpacity: 0.28,
  fogStrength: 0.06,
  fogNoise: 0.67,
  ...themeValues(DEFAULT_THEME),
};

// EffectComposer's default render target has no multisampling, which silently
// throws away the renderer's `antialias: true` the moment you post-process —
// every road line and building edge comes back stair-stepped. Hand it a 4x MSAA
// target so the lines resolve clean.
const drawSize = renderer.getDrawingBufferSize(new THREE.Vector2());
const renderTarget = new THREE.WebGLRenderTarget(drawSize.x, drawSize.y, {
  type: THREE.HalfFloatType,
  // 2× MSAA rather than 4×: the bloom and DoF already soften edges, so the second
  // doubling of samples buys little here while costing real resolve bandwidth on a
  // full-res HalfFloat target. Bump back to 4 if line edges look stair-stepped.
  samples: 2,
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

// Bloom at full render resolution — half-res saved GPU but softened the thin trail
// glows into mush, and the trails are the whole picture. Kept behind this helper (and
// re-applied after any composer.setSize) so the scale is a single number to revisit.
const BLOOM_RESOLUTION_SCALE = 1;
function applyBloomResolution() {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  bloom.setSize(
    Math.max(1, Math.round(size.x * BLOOM_RESOLUTION_SCALE)),
    Math.max(1, Math.round(size.y * BLOOM_RESOLUTION_SCALE)),
  );
}
applyBloomResolution();

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

// Cast soft shadows across the whole city. The ortho frustum is centred on the
// origin (where the city sits) and sized to cover its ~430×690-unit footprint with
// margin. normalBias keeps the flat facades free of shadow acne; radius softens the
// PCF edge. Rendered once and frozen (see renderer.shadowMap.autoUpdate above).
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -560;
sun.shadow.camera.right = 560;
sun.shadow.camera.top = 560;
sun.shadow.camera.bottom = -560;
sun.shadow.camera.near = 20;
sun.shadow.camera.far = 1200;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6;
sun.shadow.radius = 10;

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

// Smallest `natural=water` pool worth rendering, in world units² (1 unit = 10 m, so
// this is ~3 hectares). Inside this bbox the pools are fountains, memorial pools and
// dry docks — little inland patches that read as stray water lapping the city. The
// real rivers come from the coastline, not these, so anything below this is dropped.
const MIN_POOL_AREA = 300;

const waterUniforms = {
  uWaterField: { value: DRY_FIELD },
  uWaterRange: { value: WATER_RANGE },
  uWaterTime: { value: 0 },
  uWaterColor: { value: new THREE.Color('#05070c') },

  // Optional user tint laid over the water's own colour. Strength 0 leaves it untouched;
  // higher pushes the wet pixels toward uWaterTint. Kept as a mix so a strong colour at a
  // low strength reads as a wash rather than repainting the river.
  uWaterTint: { value: new THREE.Color(settings.waterTint) },
  uWaterTintStrength: { value: settings.waterTintStrength },

  // Water is a dielectric, not a mirror. Dropping metalness on the wet pixels is
  // what separates it from the asphalt: the road keeps its flat sheen, while the
  // water goes dark face-on and lights up at grazing angles, which is the whole
  // look of a river at night.
  // Roughness sets how tight the sun's reflection is: low was a hard, narrow beam,
  // so lift it a touch to spread that into a broader, softer glitter cone.
  uWaterRoughness: { value: 0.15 },
  uWaterMetalness: { value: 0.22 },

  // Wavelength of the largest swell, in world units, and how hard it tilts the
  // surface. Strength is a normal perturbation, not a displacement — the plane
  // stays flat and only the *lighting* ripples, which at this altitude is
  // indistinguishable from real chop and costs nothing in geometry.
  //
  // Tilt gently. Push it and the ripples stop scattering the reflection and start
  // shattering it, and the river turns to cottage cheese.
  uWaveScale: { value: 0.18 },
  uWaveStrength: { value: 0.34 },

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

  // Pulls the waterline back from the OSM shore by this many world units, eroding the
  // wet region evenly. OSM coastlines slop a few units into the shore-side blocks, and
  // at a grazing angle the low-roughness water reads that sliver as flooding the street.
  // Retracting it tucks the waterline back behind the bank. Applied to the land-rise
  // lift *and* the fragment wetness with the same value, so geometry and shading agree.
  uShoreBias: { value: 3.0 },

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
  shareFogUniforms(shader);

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
      uniform float uShoreBias;
      uniform vec2 uPlaneSize;
      uniform vec2 uFieldTexel;

      // Height of the land at a point, in world units above the waterline. uShoreBias
      // shifts the signed distance so the bank climbs from the retracted waterline.
      float landHeight(vec2 at) {
        float sd = (texture2D(uWaterField, at).r - 0.5) * 2.0 * uWaterRange;
        return uLandRise * smoothstep(-uBankWidth, uBankWidth, sd + uShoreBias);
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
      uniform vec3 uWaterTint;
      uniform float uWaterTintStrength;
      uniform float uWaterRoughness;
      uniform float uWaterMetalness;
      uniform float uWaveScale;
      uniform float uWaveStrength;
      uniform vec2 uWindAxis;
      uniform float uShallowFade;
      uniform float uShoreBias;

      ${FOG_FRAGMENT_CHUNK}

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
      // uShoreBias retracts the waterline into the river by that many world units, so
      // the OSM shoreline's slop never laps into the shore-side blocks.
      float waterSd = (texture2D(uWaterField, vWaterUv).r - 0.5) * 2.0 * uWaterRange + uShoreBias;

      // Half a texel of blend. The field is bilinear, so the waterline lands wherever
      // it truly falls inside the texel rather than snapping to its edge.
      float waterMask = smoothstep(1.0, -1.0, waterSd);
      diffuseColor.rgb = mix(diffuseColor.rgb, uWaterColor, waterMask);
      // User tint over the water only, scaled by strength so it stays a wash not a repaint.
      diffuseColor.rgb = mix(diffuseColor.rgb, uWaterTint, waterMask * uWaterTintStrength);
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
    `)
    // Fade the ground's outer band to the sky (fog) colour so its hard edge dissolves
    // into the background — the ground then reads as infinite, meeting the sky. vWaterUv
    // runs 0..1 across the plane and the city sits in the central ~40%, so this only
    // touches the empty rim, never the buildings.
    .replace('#include <fog_fragment>', /* glsl */`
      #include <fog_fragment>
      #ifdef USE_FOG
        vec2 groundEdge = min(vWaterUv, 1.0 - vWaterUv); // 0 at the rim, 0.5 at centre
        float groundInfinite = smoothstep(0.0, 0.28, min(groundEdge.x, groundEdge.y));
        gl_FragColor.rgb = mix(fogColor, gl_FragColor.rgb, groundInfinite);
      #endif
      // Ground sits at the street, so it's always in the mist (worldY 0 → full height factor).
      gl_FragColor.rgb = applyHeightFog(gl_FragColor.rgb, vWaterWorld, 0.0);
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
ground.receiveShadow = true;
scene.add(ground);

// ---------------------------------------------------------------------------
// Ground fog — a low-lying mist, computed per-fragment in the building and ground
// shaders (see their onBeforeCompile) rather than as a plane. Each surface fragment
// fades toward the fog colour by its world HEIGHT — full at the street, smoothly gone
// by the fog's top — so buildings dissolve into the mist at their base and rise clear
// out of it, with no hard edge. `strength` sets how high the mist rises, `opacity` how
// thick it is, `noise` how patchy the drifting perlin field makes it.
// ---------------------------------------------------------------------------
const FOG_SCALE = 0.045; // noise frequency in world units (~its patch size)
const fogUniforms = {
  uFogColor: { value: new THREE.Color(settings.fogColor) },
  uFogOpacity: { value: settings.fogOpacity },
  uFogStrength: { value: settings.fogStrength },
  uFogNoise: { value: settings.fogNoise },
  uFogTime: { value: 0 },
  uFogEnabled: { value: settings.fog ? 1 : 0 },
};

// Shared GLSL: the uniform block, a soft value-noise fbm, and the height-fog mix. Dropped
// into both the building and ground fragment shaders so they fog identically. `worldY` is
// the fragment's world height (the ground passes ~0, so it's always in the mist).
const FOG_FRAGMENT_CHUNK = /* glsl */`
  uniform vec3 uFogColor;
  uniform float uFogOpacity;
  uniform float uFogStrength;
  uniform float uFogNoise;
  uniform float uFogTime;
  uniform float uFogEnabled;
  float fogHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float fogVN(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(fogHash(i), fogHash(i + vec2(1.0, 0.0)), u.x),
               mix(fogHash(i + vec2(0.0, 1.0)), fogHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fogFBM(vec2 p) {
    float a = 0.5;
    float s = 0.0;
    for (int i = 0; i < 4; i += 1) { s += a * fogVN(p); p = p * 2.0 + 7.3; a *= 0.5; }
    return s;
  }
  vec3 applyHeightFog(vec3 col, vec2 wxz, float worldY) {
    if (uFogEnabled < 0.5) return col;
    float top = mix(4.0, 40.0, uFogStrength);          // how high the mist rises
    float hf = pow(clamp(1.0 - worldY / top, 0.0, 1.0), 1.3); // 1 at the street, 0 by the top
    float n = fogFBM(wxz * ${FOG_SCALE.toFixed(3)} + uFogTime * vec2(0.012, -0.008));
    float dens = hf * mix(1.0, n * 1.7, uFogNoise);
    float amt = clamp(dens, 0.0, 1.0) * uFogOpacity;
    return mix(col, uFogColor, amt);
  }
`;

// Hand the same uniform objects to a material's shader so one update reaches them all.
function shareFogUniforms(shader) {
  shader.uniforms.uFogColor = fogUniforms.uFogColor;
  shader.uniforms.uFogOpacity = fogUniforms.uFogOpacity;
  shader.uniforms.uFogStrength = fogUniforms.uFogStrength;
  shader.uniforms.uFogNoise = fogUniforms.uFogNoise;
  shader.uniforms.uFogTime = fogUniforms.uFogTime;
  shader.uniforms.uFogEnabled = fogUniforms.uFogEnabled;
}

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

// The clock shown two places: appended to the region label ("New York City —
// 12:59PM") and in the stats. Both read settings.timeOfDay.
function renderTimeOfDay(minutes) {
  const region = document.querySelector('[data-place-region]');
  if (region) region.textContent = `${LOCATION.region} — ${formatClock(minutes)}`;
  publishStats({ time: formatClock(minutes) });
}

// Reflect settings.timeOfDay into the slider (position + readout). Used when the live
// clock advances it, since that bypasses the slider's own input event.
function syncTimeControl() {
  const slider = document.querySelector('[data-setting="timeOfDay"]');
  if (slider) {
    slider.value = settings.timeOfDay;
    slider.style.setProperty('--pct', `${(settings.timeOfDay / 1439) * 100}%`);
  }
  const readout = document.querySelector('[data-time-readout]');
  if (readout) readout.textContent = formatClock(settings.timeOfDay);
}

// Push settings.timeOfDay through to everything that depends on it: the clock display
// and, when the hour changes, the demand-scaled fleet size. Called from the live tick
// and from the slider's applySetting.
function applyTimeOfDay() {
  renderTimeOfDay(settings.timeOfDay);
  const hour = Math.floor(settings.timeOfDay / 60);
  if (hour !== fleetHour) {
    fleetHour = hour;
    setActiveFleet(targetFleetSize());
    publishStats({ taxis: activeTaxis });
  }
  // The bike fleet follows the same clock — scale it to this hour's real ride volume.
  if (hour !== bikeFleetHour) {
    bikeFleetHour = hour;
    setBikeFleet(targetBikeFleet());
  }
}

// Once a minute of real time (while liveTime is on), advance the clock. Cheap: it
// early-returns every frame until the wall-clock minute actually rolls over.
function tickTime() {
  if (!settings.liveTime) return;
  const minutes = wallClockMinutes();
  if (minutes === settings.timeOfDay) return;
  settings.timeOfDay = minutes;
  syncTimeControl();
  applyTimeOfDay();
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
  renderTimeOfDay(settings.timeOfDay); // sets the region label with the "— 12:59PM" suffix
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

// The braille "grid of dots" spinner (as Homebrew et al use), cycled onto whatever
// log line is currently in progress.
const LOADER_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let loaderSpinnerFrame = 0;
let loaderActiveSpin = null; // the spinner <span> of the running line, or null
let loaderSpinnerTimer = 0;

if (loaderLog) {
  loaderSpinnerTimer = window.setInterval(() => {
    loaderSpinnerFrame = (loaderSpinnerFrame + 1) % LOADER_SPINNER.length;
    if (loaderActiveSpin) loaderActiveSpin.textContent = LOADER_SPINNER[loaderSpinnerFrame];
  }, 80);
}

// Tick the previous line to a green check, since a new stage means the last finished.
function completeLoaderLine() {
  if (loaderActiveSpin) {
    loaderActiveSpin.textContent = '✓';
    loaderActiveSpin.classList.add('done');
    loaderActiveSpin = null;
  }
}

// Add a terminal line: a spinning cell (unless `done`) followed by the label.
function addLoaderLine(label, done = false) {
  if (!loaderLog) return;
  const line = document.createElement('div');
  line.className = 'loader-line';
  const spin = document.createElement('span');
  spin.className = 'loader-spin';
  if (done) { spin.textContent = '✓'; spin.classList.add('done'); }
  else { spin.textContent = LOADER_SPINNER[loaderSpinnerFrame]; loaderActiveSpin = spin; }
  const text = document.createElement('span');
  text.textContent = label;
  line.append(spin, text);
  loaderLog.append(line);
  loaderLog.scrollTop = loaderLog.scrollHeight; // keep the newest line in view
}

// Each stage: fill the bar, finish the running line, and start a new one (or, at
// 100%, drop a final "Ready" line and reveal the Continue button).
function setLoadingState(progress, label) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  if (loaderBar) loaderBar.style.width = `${pct}%`;
  if (loaderPct) loaderPct.textContent = `${pct}%`;

  completeLoaderLine();
  if (pct >= 100) {
    addLoaderLine(label || 'Ready', true);
    if (loaderContinue) loaderContinue.hidden = false;
  } else {
    addLoaderLine(label);
  }
}

// Dismiss the loader and hand the scene over: fade the overlay out, swing the panels
// in, and arm the flyover. Called by the Continue button, and as the fallback if
// loading throws so the user is never trapped behind the overlay.
let sceneRevealed = false;
function revealScene() {
  if (sceneRevealed) return;
  sceneRevealed = true;
  flyoverArmed = true;
  window.clearInterval(loaderSpinnerTimer);
  document.body.classList.add('controls-revealed');
  if (loaderOverlay) {
    loaderOverlay.classList.add('is-hidden');
    window.setTimeout(() => loaderOverlay.remove(), 800);
  }
}

if (loaderContinue) loaderContinue.addEventListener('click', revealScene);

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
// Separate cache from the OSM data — different lifecycle, and clearing one shouldn't
// evict the other. Used by loadTaxiDemand.
const TAXI_CACHE_NAME = 'taxitaxi-taxidata-v1';

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

// Bundled snapshots of the map/demand data, served from our own host. Preferring
// these means a first-time visitor gets a fast, reliable load instead of each one
// hammering the live Overpass/Socrata APIs (which are slow to generate and rate
// limited). Absent files fall straight through to the live fetch, so the app works
// with or without them — run `node scripts/snapshot-data.mjs` to generate them.
const SNAPSHOT_FILES = {
  osm: 'data/osm.json',
  water: 'data/water.json',
  demand: 'data/taxi-demand.json',
  events: 'data/events-311.json',
  collisions: 'data/collisions.json',
  crime: 'data/crime.json',
  citibike: 'data/citibike.json',
};

async function loadSnapshot(path) {
  try {
    const response = await fetch(path);
    if (!response.ok) return null; // not deployed — use the live API
    return await response.json();
  } catch {
    return null;
  }
}

async function loadOsmData() {
  const snapshot = await loadSnapshot(SNAPSHOT_FILES.osm);
  if (snapshot) {
    mapSource = 'Bundled';
    return sortElements(snapshot);
  }

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

  const payload = await loadSnapshot(SNAPSHOT_FILES.water) ?? (await overpassQuery(query)).payload;
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
function buildWaterField({ shoreline, pools }, buildings = []) {
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
    // Shoelace area; skip the little fountains and memorial pools that otherwise
    // read as stray water in the middle of the city.
    let area = 0;
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a, a += 1) {
      area += (poly[b].x + poly[a].x) * (poly[b].z - poly[a].z);
    }
    if (Math.abs(area) / 2 < MIN_POOL_AREA) continue;

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

  // Buildings can't stand on water. Stamp their footprints — plus a margin that
  // reaches across the street to the next block — as firmly dry land, overriding any
  // inland swath the coastline flood mis-signed as water. This is the pool rasteriser
  // inverted: land wins (max, positive) instead of water (min, negative). The city
  // grid is dense, so the margins merge the footprints into one solid land mass, and
  // the real rivers — which carry no buildings — are left untouched.
  const LAND_STAMP_MARGIN = 6; // world units (~60 m); bridges the gaps between blocks
  const LAND_STAMP_VALUE = 8;  // decodes to comfortably dry, past the shore blend + bias
  const landPad = Math.ceil(LAND_STAMP_MARGIN / WATER_TEXEL);
  for (const b of buildings) {
    if (!b.geometry || b.geometry.length < 3) continue;
    const poly = b.geometry.map(({ lon, lat }) => toLocal(lon, lat));

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }

    const i0 = Math.max(0, Math.floor((minX / waterPlaneW + 0.5) * nx) - landPad);
    const i1 = Math.min(nx - 1, Math.ceil((maxX / waterPlaneW + 0.5) * nx) + landPad);
    const j0 = Math.max(0, Math.floor((0.5 - maxZ / waterPlaneD) * nz) - landPad);
    const j1 = Math.min(nz - 1, Math.ceil((0.5 - minZ / waterPlaneD) * nz) + landPad);

    for (let j = j0; j <= j1; j += 1) {
      for (let i = i0; i <= i1; i += 1) {
        const px = worldX(i);
        const pz = worldZ(j);

        let inside = false;
        let bankSq = Infinity;
        for (let a = 0, e = poly.length - 1; a < poly.length; e = a, a += 1) {
          const pa = poly[a];
          const pb = poly[e];
          if ((pa.z > pz) !== (pb.z > pz)
            && px < ((pb.x - pa.x) * (pz - pa.z)) / (pb.z - pa.z) + pa.x) inside = !inside;
          bankSq = Math.min(bankSq, closestOnSegment(px, pz, pa.x, pa.z, pb.x, pb.z).distSq);
        }

        if (inside || bankSq <= LAND_STAMP_MARGIN * LAND_STAMP_MARGIN) {
          signed[j * nx + i] = Math.max(signed[j * nx + i], LAND_STAMP_VALUE);
        }
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

const PROBE_INTERVAL = 0.4; // seconds (2.5 Hz) — the reflection is heavily blurred, so a lower rate is invisible and saves the 6-face cube render + PMREM 2.5×/s instead of 4×/s
const probeTarget = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
const probeCamera = new THREE.CubeCamera(1, 3000, probeTarget);
probeCamera.position.set(0, 40, 20);

const probePMREM = new THREE.PMREMGenerator(renderer);
probePMREM.compileCubemapShader();

let probeEnv = null;        // the prefiltered env texture handed to the buildings
let probeEnvTarget = null;  // the PMREM render target it lives in — reused every update
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

  // Reuse the same PMREM target every call (pass it back in) rather than letting
  // fromCubemap allocate a fresh one and disposing the old — that alloc/free churn,
  // 4×/second, was needless GPU-memory thrash and can flash a black frame on some
  // drivers.
  probeEnvTarget = probePMREM.fromCubemap(probeTarget.texture, probeEnvTarget);
  probeEnv = probeEnvTarget.texture;

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

  // MeshPhysicalMaterial is a drop-in superset of MeshStandardMaterial that adds a
  // `sheen` layer — a soft, wide grazing-angle glow that's the real "clay / matte
  // solid" tell. It stacks on top of the envMap sheen, so it's kept low here and on
  // a slider; pushed hard it turns the facades milky.
  buildingMaterial = new THREE.MeshPhysicalMaterial({
    // White: the facade colour lives in the vertex colours, which the shader
    // multiplies this by. Tinting here as well would double-apply the palette.
    color: 0xffffff,
    roughness: settings.buildingRoughness,
    metalness: settings.buildingMetalness,
    map: grain,
    bumpMap: grain,
    bumpScale: settings.buildingGrain,
    roughnessMap: buildNoiseTexture(6),
    vertexColors: true,
    // High sheenRoughness spreads the sheen into a broad matte wrap rather than a
    // tight rim, which is what reads as clay instead of satin.
    sheen: settings.buildingSheen,
    sheenRoughness: 0.9,
    sheenColor: new THREE.Color(settings.buildingSheenColor),
    // Specular level: scales the dielectric F0, so it governs both the highlight
    // and how strongly the reflected trails show. 1 is physically correct concrete;
    // toward 0 the facades go dead-matte lambert.
    specularIntensity: settings.buildingSpecular,
  });

  // Diffuse level. There's no native "diffuse intensity" in the PBR workflow —
  // diffuse is just the albedo — so patch the lighting to scale only the diffuse
  // BRDF term, leaving the specular F0 untouched. That makes Diffuse and Specular
  // genuinely independent: the matte body and the reflective sheen move separately.
  buildingMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uDiffuse = { value: settings.buildingDiffuse };
    // Density heatmap: a small live texture of where the cabs are (see updateHeatmap),
    // sampled here by world position so each facade tints up a cool→hot ramp by the
    // traffic around it. uHeatStrength eases 0→1 with the toggle so it fades in/out.
    shader.uniforms.uHeatTex = { value: heatTexture };
    shader.uniforms.uHeatStrength = { value: heatStrength };
    shader.uniforms.uHeatScale = { value: settings.heatmapGain / HEAT_REF };
    shader.uniforms.uHeatOrigin = { value: new THREE.Vector2(heatOriginX, heatOriginZ) };
    shader.uniforms.uHeatInvSpan = {
      value: new THREE.Vector2(1 / (heatCols * HEAT_CELL), 1 / (heatRows * HEAT_CELL)),
    };
    shareFogUniforms(shader);
    buildingMaterial.userData.shader = shader;

    // World position of each fragment: XZ for the density lookup, and the full vec3 so
    // the ground fog can fade the facade by its world height.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vHeatWorld;\nvarying vec3 vFogWorld;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>'
        + '\n\tvHeatWorld = (modelMatrix * vec4(transformed, 1.0)).xz;'
        + '\n\tvFogWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform float uDiffuse;
        uniform sampler2D uHeatTex;
        uniform float uHeatStrength;
        uniform float uHeatScale;
        uniform vec2 uHeatOrigin;
        uniform vec2 uHeatInvSpan;
        varying vec2 vHeatWorld;
        // Cool → hot ramp: deep blue (quiet) through teal and amber to red (busy).
        vec3 heatRamp(float t) {
          vec3 c0 = vec3(0.05, 0.13, 0.42);
          vec3 c1 = vec3(0.05, 0.55, 0.55);
          vec3 c2 = vec3(0.98, 0.72, 0.16);
          vec3 c3 = vec3(0.98, 0.22, 0.12);
          vec3 col = mix(c0, c1, smoothstep(0.0, 0.34, t));
          col = mix(col, c2, smoothstep(0.34, 0.67, t));
          col = mix(col, c3, smoothstep(0.67, 1.0, t));
          return col;
        }
        varying vec3 vFogWorld;
        ${FOG_FRAGMENT_CHUNK}
      `)
      // material.diffuseColor is populated by color_fragment (vertexColour × material
      // colour). Recolour it toward the ramp *before* lighting, so the choropleth is
      // lit and shaded like the rest of the city instead of a flat sticker. Weighting
      // by t keeps quiet blocks on their own palette and only lights up real traffic.
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        if (uHeatStrength > 0.001) {
          float dens = texture2D(uHeatTex, (vHeatWorld - uHeatOrigin) * uHeatInvSpan).r;
          float t = clamp(dens * uHeatScale, 0.0, 1.0);
          float w = smoothstep(0.0, 1.0, t) * uHeatStrength;
          diffuseColor.rgb = mix(diffuseColor.rgb, heatRamp(t), w);
        }
      `)
      .replace(
        '#include <lights_physical_fragment>',
        '#include <lights_physical_fragment>\n\tmaterial.diffuseColor *= uDiffuse;'
      )
      // Height fog last, on the lit+tone-mapped colour: the facade dissolves into the
      // mist at its base and rises clear of it, a smooth gradient with no plane edge.
      .replace(
        '#include <fog_fragment>',
        '#include <fog_fragment>\n\tgl_FragColor.rgb = applyHeightFog(gl_FragColor.rgb, vFogWorld.xz, vFogWorld.y);'
      );
  };

  buildingCount = geometries.length;

  buildingMesh = new THREE.Mesh(merged, buildingMaterial);
  buildingMesh.visible = settings.buildingsVisible;
  buildingMesh.castShadow = true;    // towers throw shadows across the streets…
  buildingMesh.receiveShadow = true; // …and onto each other
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

// Turn bias by road class (arterials pull more traffic). Hoisted so chooseNextEdge
// doesn't allocate this literal on every candidate at every junction.
const ROAD_CLASS_WEIGHT = [3.0, 1.6, 1.0];

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
const bikeLayers = []; // the Citi Bike fleet's own heat layers, same geometry

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
      bikeLayers.push(null);
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

    // The Citi Bike layer shares this class's static geometry (position/rise/index) but
    // carries its own heat channel and gradient, drawn a hair above the taxi trail so
    // the two never z-fight. Hidden until the Citi Bike toggle is on.
    const bikeHeat = new Uint8Array(count * 8);
    const bikeHeatAttribute = new THREE.BufferAttribute(bikeHeat, 1, true);
    bikeHeatAttribute.setUsage(THREE.DynamicDrawUsage);

    const bikeGeometry = new THREE.BufferGeometry();
    bikeGeometry.setAttribute('position', geometry.getAttribute('position'));
    bikeGeometry.setAttribute('heat', bikeHeatAttribute);
    bikeGeometry.setAttribute('rise', geometry.getAttribute('rise'));
    bikeGeometry.setIndex(geometry.getIndex());

    const bikeMaterial = new THREE.ShaderMaterial({
      uniforms: bikeTrailUniforms,
      vertexShader: TRAIL_VERTEX_SHADER,
      fragmentShader: TRAIL_FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const bikeMesh = new THREE.Mesh(bikeGeometry, bikeMaterial);
    bikeMesh.position.y = 0.16; // a hair above the taxi trails
    bikeMesh.renderOrder = 2;
    bikeMesh.visible = settings.citibike;
    scene.add(bikeMesh);

    bikeLayers.push({
      mesh: bikeMesh, material: bikeMaterial,
      samples: new Float32Array(sampleCounts[i]), heat: bikeHeat, attribute: bikeHeatAttribute,
    });
  });
}

// Read the pickers' channels as *already linear* (LinearSRGBColorSpace) instead
// of letting Color.set() apply the usual sRGB→linear decode. These numbers are
// an emission ramp, not a surface albedo — decoding them would drag a mid-bright
// orange down to near-zero green and blue and the whole city would glow red.
const tailColor = new THREE.Color().setStyle(settings.trailTail, THREE.LinearSRGBColorSpace);
const headColor = new THREE.Color().setStyle(settings.trailHead, THREE.LinearSRGBColorSpace);

// The Citi Bike fleet's own gradient (see the bike trail system below).
const bikeTailColor = new THREE.Color().setStyle(settings.citibikeTail, THREE.LinearSRGBColorSpace);
const bikeHeadColor = new THREE.Color().setStyle(settings.citibikeHead, THREE.LinearSRGBColorSpace);

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

// The Citi Bike fleet reuses the same trail shaders with its own gradient + opacity,
// so bike trails sit alongside the taxi trails in their own colour.
const bikeTrailUniforms = {
  tail: { value: bikeTailColor },
  head: { value: bikeHeadColor },
  opacity: { value: settings.citibikeOpacity },
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
  const target =
    key === 'trailHead' ? headColor
      : key === 'trailTail' ? tailColor
        : key === 'citibikeHead' ? bikeHeadColor
          : bikeTailColor; // citibikeTail
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

const taxis = []; // always holds TAXI_COUNT objects; only the first `activeTaxis` drive
const hotEdges = new Set();
const heatTouched = new Set(); // reused each decayHeat frame instead of a fresh Set

// How many of the fleet are currently on shift, and the hour that count was set for.
// Everything past activeTaxis is parked: not updated, laying no trail.
let activeTaxis = 0;
let fleetHour = -1;

// settings.timeOfDay drives everything time-of-day: which hour's pickups seed the
// cabs, how much of the fleet is active, and the clock. One source so they never
// disagree — it's the wall clock while liveTime is on, or the slider when it's off.
function currentHour() {
  return Math.floor(settings.timeOfDay / 60);
}

// 779 → "12:59PM", 0 → "12:00AM", 720 → "12:00PM".
function formatClock(minutes) {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const period = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')}${period}`;
}

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
    weight *= ROAD_CLASS_WEIGHT[edge.klass];
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

// ---------------------------------------------------------------------------
// Real-demand seeding. Pickups from the taxi dataset are snapped to the nearest
// road node and bucketed by hour of day; placeTaxi then starts cabs at those nodes
// weighted by how many real pickups landed there, so the fleet clusters where cabs
// actually work. Null until (and unless) the fetch succeeds — every consumer treats
// null as "fall back to the uniform-random behaviour".
// ---------------------------------------------------------------------------

let demandModel = null; // { byHour: Int32Array[24], all: Int32Array }

// Uniform bucket grid over the road nodes, so tens of thousands of pickups can be
// snapped to the graph without an N×M scan. Cell ~60 m — a block or so — so the
// 3×3 neighbourhood a lookup scans reliably contains the nearest node.
function buildNodeGrid(cellSize) {
  const grid = new Map();
  const cellKey = (cx, cz) => `${cx},${cz}`;
  for (let i = 0; i < nodes.length; i += 1) {
    const key = cellKey(Math.floor(nodes[i].x / cellSize), Math.floor(nodes[i].z / cellSize));
    const cell = grid.get(key);
    if (cell) cell.push(i);
    else grid.set(key, [i]);
  }
  return { grid, cellSize, cellKey };
}

function nearestNode(index, x, z) {
  const cx = Math.floor(x / index.cellSize);
  const cz = Math.floor(z / index.cellSize);
  let best = -1;
  let bestDist = Infinity;
  // Widen the search ring only if the inner cells came up empty (water, a park).
  for (let radius = 1; radius <= 4 && best < 0; radius += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const cell = index.grid.get(index.cellKey(cx + dx, cz + dz));
        if (!cell) continue;
        for (const i of cell) {
          const dist = (nodes[i].x - x) ** 2 + (nodes[i].z - z) ** 2;
          if (dist < bestDist) { bestDist = dist; best = i; }
        }
      }
    }
  }
  return best;
}

// Live query to NYC Open Data (Socrata). CORS-open, so it runs straight from the
// browser; the bbox filter and $limit keep it to a few MB. Returns the raw rows.
//
// The data is historical and never changes, so — like the Overpass loader — the
// first response is kept in CacheStorage and every reload after reads it off the
// disk: no multi-second fetch, and no repeat hits on Socrata's rate limit. The
// cache key is synthetic and token-free, so adding or changing the app token
// (which only affects rate limiting) never invalidates a good cached response.
async function loadTaxiDemand() {
  const snapshot = await loadSnapshot(SNAPSHOT_FILES.demand);
  if (snapshot) return snapshot;

  const where = `pickup_latitude between ${BBOX.minLat} and ${BBOX.maxLat}`
    + ` and pickup_longitude between ${BBOX.minLon} and ${BBOX.maxLon}`;
  let url = `${TAXI_DATA.endpoint}?$select=pickup_longitude,pickup_latitude,pickup_datetime`
    + `&$where=${encodeURIComponent(where)}&$limit=${TAXI_DATA.limit}`;
  if (TAXI_DATA.appToken) url += `&$$app_token=${TAXI_DATA.appToken}`;

  const cacheKey = `https://taxitaxi.local/taxidata?${BBOX.minLat},${BBOX.minLon},`
    + `${BBOX.maxLat},${BBOX.maxLon}&limit=${TAXI_DATA.limit}`;

  const cache = 'caches' in window ? await caches.open(TAXI_CACHE_NAME).catch(() => null) : null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.json();
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`taxi data HTTP ${response.status}`);
  if (cache) await cache.put(cacheKey, response.clone());
  return response.json();
}

// 311 complaints for the events overlay. Bundled-only for now — there's no live
// fallback because, unlike demand, nothing depends on it if it's missing (the layer
// just stays empty). Returns the raw rows or null.
async function loadEvents() {
  return loadSnapshot(SNAPSHOT_FILES.events);
}

// Snap every pickup to a node and index it by hour. The per-hour arrays hold one
// entry per pickup, node indices repeated by frequency — so sampling one at random
// is already weighted by real demand, no separate weight table needed.
function buildDemandModel(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || nodes.length === 0) return null;

  const grid = buildNodeGrid(6);
  const byHour = Array.from({ length: 24 }, () => []);
  const all = [];

  for (const row of rows) {
    const lon = parseFloat(row.pickup_longitude);
    const lat = parseFloat(row.pickup_latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    const local = toLocal(lon, lat);
    const node = nearestNode(grid, local.x, local.z);
    if (node < 0) continue;

    // Naive timestamps in NYC local time — the hour is chars 11–12 regardless of the
    // browser's own zone, so slice it rather than risk a Date() shifting it.
    const hour = parseInt((row.pickup_datetime || '').slice(11, 13), 10);
    all.push(node);
    if (hour >= 0 && hour < 24) byHour[hour].push(node);
  }

  if (all.length === 0) return null;

  // Each hour's pickups as a fraction of the busiest hour's — the real demand curve,
  // used to scale the active fleet. Straight from the same buckets, no extra query.
  const hourCounts = byHour.map((list) => list.length);
  const peak = Math.max(1, ...hourCounts);

  return {
    byHour: byHour.map((list) => Int32Array.from(list)),
    all: Int32Array.from(all),
    hourVolume: hourCounts.map((count) => count / peak),
  };
}

// Pick a real pickup node for the current hour (falling back to all hours if that
// bucket is thin) and hand back an edge leaving it plus the node it heads toward.
// Null whenever there's no model or the chosen node is a dead end — placeTaxi then
// keeps its old random behaviour.
function demandStart() {
  if (!demandModel) return null;

  const hourPool = demandModel.byHour[currentHour()];
  const pool = hourPool && hourPool.length > 0 ? hourPool : demandModel.all;
  if (pool.length === 0) return null;

  const nodeIndex = pool[Math.floor(Math.random() * pool.length)];
  const node = nodes[nodeIndex];
  if (!node || node.edges.length === 0) return null;

  const edgeIndex = node.edges[Math.floor(Math.random() * node.edges.length)];
  return { edge: edgeIndex, node: edgeExit(edges[edgeIndex], nodeIndex) };
}

const fareSeconds = () => FARE_SECONDS[0] + Math.random() * (FARE_SECONDS[1] - FARE_SECONDS[0]);

// How many cabs should be on the road for the current hour. Without live demand the
// whole fleet drives (no curve to scale by); with it, TAXI_COUNT × this hour's share
// of peak volume, never below the floor.
function targetFleetSize() {
  if (!demandModel) return TAXI_COUNT;
  return Math.max(MIN_FLEET, Math.round(TAXI_COUNT * demandModel.hourVolume[currentHour()]));
}

// Set how many cabs are on shift. Growing the fleet re-places the cabs coming on at a
// current-hour hotspot rather than resuming them from wherever they parked; shrinking
// it just stops updating the tail, whose trails then decay away.
function setActiveFleet(n) {
  n = Math.max(0, Math.min(taxis.length, n));
  for (let i = activeTaxis; i < n; i += 1) {
    placeTaxi(taxis[i]);
    taxis[i].fare = fareSeconds(); // fresh fare, so a returning cab doesn't re-place at once
  }
  activeTaxis = n;
}

function placeTaxi(taxi) {
  // Start on a real pickup hotspot when demand loaded; otherwise anywhere on the map.
  const start = demandStart();
  const index = start ? start.edge : Math.floor(Math.random() * edges.length);
  const edge = edges[index];
  taxi.edge = index;
  // node it is heading toward — away from the pickup when seeded, either end when not.
  taxi.node = start ? start.node : (Math.random() < 0.5 ? edge.a : edge.b);
  // Seeded cabs start near the pickup node (small progress); unseeded ones mid-block.
  taxi.progress = start ? Math.random() * 0.25 : Math.random();
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

      // Seconds until this cab finishes its fare and picks up again at a demand
      // hotspot. Seeded across the whole range so the fleet's turnover is staggered
      // from the first frame rather than all cabs respawning together. Only consumed
      // when live demand loaded.
      fare: Math.random() * FARE_SECONDS[1],
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
  for (let i = 0; i < activeTaxis; i += 1) {
    const taxi = taxis[i];

    // Fare complete: drop this cab and pick a new one up at a real hotspot. Gated on
    // demand so the fallback fleet never teleports — it just flows as it always did.
    if (demandModel) {
      taxi.fare -= dt;
      if (taxi.fare <= 0) {
        placeTaxi(taxi);
        taxi.fare = fareSeconds();
        continue;
      }
    }

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
  heatTouched.clear();

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
    heatTouched.add(edge.klass);
  }

  for (const klass of heatTouched) {
    const layer = roadLayers[klass];
    if (layer) layer.attribute.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Citi Bike — a second light-trail fleet. Same heat-on-the-network machinery as the
// taxis, but each bike rides a REAL ride: it spawns at a real start station and heads
// for that ride's drop-off station via a distance-biased walk, so the trails pile up
// on the corridors bikes actually use. Its own heat layers (bikeLayers), its own hot
// set, and its own gradient/decay controls, so it reads as bikes, not cabs.
// ---------------------------------------------------------------------------

const bikeHotEdges = new Set();
const bikeTouched = new Set();

function paintBikeEdge(edge) {
  const layer = bikeLayers[edge.klass];
  if (!layer) return;
  const { samples, heat } = layer;
  const quads = edge.sampleCount - 1;
  for (let q = 0; q < quads; q += 1) {
    const a = samples[edge.sampleStart + q] * 255;
    const b = samples[edge.sampleStart + q + 1] * 255;
    const offset = (edge.quadStart + q) * 8;
    heat[offset] = a; heat[offset + 1] = a; heat[offset + 2] = b; heat[offset + 3] = b;
    heat[offset + 4] = a; heat[offset + 5] = a; heat[offset + 6] = b; heat[offset + 7] = b;
  }
}

function depositBikeHeat(edge, toB, amount) {
  const layer = bikeLayers[edge.klass];
  if (!layer) return;
  const { samples } = layer;
  const last = edge.sampleCount - 1;
  const at = toB * last;
  const i = Math.min(last - 1, Math.max(0, Math.floor(at)));
  const frac = at - i;
  const a = edge.sampleStart + i;
  samples[a] = Math.min(1, samples[a] + amount * (1 - frac));
  samples[a + 1] = Math.min(1, samples[a + 1] + amount * frac);
  bikeHotEdges.add(edge);
}

function decayBikeHeat(dt) {
  if (bikeHotEdges.size === 0) return;
  const halfLife = TRAIL_DECAY[settings.citibikeDecay] ?? TRAIL_DECAY.long;
  const decay = Math.pow(0.5, dt / halfLife);
  bikeTouched.clear();
  for (const edge of bikeHotEdges) {
    const layer = bikeLayers[edge.klass];
    if (!layer) continue;
    const { samples } = layer;
    const start = edge.sampleStart;
    const end = start + edge.sampleCount;
    let peak = 0;
    for (let s = start; s < end; s += 1) {
      const value = samples[s] * decay;
      samples[s] = value;
      if (value > peak) peak = value;
    }
    if (peak < 0.004) { samples.fill(0, start, end); bikeHotEdges.delete(edge); }
    paintBikeEdge(edge);
    bikeTouched.add(edge.klass);
  }
  for (const klass of bikeTouched) {
    const layer = bikeLayers[klass];
    if (layer) layer.attribute.needsUpdate = true;
  }
}

// --- Bike demand: real start→drop-off pairs, snapped to graph nodes, indexed by hour.
let bikeDemand = null;
function buildBikeDemand(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || nodes.length === 0) return null;
  const grid = buildNodeGrid(6);
  const byHour = Array.from({ length: 24 }, () => []);
  const all = [];
  for (const r of rows) {
    const slon = parseFloat(r.start_lng), slat = parseFloat(r.start_lat);
    const elon = parseFloat(r.end_lng), elat = parseFloat(r.end_lat);
    if (![slon, slat, elon, elat].every(Number.isFinite)) continue;
    const s = toLocal(slon, slat);
    const e = toLocal(elon, elat);
    const startNode = nearestNode(grid, s.x, s.z);
    const destNode = nearestNode(grid, e.x, e.z);
    if (startNode < 0 || destNode < 0 || startNode === destNode) continue;
    const hour = parseInt(r.hour, 10);
    const ride = { startNode, destNode };
    all.push(ride);
    if (hour >= 0 && hour < 24) byHour[hour].push(ride);
  }
  if (all.length === 0) return null;
  const hourCounts = byHour.map((l) => l.length);
  const peak = Math.max(1, ...hourCounts);
  return { byHour, all, hourVolume: hourCounts.map((c) => c / peak) };
}

// Pick a real ride for the current hour (falling back to all hours when a bucket is thin).
function bikeRide() {
  if (!bikeDemand) return null;
  const pool = bikeDemand.byHour[currentHour()];
  const use = pool && pool.length ? pool : bikeDemand.all;
  return use.length ? use[Math.floor(Math.random() * use.length)] : null;
}

// --- Bike fleet -----------------------------------------------------------
const BIKE_COUNT = 700;        // pool size; the active count scales with the hour
const MIN_BIKE_FLEET = 70;
const BIKE_SPEED_MPS = 4.6;    // ~16 km/h — noticeably slower than the cabs
const BIKE_MAX_LIFE = 45;      // seconds before a stuck bike gives up and re-rides
const BIKE_DEST_BIAS = 3.0;    // higher = more directly it heads for the drop-off

const bikes = [];
let activeBikes = 0;
let bikeFleetHour = -1;

function placeBike(bike) {
  const ride = bikeRide();
  bike.pending = null;
  bike.speed = BIKE_SPEED_MPS * bike.cruise;
  bike.life = BIKE_MAX_LIFE;
  if (ride && nodes[ride.startNode] && nodes[ride.startNode].edges.length > 0) {
    const node = nodes[ride.startNode];
    const edgeIndex = node.edges[Math.floor(Math.random() * node.edges.length)];
    bike.edge = edgeIndex;
    bike.node = edgeExit(edges[edgeIndex], ride.startNode); // heading away from the station
    bike.dest = ride.destNode;
    bike.progress = Math.random() * 0.15;
    return;
  }
  // No demand (or a dead-end station) — fall back to a random block and target.
  const index = Math.floor(Math.random() * edges.length);
  const edge = edges[index];
  bike.edge = index;
  bike.node = Math.random() < 0.5 ? edge.a : edge.b;
  bike.dest = Math.random() < 0.5 ? edge.a : edge.b;
  bike.progress = Math.random();
}

// The destination-biased pick: among the edges leaving a junction, favour the one that
// most reduces the straight-line distance to the drop-off, with a nudge for going
// straight and a little randomness so a whole hour's bikes don't overlay one path.
function chooseBikeEdge(bike) {
  const node = nodes[bike.node];
  const candidates = node.edges;
  if (candidates.length === 0) return null;
  const dest = nodes[bike.dest];
  const curD = Math.hypot(node.x - dest.x, node.z - dest.z) || 1;

  const current = edges[bike.edge];
  const from = nodes[edgeExit(current, bike.node)];
  const inX = node.x - from.x, inZ = node.z - from.z;
  const inLen = Math.hypot(inX, inZ) || 1;

  let total = 0;
  const weights = [];
  for (let k = 0; k < candidates.length; k += 1) {
    const index = candidates[k];
    const edge = edges[index];
    const next = nodes[edgeExit(edge, bike.node)];
    const outX = next.x - node.x, outZ = next.z - node.z;
    const outLen = Math.hypot(outX, outZ) || 1;
    const nextD = Math.hypot(next.x - dest.x, next.z - dest.z);
    const gain = (curD - nextD) / outLen;           // toward-dest progress, ~[-1, 1]
    const straightness = (inX * outX + inZ * outZ) / (inLen * outLen);
    let weight = Math.exp(gain * BIKE_DEST_BIAS) * (0.4 + 0.6 * Math.max(0, straightness) + 0.15);
    if (index === bike.edge && candidates.length > 1) weight *= 0.02; // no U-turns
    weights.push(weight);
    total += weight;
  }

  let pick = candidates.length - 1;
  let roll = Math.random() * total;
  for (let k = 0; k < candidates.length; k += 1) {
    roll -= weights[k];
    if (roll <= 0) { pick = k; break; }
  }
  return { index: candidates[pick] };
}

function updateBikes(dt) {
  for (let i = 0; i < activeBikes; i += 1) {
    const bike = bikes[i];
    bike.life -= dt;
    if (bike.life <= 0) { placeBike(bike); continue; }

    let edge = edges[bike.edge];
    if (!bike.pending) bike.pending = chooseBikeEdge(bike);

    bike.progress += (bike.speed * UNITS_PER_METRE * dt) / edge.length;

    let guard = 0;
    while (bike.progress >= 1 && guard < 8) {
      guard += 1;
      const arrived = bike.node;
      if (arrived === bike.dest) { placeBike(bike); edge = edges[bike.edge]; break; } // ride done
      const next = bike.pending ?? chooseBikeEdge(bike);
      if (next === null) { placeBike(bike); edge = edges[bike.edge]; break; }
      depositBikeHeat(edge, bike.node === edge.b ? 1 : 0, HEAT_RATE * dt);
      bike.edge = next.index;
      bike.pending = null;
      edge = edges[next.index];
      bike.node = edgeExit(edge, arrived);
      bike.progress -= 1;
    }
    if (bike.progress >= 1) bike.progress = 0;

    const toB = bike.node === edge.b ? bike.progress : 1 - bike.progress;
    depositBikeHeat(edge, toB, HEAT_RATE * dt);
  }
}

function targetBikeFleet() {
  if (!bikeDemand) return 0;
  return Math.max(MIN_BIKE_FLEET, Math.round(BIKE_COUNT * bikeDemand.hourVolume[currentHour()]));
}

function setBikeFleet(n) {
  n = Math.max(0, Math.min(bikes.length, n));
  for (let i = activeBikes; i < n; i += 1) placeBike(bikes[i]);
  activeBikes = n;
}

function spawnBikes() {
  for (let i = 0; i < BIKE_COUNT; i += 1) {
    const bike = { edge: 0, node: 0, dest: 0, progress: 0, speed: 0, cruise: cruiseTrait(), pending: null, life: 0 };
    placeBike(bike);
    bikes.push(bike);
  }
}

// ---------------------------------------------------------------------------
// Taxi density heatmap — a live choropleth painted onto the buildings.
//
// Every active cab is splatted into a coarse grid over the map each tick, with a
// short decay so the field tracks where traffic *is right now*. That grid is a
// small float texture the building shader samples by world position (see the
// building onBeforeCompile): each facade tints from its own colour up a cool→hot
// ramp by the density around it. So it adapts continuously as cabs move, and
// shifts the moment the hour scrubber re-seeds the fleet from a different hour's
// demand. It rides on the buildings — hide them and there's nothing to paint —
// and toggling it off eases the ramp back to the normal palette.
// ---------------------------------------------------------------------------

const HEAT_CELL = 12;        // world units per cell (~120 m) — reads as an area, not a single street
const HEAT_REF = 3.0;        // cabs-per-cell that maps to the hottest colour (scaled by heatmapGain)
const HEAT_INTERVAL = 0.1;   // seconds between grid updates — 10 Hz is plenty for a soft field
const HEAT_HALFLIFE = 1.6;   // seconds for a cell to forget a cab that has moved on

const heatCols = Math.max(8, Math.round(groundSpanX / HEAT_CELL));
const heatRows = Math.max(8, Math.round(groundSpanZ / HEAT_CELL));
const heatOriginX = -groundSpanX / 2;
const heatOriginZ = -groundSpanZ / 2;
const heatDensity = new Float32Array(heatCols * heatRows);
const heatTexture = new THREE.DataTexture(
  heatDensity, heatCols, heatRows, THREE.RedFormat, THREE.FloatType,
);
heatTexture.minFilter = THREE.LinearFilter;
heatTexture.magFilter = THREE.LinearFilter;
heatTexture.wrapS = THREE.ClampToEdgeWrapping;
heatTexture.wrapT = THREE.ClampToEdgeWrapping;
heatTexture.needsUpdate = true;

let heatClock = 0;
let heatStrength = 0;        // eased 0..1, follows the heatmap toggles so it fades in/out

// Splat one cab into the grid with bilinear spread, so the field doesn't shimmer
// as cabs cross cell boundaries.
function heatSplat(x, z, amount) {
  const fx = (x - heatOriginX) / HEAT_CELL - 0.5;
  const fz = (z - heatOriginZ) / HEAT_CELL - 0.5;
  const i0 = Math.floor(fx);
  const j0 = Math.floor(fz);
  const tx = fx - i0;
  const tz = fz - j0;
  for (let dj = 0; dj <= 1; dj += 1) {
    const j = j0 + dj;
    if (j < 0 || j >= heatRows) continue;
    const wj = (dj ? tz : 1 - tz) * amount;
    for (let di = 0; di <= 1; di += 1) {
      const i = i0 + di;
      if (i < 0 || i >= heatCols) continue;
      heatDensity[j * heatCols + i] += (di ? tx : 1 - tx) * wj;
    }
  }
}

// Splat one fleet's active agents (taxis or bikes) into the shared density grid. Both
// write into the same field, so ticking both boxes gives a single merged heatmap.
function splatFleet(fleet, count, add) {
  for (let t = 0; t < count; t += 1) {
    const agent = fleet[t];
    const edge = edges[agent.edge];
    if (!edge) continue;
    const a = nodes[edge.a];
    const b = nodes[edge.b];
    const toB = agent.node === edge.b ? agent.progress : 1 - agent.progress;
    heatSplat(a.x + (b.x - a.x) * toB, a.z + (b.z - a.z) * toB, add);
  }
}

function updateHeatmap(dt) {
  // The choropleth shows if either source is on; it splats whichever are ticked into
  // one shared grid (so both = a merged taxi+bike density).
  const anyOn = settings.heatmapTaxi || settings.heatmapBike;
  const target = anyOn ? 1 : 0;
  heatStrength += (target - heatStrength) * Math.min(1, dt * 6);
  const shader = buildingMaterial && buildingMaterial.userData.shader;
  if (shader && shader.uniforms.uHeatStrength) {
    shader.uniforms.uHeatStrength.value = heatStrength;
    shader.uniforms.uHeatScale.value = settings.heatmapGain / HEAT_REF;
  }

  // Fully off and idle: don't spend anything binning agents into a field no one sees.
  if (!anyOn && heatStrength < 0.001) return;

  heatClock += dt;
  if (heatClock < HEAT_INTERVAL) return;
  const step = heatClock;
  heatClock = 0;

  const decay = Math.pow(0.5, step / HEAT_HALFLIFE);
  for (let i = 0; i < heatDensity.length; i += 1) heatDensity[i] *= decay;

  // Adding (1 - decay) per tick makes a cell an agent never leaves settle at ~1, so the
  // stored value reads as "agents currently dwelling here" and HEAT_REF is in agent units.
  const add = 1 - decay;
  if (settings.heatmapTaxi) splatFleet(taxis, activeTaxis, add);
  if (settings.heatmapBike) splatFleet(bikes, activeBikes, add);
  heatTexture.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Overlay layers — flows and events. Both are geolocated + timestamped, so both
// hang off one fractional "current hour" uniform (settings.timeOfDay / 60): the
// time scrubber sweeps them, and only the traffic/complaints near that hour show.
//
//   Flows  — every trip drawn as a pickup→dropoff arc arcing over the city, with
//            a travelling glow from origin to destination.
//   Events — 311 complaints as glowing points, coloured by category, that surface
//            at the hour they were logged.
//
// The whole dataset lives in one static geometry each; the hour filter is done in
// the shader (an alpha window on circular hour-distance), so scrubbing time costs
// nothing but a uniform write — no geometry rebuilds.
// ---------------------------------------------------------------------------

let overlayTime = 0;

// --- Flows: pickup → dropoff arcs -----------------------------------------
let flowsMesh = null;
let flowsMat = null;
// --- Flow-arc build-time knobs (a rebuild — reload — picks up changes) ------
const FLOW_MAX = 6000;         // arcs kept (sampled evenly across the day) — plenty, stays light
const FLOW_SEGMENTS = 20;      // straight pieces per arc; enough to read as a smooth curve
const FLOW_ARCH_BASE = 10;     // apex height (world units) for the shortest kept trip…
const FLOW_ARCH_RATE = 0.9;    // …plus this much per unit of trip length…
const FLOW_ARCH_MAX = 70;      // …capped here, so cross-town runs don't shoot into orbit

function buildFlows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;

  // Keep trips whose dropoff lands on the visible map (drop the JFK/uptown runs that
  // would shoot off to infinity), then sample down to FLOW_MAX evenly across the list
  // — which, because the file is ordered by hour, keeps every hour represented.
  const extentX = groundSpanX * 0.92;
  const extentZ = groundSpanZ * 0.92;
  const trips = [];
  for (const r of rows) {
    const dLon = parseFloat(r.dropoff_longitude);
    const dLat = parseFloat(r.dropoff_latitude);
    if (!Number.isFinite(dLon) || !Number.isFinite(dLat)) continue;
    const hour = parseInt((r.pickup_datetime || '').slice(11, 13), 10);
    if (!(hour >= 0 && hour < 24)) continue;
    const p = toLocal(parseFloat(r.pickup_longitude), parseFloat(r.pickup_latitude));
    const d = toLocal(dLon, dLat);
    if (Math.abs(d.x) > extentX || Math.abs(d.z) > extentZ) continue;
    const dist = Math.hypot(d.x - p.x, d.z - p.z);
    if (dist < 3) continue; // ignore round-the-corner hops — no arc worth drawing
    trips.push({ p, d, dist, hour });
  }
  if (trips.length === 0) return;

  let picked = trips;
  if (trips.length > FLOW_MAX) {
    picked = [];
    const stride = trips.length / FLOW_MAX;
    for (let i = 0; i < FLOW_MAX; i += 1) picked.push(trips[Math.floor(i * stride)]);
  }

  // Fat lines (LineSegments2) are instanced: one quad per straight segment, expanded to
  // a ribbon of `linewidth` pixels in the vertex shader. So the geometry is a flat list
  // of segment endpoint pairs (setPositions), plus one value per segment for the hour,
  // a per-arc random seed, and the arc-parameter at each end (for the travelling pulse).
  const segCount = picked.length * FLOW_SEGMENTS;
  const positions = new Float32Array(segCount * 6); // start xyz, end xyz per segment
  const aHour = new Float32Array(segCount);
  const aSeed = new Float32Array(segCount);
  const aT0 = new Float32Array(segCount);
  const aT1 = new Float32Array(segCount);
  let seg = 0;

  for (const t of picked) {
    const seed = Math.random();
    const mx = (t.p.x + t.d.x) / 2;
    const mz = (t.p.z + t.d.z) / 2;
    // Control-point height ∝ trip length, so cross-town runs arch higher than hops.
    const ctrlY = 0.3 + Math.min(FLOW_ARCH_MAX, FLOW_ARCH_BASE + t.dist * FLOW_ARCH_RATE);
    const px = new Array(FLOW_SEGMENTS + 1);
    const py = new Array(FLOW_SEGMENTS + 1);
    const pz = new Array(FLOW_SEGMENTS + 1);
    for (let s = 0; s <= FLOW_SEGMENTS; s += 1) {
      const u = s / FLOW_SEGMENTS;
      const omu = 1 - u;
      // Quadratic Bézier; only the middle term carries the lift, so both ends sit on
      // the ground and the arc bows up between them.
      px[s] = omu * omu * t.p.x + 2 * omu * u * mx + u * u * t.d.x;
      py[s] = omu * omu * 0.3 + 2 * omu * u * ctrlY + u * u * 0.3;
      pz[s] = omu * omu * t.p.z + 2 * omu * u * mz + u * u * t.d.z;
    }
    for (let s = 0; s < FLOW_SEGMENTS; s += 1) {
      const o = seg * 6;
      positions[o] = px[s]; positions[o + 1] = py[s]; positions[o + 2] = pz[s];
      positions[o + 3] = px[s + 1]; positions[o + 4] = py[s + 1]; positions[o + 5] = pz[s + 1];
      aHour[seg] = t.hour;
      aSeed[seg] = seed;
      aT0[seg] = s / FLOW_SEGMENTS;
      aT1[seg] = (s + 1) / FLOW_SEGMENTS;
      seg += 1;
    }
  }

  const geo = new LineSegmentsGeometry();
  geo.setPositions(positions);
  geo.setAttribute('aHour', new THREE.InstancedBufferAttribute(aHour, 1));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 1));
  geo.setAttribute('aT0', new THREE.InstancedBufferAttribute(aT0, 1));
  geo.setAttribute('aT1', new THREE.InstancedBufferAttribute(aT1, 1));

  // Screen-space width (constant pixels regardless of zoom) keeps the ribbons legible.
  flowsMat = new LineMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    worldUnits: false,
    linewidth: settings.flowWidth,
  });
  flowsMat.resolution.set(window.innerWidth, window.innerHeight);

  // Custom uniforms — LineMaterial is a ShaderMaterial, so add ours to its uniform set
  // and patch its shader strings. Named uFlowOpacity to avoid clashing with the
  // material's own `opacity`.
  Object.assign(flowsMat.uniforms, {
    uHour: { value: 12 },
    uWindow: { value: settings.flowWindow },
    uTime: { value: 0 },
    uFlowOpacity: { value: settings.flowOpacity },
    uColorA: { value: new THREE.Color('#38d6ff') }, // origin — cool
    uColorB: { value: new THREE.Color('#ff8a3d') }, // destination — warm
  });

  // `position.y < 0.5` is how LineMaterial's quad picks the start vs end endpoint —
  // reuse it to hand the right arc-parameter to each end.
  flowsMat.vertexShader = flowsMat.vertexShader.replace('void main() {', /* glsl */`
    attribute float aHour;
    attribute float aSeed;
    attribute float aT0;
    attribute float aT1;
    varying float vHour;
    varying float vSeed;
    varying float vArc;
    void main() {
      vHour = aHour;
      vSeed = aSeed;
      vArc = ( position.y < 0.5 ) ? aT0 : aT1;
  `);

  flowsMat.fragmentShader = flowsMat.fragmentShader
    .replace('void main() {', /* glsl */`
      uniform float uHour;
      uniform float uWindow;
      uniform float uTime;
      uniform float uFlowOpacity;
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      varying float vHour;
      varying float vSeed;
      varying float vArc;
      void main() {
    `)
    // Override LineMaterial's flat colour with the hour window + gradient + a bright
    // head travelling origin→destination, keeping its anti-aliased coverage `alpha`.
    .replace('vec4 diffuseColor = vec4( diffuse, alpha );', /* glsl */`
      float _hd = abs( vHour - uHour );
      _hd = min( _hd, 24.0 - _hd );          // clock wraps at midnight
      float _vis = smoothstep( uWindow, 0.0, _hd );
      if ( _vis <= 0.001 ) discard;
      float _head = fract( uTime * 0.22 + vSeed );
      float _pulse = smoothstep( 0.14, 0.0, abs( vArc - _head ) );
      vec3 _col = mix( uColorA, uColorB, vArc ) * ( 0.35 + _pulse * 1.7 );
      alpha *= _vis * uFlowOpacity * ( 0.45 + _pulse );
      vec4 diffuseColor = vec4( _col, alpha );
    `);
  flowsMat.needsUpdate = true;

  flowsMesh = new LineSegments2(geo, flowsMat);
  flowsMesh.visible = settings.flowsTaxi;
  flowsMesh.frustumCulled = false; // arcs span the whole map; never cull the batch
  flowsMesh.renderOrder = 3;
  scene.add(flowsMesh);
}

// --- Events: 311 complaints as points -------------------------------------
let eventsMesh = null;
let eventsMat = null;

// Fold ~200 raw complaint types into a handful of readable, fixed-colour categories.
// Order matters: first match wins, so the specific tests come before the catch-all.
const EVENT_CATEGORIES = [
  { name: 'Noise', color: '#ff3d81', test: (t) => /noise/i.test(t) },
  { name: 'Vehicle', color: '#ffb020', test: (t) => /parking|vehicle|traffic|blocked|obstruction/i.test(t) },
  { name: 'Street life', color: '#2ad0d0', test: (t) => /encampment|homeless|panhandl|vendor/i.test(t) },
  { name: 'Buildings', color: '#7bd63a', test: (t) => /construction|plumbing|heat|water|sanitation|dirty|graffiti|condition/i.test(t) },
  { name: 'Other', color: '#c9c9d6', test: () => true },
];
const eventCategory = (type) => {
  const t = type || '';
  for (let i = 0; i < EVENT_CATEGORIES.length; i += 1) if (EVENT_CATEGORIES[i].test(t)) return i;
  return EVENT_CATEGORIES.length - 1;
};

function buildEvents(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;

  const pos = [];
  const aHour = [];
  const aCat = [];
  const aSeed = [];
  for (const r of rows) {
    const lon = parseFloat(r.longitude);
    const lat = parseFloat(r.latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const hour = parseInt((r.created_date || '').slice(11, 13), 10);
    if (!(hour >= 0 && hour < 24)) continue;
    const l = toLocal(lon, lat);
    pos.push(l.x, 2.0, l.z); // lifted just off the street so the glow clears the roads
    aHour.push(hour);
    aCat.push(eventCategory(r.complaint_type));
    aSeed.push(Math.random());
  }
  if (pos.length === 0) return;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aHour', new THREE.Float32BufferAttribute(aHour, 1));
  geo.setAttribute('aCat', new THREE.Float32BufferAttribute(aCat, 1));
  geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(aSeed, 1));

  const cat = EVENT_CATEGORIES.map((c) => new THREE.Color(c.color));
  eventsMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uHour: { value: 12 },
      uWindow: { value: 1.6 },   // complaints are sparse, so a wider window keeps company
      uTime: { value: 0 },
      uSize: { value: 110 },
      uOpacity: { value: settings.eventOpacity },
      uCat0: { value: cat[0] }, uCat1: { value: cat[1] }, uCat2: { value: cat[2] },
      uCat3: { value: cat[3] }, uCat4: { value: cat[4] },
    },
    vertexShader: /* glsl */`
      attribute float aHour;
      attribute float aCat;
      attribute float aSeed;
      uniform float uHour, uWindow, uTime, uSize;
      varying float vCat;
      varying float vVis;
      void main() {
        vCat = aCat;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = abs(aHour - uHour);
        d = min(d, 24.0 - d);
        vVis = smoothstep(uWindow, 0.0, d);
        float breathe = 0.85 + 0.15 * sin(uTime * 2.2 + aSeed * 6.2831);
        gl_PointSize = uSize * (0.35 + 1.15 * vVis) * breathe * (300.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      precision mediump float;
      uniform float uOpacity;
      uniform vec3 uCat0, uCat1, uCat2, uCat3, uCat4;
      varying float vCat;
      varying float vVis;
      void main() {
        if (vVis <= 0.001) discard;
        float dd = length(gl_PointCoord - 0.5);
        if (dd > 0.5) discard;
        float core = smoothstep(0.5, 0.0, dd);   // soft disc with a bright centre
        vec3 c = vCat < 0.5 ? uCat0 : vCat < 1.5 ? uCat1 : vCat < 2.5 ? uCat2 : vCat < 3.5 ? uCat3 : uCat4;
        gl_FragColor = vec4(c * (0.35 + core * 1.7), core * vVis * uOpacity);
      }
    `,
  });

  eventsMesh = new THREE.Points(geo, eventsMat);
  eventsMesh.visible = settings.events;
  eventsMesh.frustumCulled = false;
  eventsMesh.renderOrder = 4;
  scene.add(eventsMesh);
}

// Drive both overlays from the clock each frame: same fractional hour, shared anim time.
function updateOverlays(dt) {
  overlayTime += dt;
  const hour = settings.timeOfDay / 60;
  if (flowsMesh && flowsMesh.visible) {
    flowsMat.uniforms.uHour.value = hour;
    flowsMat.uniforms.uTime.value = overlayTime;
    flowsMat.uniforms.uWindow.value = settings.flowWindow;
    flowsMat.uniforms.uFlowOpacity.value = settings.flowOpacity;
    flowsMat.linewidth = settings.flowWidth;
  }
  if (eventsMesh && eventsMesh.visible) {
    eventsMat.uniforms.uHour.value = hour;
    eventsMat.uniforms.uTime.value = overlayTime;
    eventsMat.uniforms.uWindow.value = settings.eventWindow;
    eventsMat.uniforms.uSize.value = settings.eventSize;
    eventsMat.uniforms.uOpacity.value = settings.eventOpacity;
  }
  // The extra datasets (collisions, crime, Citi Bike) go through the registry.
  for (const layer of overlayLayers) {
    if (!layer.mesh.visible) continue;
    const u = layer.material.uniforms;
    u.uHour.value = hour;
    u.uTime.value = overlayTime;
    u.uWindow.value = settings[layer.keys.window];
    if (layer.kind === 'arc') {
      u.uFlowOpacity.value = settings[layer.keys.opacity];
      layer.material.linewidth = settings[layer.keys.width];
    } else {
      u.uSize.value = settings[layer.keys.size];
      u.uOpacity.value = settings[layer.keys.opacity];
    }
  }
}

// ---------------------------------------------------------------------------
// Reusable layer factories. Flows and 311 above were the prototypes; these are the
// generalised versions the extra datasets ride on, so adding collisions, crime or
// Citi Bike is a config block (accessors + colours + which settings keys tune it),
// not new rendering. Each registers in overlayLayers so updateOverlays/applySetting
// drive and toggle them generically.
// ---------------------------------------------------------------------------

const overlayLayers = [];
function registerOverlay(layer) {
  overlayLayers.push(layer);
  scene.add(layer.mesh);
  return layer;
}

// Point layer (311, collisions, crime): glowing category-coloured points that surface
// at their hour. config: lon/lat/hour/category accessors, a colours array, settings keys.
function buildPointLayer(rows, config) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const cfg = { y: 2.0, renderOrder: 4, ...config };

  const pos = [];
  const aHour = [];
  const aCat = [];
  const aSeed = [];
  for (const r of rows) {
    const lon = cfg.lon(r);
    const lat = cfg.lat(r);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const hour = cfg.hour(r);
    if (!(hour >= 0 && hour < 24)) continue;
    const l = toLocal(lon, lat);
    pos.push(l.x, cfg.y, l.z); // lifted just off the street so the glow clears the roads
    aHour.push(hour);
    aCat.push(cfg.category(r));
    aSeed.push(Math.random());
  }
  if (pos.length === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aHour', new THREE.Float32BufferAttribute(aHour, 1));
  geo.setAttribute('aCat', new THREE.Float32BufferAttribute(aCat, 1));
  geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(aSeed, 1));

  // Up to six fixed category colours, passed as separate uniforms (a ternary chain picks
  // one) so this compiles on GLSL1 — dynamic uniform-array indexing needs GLSL3.
  const c = [];
  for (let i = 0; i < 6; i += 1) c.push(new THREE.Color(cfg.colors[Math.min(i, cfg.colors.length - 1)]));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uHour: { value: 12 },
      uWindow: { value: settings[cfg.keys.window] },
      uTime: { value: 0 },
      uSize: { value: settings[cfg.keys.size] },
      uOpacity: { value: settings[cfg.keys.opacity] },
      uC0: { value: c[0] }, uC1: { value: c[1] }, uC2: { value: c[2] },
      uC3: { value: c[3] }, uC4: { value: c[4] }, uC5: { value: c[5] },
    },
    vertexShader: /* glsl */`
      attribute float aHour;
      attribute float aCat;
      attribute float aSeed;
      uniform float uHour, uWindow, uTime, uSize;
      varying float vCat;
      varying float vVis;
      void main() {
        vCat = aCat;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = abs(aHour - uHour);
        d = min(d, 24.0 - d);
        vVis = smoothstep(uWindow, 0.0, d);
        float breathe = 0.85 + 0.15 * sin(uTime * 2.2 + aSeed * 6.2831);
        gl_PointSize = uSize * (0.35 + 1.15 * vVis) * breathe * (300.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      precision mediump float;
      uniform float uOpacity;
      uniform vec3 uC0, uC1, uC2, uC3, uC4, uC5;
      varying float vCat;
      varying float vVis;
      void main() {
        if (vVis <= 0.001) discard;
        float dd = length(gl_PointCoord - 0.5);
        if (dd > 0.5) discard;
        float core = smoothstep(0.5, 0.0, dd);   // soft disc with a bright centre
        vec3 col = vCat < 0.5 ? uC0 : vCat < 1.5 ? uC1 : vCat < 2.5 ? uC2 : vCat < 3.5 ? uC3 : vCat < 4.5 ? uC4 : uC5;
        gl_FragColor = vec4(col * (0.35 + core * 1.7), core * vVis * uOpacity);
      }
    `,
  });

  const mesh = new THREE.Points(geo, mat);
  mesh.visible = settings[cfg.keys.visible];
  mesh.frustumCulled = false;
  mesh.renderOrder = cfg.renderOrder;
  return registerOverlay({ mesh, material: mat, kind: 'point', keys: cfg.keys });
}

// Arc layer (Citi Bike): same instanced fat-line technique as trip flows, generalised.
// config: origin/dest/hour accessors, two ramp colours, arch shape, settings keys.
function buildArcLayer(rows, config) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const cfg = {
    extentFactor: 0.92, archBase: FLOW_ARCH_BASE, archRate: FLOW_ARCH_RATE,
    archMax: FLOW_ARCH_MAX, minDist: 3, renderOrder: 3, ...config,
  };

  const extentX = groundSpanX * cfg.extentFactor;
  const extentZ = groundSpanZ * cfg.extentFactor;
  const trips = [];
  for (const r of rows) {
    const oLon = cfg.originLon(r), oLat = cfg.originLat(r);
    const dLon = cfg.destLon(r), dLat = cfg.destLat(r);
    if (![oLon, oLat, dLon, dLat].every(Number.isFinite)) continue;
    const hour = cfg.hour(r);
    if (!(hour >= 0 && hour < 24)) continue;
    const p = toLocal(oLon, oLat);
    const d = toLocal(dLon, dLat);
    if (Math.abs(p.x) > extentX || Math.abs(p.z) > extentZ) continue;
    if (Math.abs(d.x) > extentX || Math.abs(d.z) > extentZ) continue;
    const dist = Math.hypot(d.x - p.x, d.z - p.z);
    if (dist < cfg.minDist) continue;
    trips.push({ p, d, dist, hour });
  }
  if (trips.length === 0) return null;

  let picked = trips;
  if (trips.length > FLOW_MAX) {
    picked = [];
    const stride = trips.length / FLOW_MAX;
    for (let i = 0; i < FLOW_MAX; i += 1) picked.push(trips[Math.floor(i * stride)]);
  }

  const segCount = picked.length * FLOW_SEGMENTS;
  const positions = new Float32Array(segCount * 6);
  const aHour = new Float32Array(segCount);
  const aSeed = new Float32Array(segCount);
  const aT0 = new Float32Array(segCount);
  const aT1 = new Float32Array(segCount);
  let seg = 0;

  for (const t of picked) {
    const seed = Math.random();
    const mx = (t.p.x + t.d.x) / 2;
    const mz = (t.p.z + t.d.z) / 2;
    const ctrlY = 0.3 + Math.min(cfg.archMax, cfg.archBase + t.dist * cfg.archRate);
    const px = new Array(FLOW_SEGMENTS + 1);
    const py = new Array(FLOW_SEGMENTS + 1);
    const pz = new Array(FLOW_SEGMENTS + 1);
    for (let s = 0; s <= FLOW_SEGMENTS; s += 1) {
      const u = s / FLOW_SEGMENTS;
      const omu = 1 - u;
      px[s] = omu * omu * t.p.x + 2 * omu * u * mx + u * u * t.d.x;
      py[s] = omu * omu * 0.3 + 2 * omu * u * ctrlY + u * u * 0.3;
      pz[s] = omu * omu * t.p.z + 2 * omu * u * mz + u * u * t.d.z;
    }
    for (let s = 0; s < FLOW_SEGMENTS; s += 1) {
      const o = seg * 6;
      positions[o] = px[s]; positions[o + 1] = py[s]; positions[o + 2] = pz[s];
      positions[o + 3] = px[s + 1]; positions[o + 4] = py[s + 1]; positions[o + 5] = pz[s + 1];
      aHour[seg] = t.hour;
      aSeed[seg] = seed;
      aT0[seg] = s / FLOW_SEGMENTS;
      aT1[seg] = (s + 1) / FLOW_SEGMENTS;
      seg += 1;
    }
  }

  const geo = new LineSegmentsGeometry();
  geo.setPositions(positions);
  geo.setAttribute('aHour', new THREE.InstancedBufferAttribute(aHour, 1));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 1));
  geo.setAttribute('aT0', new THREE.InstancedBufferAttribute(aT0, 1));
  geo.setAttribute('aT1', new THREE.InstancedBufferAttribute(aT1, 1));

  const mat = new LineMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    worldUnits: false, linewidth: settings[cfg.keys.width],
  });
  mat.resolution.set(window.innerWidth, window.innerHeight);
  Object.assign(mat.uniforms, {
    uHour: { value: 12 },
    uWindow: { value: settings[cfg.keys.window] },
    uTime: { value: 0 },
    uFlowOpacity: { value: settings[cfg.keys.opacity] },
    uColorA: { value: new THREE.Color(cfg.colorA) },
    uColorB: { value: new THREE.Color(cfg.colorB) },
  });
  mat.vertexShader = mat.vertexShader.replace('void main() {', /* glsl */`
    attribute float aHour;
    attribute float aSeed;
    attribute float aT0;
    attribute float aT1;
    varying float vHour;
    varying float vSeed;
    varying float vArc;
    void main() {
      vHour = aHour;
      vSeed = aSeed;
      vArc = ( position.y < 0.5 ) ? aT0 : aT1;
  `);
  mat.fragmentShader = mat.fragmentShader
    .replace('void main() {', /* glsl */`
      uniform float uHour;
      uniform float uWindow;
      uniform float uTime;
      uniform float uFlowOpacity;
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      varying float vHour;
      varying float vSeed;
      varying float vArc;
      void main() {
    `)
    .replace('vec4 diffuseColor = vec4( diffuse, alpha );', /* glsl */`
      float _hd = abs( vHour - uHour );
      _hd = min( _hd, 24.0 - _hd );
      float _vis = smoothstep( uWindow, 0.0, _hd );
      if ( _vis <= 0.001 ) discard;
      float _head = fract( uTime * 0.22 + vSeed );
      float _pulse = smoothstep( 0.14, 0.0, abs( vArc - _head ) );
      vec3 _col = mix( uColorA, uColorB, vArc ) * ( 0.35 + _pulse * 1.7 );
      alpha *= _vis * uFlowOpacity * ( 0.45 + _pulse );
      vec4 diffuseColor = vec4( _col, alpha );
    `);
  mat.needsUpdate = true;

  const mesh = new LineSegments2(geo, mat);
  mesh.visible = settings[cfg.keys.visible];
  mesh.frustumCulled = false;
  mesh.renderOrder = cfg.renderOrder;
  return registerOverlay({ mesh, material: mat, kind: 'arc', keys: cfg.keys });
}

// Collisions: Motor Vehicle Collisions, coloured by severity.
function buildCollisions(rows) {
  return buildPointLayer(rows, {
    lon: (r) => parseFloat(r.longitude),
    lat: (r) => parseFloat(r.latitude),
    hour: (r) => parseInt((r.crash_time || '').split(':')[0], 10),
    category: (r) => (+r.number_of_persons_killed > 0 ? 0 : (+r.number_of_persons_injured > 0 ? 1 : 2)),
    colors: ['#ff2e2e', '#ff9d2e', '#5b8cff'], // fatal · injury · property-only
    keys: { visible: 'collisions', size: 'collisionSize', window: 'collisionWindow', opacity: 'collisionOpacity' },
  });
}

// Crime: NYPD complaints, coloured by legal class.
function buildCrime(rows) {
  return buildPointLayer(rows, {
    lon: (r) => parseFloat(r.longitude),
    lat: (r) => parseFloat(r.latitude),
    hour: (r) => parseInt((r.cmplnt_fr_tm || '').split(':')[0], 10),
    category: (r) => (r.law_cat_cd === 'FELONY' ? 0 : (r.law_cat_cd === 'MISDEMEANOR' ? 1 : 2)),
    colors: ['#ff2e6a', '#ffb020', '#37d0ff'], // felony · misdemeanour · violation
    keys: { visible: 'crime', size: 'crimeSize', window: 'crimeWindow', opacity: 'crimeOpacity' },
  });
}

// Citi Bike: a second light-trail fleet, not an arc layer. Build its demand from the
// real start→drop-off rides, fill the bike pool, and set the active count for the hour.
// The bike heat layers were built with the road network; the sim runs in animate.
function buildCitibike(rows) {
  bikeDemand = buildBikeDemand(rows);
  if (!bikeDemand) return;
  spawnBikes();
  setBikeFleet(targetBikeFleet());
  bikeFleetHour = currentHour();
}

// Citi Bike as trip ARCS for the flows section (separate from the bike light-trails):
// start→drop-off ribbons, green start → blue end, sharing the flows width/window/opacity.
function buildCitibikeFlows(rows) {
  return buildArcLayer(rows, {
    originLon: (r) => parseFloat(r.start_lng),
    originLat: (r) => parseFloat(r.start_lat),
    destLon: (r) => parseFloat(r.end_lng),
    destLat: (r) => parseFloat(r.end_lat),
    hour: (r) => parseInt(r.hour, 10),
    colorA: '#39ff9e', colorB: '#2f7bff',
    archBase: 8, archRate: 0.6, archMax: 48, minDist: 2,
    keys: { visible: 'flowsBike', width: 'flowWidth', window: 'flowWindow', opacity: 'flowOpacity' },
  });
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
    const field = buildWaterField(await loadWaterData(), data.buildings);
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

  // The city is in place and static, so bake the shadow map once, now — synchronously,
  // while the buildings are visible. (Deferring to the animate loop would risk the
  // reflection probe, which hides the buildings mid-frame, baking an empty map.)
  // autoUpdate stays off, so it never re-renders after this.
  renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);

  // Real pickup demand, if it loads. Non-fatal on purpose — a throttled or dead
  // Socrata mirror just means the cabs spawn on the random walk, same as always.
  setLoadingState(85, 'Reading taxi demand…');
  await nextFrame();
  let demandRows = null;
  try {
    demandRows = await loadTaxiDemand();
    demandModel = buildDemandModel(demandRows);
    if (demandModel) {
      console.info(`Taxi demand: seeded from ${demandModel.all.length} real pickups.`);
    }
  } catch (error) {
    console.warn('No live taxi demand; cabs spawn on the random walk:', error);
    demandModel = null;
  }

  // Overlay data layers, each non-fatal — a failure just leaves that toggle empty. Named
  // per source so the loader's build log shows every dataset as it comes down.
  setLoadingState(86, 'Charting trip flows…');
  await nextFrame();
  try {
    if (demandRows) buildFlows(demandRows); // pickup→dropoff arcs share the demand file
  } catch (error) {
    console.warn('Flows overlay unavailable:', error);
  }

  setLoadingState(87, 'Mapping 311 complaints…');
  try {
    buildEvents(await loadEvents());
  } catch (error) {
    console.warn('Events overlay unavailable:', error);
  }

  setLoadingState(88, 'Plotting vehicle collisions…');
  try {
    buildCollisions(await loadSnapshot(SNAPSHOT_FILES.collisions));
  } catch (error) {
    console.warn('collisions overlay unavailable:', error);
  }

  setLoadingState(89, 'Plotting crime reports…');
  try {
    buildCrime(await loadSnapshot(SNAPSHOT_FILES.crime));
  } catch (error) {
    console.warn('crime overlay unavailable:', error);
  }

  // Citi Bike feeds two views from one file: the light-trail fleet AND the flows arcs.
  setLoadingState(90, 'Threading Citi Bike routes…');
  try {
    const citibikeRows = await loadSnapshot(SNAPSHOT_FILES.citibike);
    buildCitibike(citibikeRows);
    buildCitibikeFlows(citibikeRows);
  } catch (error) {
    console.warn('citibike overlays unavailable:', error);
  }

  setLoadingState(92, 'Dispatching the fleets…');
  await nextFrame();
  if (edges.length > 0) {
    spawnTaxis();
    activeTaxis = taxis.length;          // spawnTaxis placed them all…
    setActiveFleet(targetFleetSize());   // …then trim to the current hour's demand
    fleetHour = currentHour();
  }

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
    time: formatClock(settings.timeOfDay),
    taxis: activeTaxis,
    buildings,
    roads: data.roads.length,
    segments: edges.length,
    nodes: nodes.length,
    source: mapSource,
  });

  // Everything's loaded: mark the log done and surface the Continue button. The
  // reveal (panels in, flyover armed) happens when the user clicks it — see
  // revealScene.
  setLoadingState(100, 'Ready');
  console.info(`${nodes.length} nodes, ${edges.length} road segments, ${activeTaxis}/${taxis.length} taxis active`);
}

// ---------------------------------------------------------------------------
// Flyover easter egg. Once per page load, when the camera is zoomed right out and
// looking almost straight down, a plane crosses the screen with a sound cue: the
// music starts, then ~4s later the plane passes bottom-to-top over 3s. The camera
// is locked — no orbit, pan, zoom or scroll — until it's gone.
// ---------------------------------------------------------------------------

const FLYOVER_MIN_DISTANCE = 1050; // near maxDistance (1200): "all the way out"
const FLYOVER_MAX_POLAR = 0.4;     // radians from straight down: "almost bird's-eye"

let flyoverArmed = false; // set true once the map is ready, so it can't fire mid-load
let flyoverDone = false;  // one-shot per page load

function checkFlyover() {
  if (!flyoverArmed || flyoverDone) return;
  if (camera.position.distanceTo(controls.target) < FLYOVER_MIN_DISTANCE) return;
  if (controls.getPolarAngle() > FLYOVER_MAX_POLAR) return;
  flyoverDone = true;
  startFlyover();
}

function startFlyover() {
  // Lock the camera until the plane has passed.
  controls.enabled = false;
  controls.autoRotate = false;

  // Music first; kick off loading the image now so it's ready to fly in 4s.
  new Audio('assets/plane_sound.mp3').play().catch(() => {});
  new Image().src = 'assets/plane.png';

  // Cloud video layer, so the plane flies through an already-hazy sky. The footage
  // is portrait, so the CSS turns it 90° and covers the viewport; it's muted (a
  // requirement for autoplay) and loops.
  const clouds = document.createElement('div');
  clouds.id = 'flyover-clouds';
  const video = document.createElement('video');
  video.className = 'flyover-video';
  video.src = 'assets/clouds.mp4';
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  clouds.append(video);
  document.body.append(clouds);
  video.play().catch(() => {});
  // Force a reflow so the opacity:0 base is committed before the class flips it to 1
  // — otherwise a freshly-inserted element jumps in with no transition.
  void clouds.offsetWidth;
  clouds.classList.add('is-visible');

  window.setTimeout(() => {
    const plane = document.createElement('img');
    plane.id = 'plane-flyover';
    plane.src = 'assets/plane.png';
    plane.alt = '';
    plane.addEventListener('animationend', () => {
      plane.remove();
      controls.enabled = true;
      controls.autoRotate = view.autoOrbit; // restore whatever the panel had set
      clouds.classList.remove('is-visible'); // fade the clouds back out
      window.setTimeout(() => clouds.remove(), 1500);
    });
    document.body.append(plane);
    // Next frame, so the parked base transform is in place before the run begins.
    requestAnimationFrame(() => plane.classList.add('is-flying'));
  }, 4000);
}

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.05); // clamp: tab-switch stalls
  // While Reset view is flying home the tween drives the camera; otherwise OrbitControls.
  if (!updateResetTween(dt)) controls.update();
  checkFlyover();

  waterUniforms.uWaterTime.value += dt;
  if (settings.fog) fogUniforms.uFogTime.value += dt;

  // After controls.update(), so the focus plane tracks the damped camera rather
  // than lagging a frame behind it during a drag.
  if (bokeh.enabled) {
    bokeh.uniforms.focus.value = camera.position.distanceTo(controls.target);
  }

  tickTime(); // advance the live clock (and resize the fleet on an hour rollover)

  if (taxis.length > 0) {
    updateTaxis(dt);
    decayHeat(dt);
  }
  // The bike fleet runs when its trail layer OR its density heatmap is on — no cost
  // otherwise. decayBikeHeat keeps the (hidden) trail buffers sane for a later reveal.
  if ((settings.citibike || settings.heatmapBike) && bikes.length > 0) {
    updateBikes(dt);
    decayBikeHeat(dt);
  }
  updateHeatmap(dt);
  updateOverlays(dt);

  updateReflectionProbe(dt);
  composer.render();
  // Right after the render, while the drawing buffer still holds this frame — see
  // drainCapture. Any other time the buffer may already be cleared on present.
  drainCapture();
  trackFps(dt);
}

// ---------------------------------------------------------------------------
// Snapshot export. Grabs the composited frame as a JPEG and lets the user pick
// where it lands, naming shots 3dmap_taxi_<map>_<n>.jpg with an incrementing n.
// ---------------------------------------------------------------------------

// A filesystem-safe stub of the map name for the filename.
const MAP_SLUG = LOCATION.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'map';

// The shot counter is remembered across reloads (per map), so a later session
// keeps numbering where the last left off rather than starting back at _1.
const SHOT_SEQ_KEY = `taxi_shot_seq_${MAP_SLUG}`;

function nextShotNumber() {
  let last = 0;
  try { last = parseInt(localStorage.getItem(SHOT_SEQ_KEY), 10) || 0; } catch { /* private mode */ }
  return last + 1;
}

function rememberShotNumber(n) {
  try { localStorage.setItem(SHOT_SEQ_KEY, String(n)); } catch { /* private mode */ }
}

// The renderer clears its drawing buffer on present (preserveDrawingBuffer is off,
// for speed), so the only safe moment to read pixels is the instant after a render.
// A queued capture is drained by drainCapture() in animate(), right after render.
let pendingCapture = null;

function captureFrame() {
  return new Promise((resolve, reject) => { pendingCapture = { resolve, reject }; });
}

function drainCapture() {
  if (!pendingCapture) return;
  const { resolve, reject } = pendingCapture;
  pendingCapture = null;
  renderer.domElement.toBlob(
    (blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))),
    'image/jpeg',
    0.92,
  );
}

// 4K on the long axis, keeping the window's aspect ratio so the framing matches
// exactly what's on screen — just at more pixels.
function fourKDimensions() {
  const aspect = window.innerWidth / window.innerHeight;
  return aspect >= 1
    ? { width: 3840, height: Math.round(3840 / aspect) }
    : { width: Math.round(3840 * aspect), height: 3840 };
}

// Render one frame at an arbitrary resolution without disturbing the live view.
// The whole GPU sequence — resize, render, read pixels, resize back — runs in a
// single synchronous stretch, so the animation loop can't slip a frame in at the
// wrong size and the browser never paints the oversized buffer. Reading with
// gl.readPixels (rather than canvas.toBlob) is what keeps it synchronous.
async function renderAtResolution(width, height) {
  const prevPixelRatio = renderer.getPixelRatio();
  const prevAspect = camera.aspect;

  renderer.setPixelRatio(1);
  composer.setPixelRatio(1);
  renderer.setSize(width, height, false); // false: leave the on-screen CSS size alone
  composer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  composer.render();

  const gl = renderer.getContext();
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  renderer.setPixelRatio(prevPixelRatio);
  composer.setPixelRatio(prevPixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  composer.setSize(window.innerWidth, window.innerHeight);
  applyBloomResolution();
  camera.aspect = prevAspect;
  camera.updateProjectionMatrix();

  // Pack into a 2D canvas, flipping rows — GL's origin is bottom-left, the image's
  // is top-left. A plain 2D-canvas toBlob then encodes with none of the WebGL
  // preserve-buffer caveats.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y += 1) {
    const src = y * rowBytes;
    image.data.set(pixels.subarray(src, src + rowBytes), (height - 1 - y) * rowBytes);
  }
  ctx.putImageData(image, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))),
      'image/jpeg',
      0.92,
    );
  });
}

async function saveScreenshot({ fourK = false } = {}) {
  const number = nextShotNumber();
  const filename = `3dmap_taxi_${MAP_SLUG}_${number}.jpg`;

  // Grab the frame first, so the JPEG is exactly the view that was on screen when
  // the button was clicked rather than wherever the traffic has drifted to by the
  // time the save dialog closes.
  let blob;
  try {
    const { width, height } = fourKDimensions();
    blob = fourK ? await renderAtResolution(width, height) : await captureFrame();
  } catch (error) {
    console.error('Screenshot capture failed:', error);
    return;
  }

  // Preferred path: the File System Access API opens a real "save as" dialog so the
  // user picks the folder and name. Chromium-only; the click's user activation is
  // still live here (a frame is milliseconds, the activation window is seconds).
  if (window.showSaveFilePicker) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'JPEG image', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } }],
      });
    } catch (error) {
      if (error.name === 'AbortError') return; // cancelled — leave the counter be
      handle = null; // any other failure falls through to the download below
    }
    if (handle) {
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      rememberShotNumber(number);
      return;
    }
  }

  // Fallback for browsers without the picker (Firefox/Safari): a plain download
  // with the computed name. Whether a dialog appears is then the browser's own
  // "ask where to save each file" setting, which we can't control from here.
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  rememberShotNumber(number);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  applyBloomResolution(); // composer.setSize reset bloom to full res; halve it again
  // The road ribbons are ordinary world-space geometry, so a resize costs them
  // nothing — the camera projection alone takes care of them.
  // Fat flow-lines size themselves in pixels, so they need the new drawing-buffer size.
  if (flowsMat) flowsMat.resolution.set(window.innerWidth, window.innerHeight);
  for (const layer of overlayLayers) {
    if (layer.kind === 'arc') layer.material.resolution.set(window.innerWidth, window.innerHeight);
  }
});

// ---------------------------------------------------------------------------
// Control panel
// ---------------------------------------------------------------------------

function applySetting(key, value) {
  settings[key] = value;

  // Registry-backed overlays (collisions, crime, Citi Bike) toggle by their visible key.
  const overlay = overlayLayers.find((l) => l.keys.visible === key);
  if (overlay) overlay.mesh.visible = value;

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
    case 'taxisVisible':
      // Hide/show the glowing trail meshes; the dim road network (roadLines) stays.
      for (const layer of roadLayers) if (layer) layer.mesh.visible = value;
      break;
    case 'citibike':
      // Show/hide the bike trail meshes. The sim in animate is gated on this too.
      for (const layer of bikeLayers) if (layer) layer.mesh.visible = value;
      break;
    case 'citibikeHead':
    case 'citibikeTail':
      applyTrailGradient(key, value);
      break;
    case 'citibikeOpacity':
      bikeTrailUniforms.opacity.value = value;
      break;
    // citibikeDecay is read fresh every frame by decayBikeHeat — nothing to apply.
    case 'timeOfDay':
      // Scrubbing the slider is a manual override — drop out of live mode so the next
      // clock tick doesn't yank the time back to now, and reflect that in the toggle.
      if (settings.liveTime) {
        settings.liveTime = false;
        const live = document.querySelector('[data-setting="liveTime"]');
        if (live) live.checked = false;
      }
      syncTimeControl(); // formatted readout beside the slider
      applyTimeOfDay();
      break;
    case 'liveTime':
      // Turning live back on snaps straight to the current wall-clock minute.
      if (value) {
        settings.timeOfDay = wallClockMinutes();
        syncTimeControl();
        applyTimeOfDay();
      }
      break;
    case 'flowsTaxi':
      if (flowsMesh) flowsMesh.visible = value;
      break;
    // flowsBike is a registered arc layer — the generic overlay lookup above toggles it.
    case 'events':
      if (eventsMesh) eventsMesh.visible = value;
      break;
    // flowOpacity / eventOpacity are read straight off settings by updateOverlays.
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
      // The shadow map is frozen with the buildings baked in, so hiding them would
      // otherwise leave their shadows on the empty ground. Toggle the sun's casting
      // to drop/restore the shadows with the buildings (the baked map is reused).
      sun.castShadow = value;
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
    case 'buildingMetalness':
      if (buildingMaterial) buildingMaterial.metalness = value;
      break;
    case 'buildingSpecular':
      if (buildingMaterial) buildingMaterial.specularIntensity = value;
      break;
    case 'buildingDiffuse':
      // The uniform only exists once the material has compiled; the fallback keeps
      // the value so the shader picks it up when it does.
      if (buildingMaterial?.userData.shader) {
        buildingMaterial.userData.shader.uniforms.uDiffuse.value = value;
      }
      break;
    case 'buildingSheen':
      if (buildingMaterial) buildingMaterial.sheen = value;
      break;
    case 'buildingSheenColor':
      if (buildingMaterial) buildingMaterial.sheenColor.set(value);
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
    case 'waterTint':
      waterUniforms.uWaterTint.value.set(value);
      break;
    case 'waterTintStrength':
      waterUniforms.uWaterTintStrength.value = value;
      break;
    case 'fog':
      fogUniforms.uFogEnabled.value = value ? 1 : 0;
      break;
    case 'fogColor':
      fogUniforms.uFogColor.value.set(value);
      break;
    case 'fogOpacity':
      fogUniforms.uFogOpacity.value = value;
      break;
    case 'fogStrength':
      fogUniforms.uFogStrength.value = value;
      break;
    case 'fogNoise':
      fogUniforms.uFogNoise.value = value;
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
    case 'uiAccent':
      // The panel chrome is styled off this one custom property, so the UI re-tints
      // with the theme instead of leaving orange chrome over a green city.
      document.documentElement.style.setProperty('--accent', value);
      break;
    case 'uiPanel':
      // Base colour of the panel/card backgrounds (the CSS applies the frost/alpha).
      document.documentElement.style.setProperty('--panel-bg', value);
      break;
    case 'uiButton':
      // Fill colour the panel buttons are mixed from.
      document.documentElement.style.setProperty('--ui-button', value);
      break;
  }
}

// ---------------------------------------------------------------------------
// Custom themes. Saved to localStorage (no server, and a static page can't write
// real files) as full setting bundles — the exact shape of the built-in theme
// files — so they slot into applyTheme and the reset button with no special cases.
// The built-in files are never touched, so "Reset to defaults" still restores
// whichever palette, built-in or saved, you're currently on.
// ---------------------------------------------------------------------------

const CUSTOM_THEMES_KEY = 'taxitaxi_custom_themes_v1';

// The value keys a theme bundle carries — everything in a built-in theme but its
// identity fields. Camera-motion keys live on `view`; the rest on `settings`.
const THEME_VALUE_KEYS = Object.keys(DEFAULT_THEME)
  .filter((key) => key !== 'id' && key !== 'label' && key !== 'swatch');

function loadCustomThemes() {
  try {
    const list = JSON.parse(localStorage.getItem(CUSTOM_THEMES_KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

let customThemes = loadCustomThemes();

function persistCustomThemes() {
  try {
    localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(customThemes));
  } catch (error) {
    console.warn('Could not persist custom themes:', error);
  }
}

// Built-in first, so a saved theme can never shadow a built-in id.
function resolveTheme(id) {
  return THEMES[id] || customThemes.find((theme) => theme.id === id) || null;
}

// Preset swatch colours offered in the save dialog — neon-to-pastel, distinct
// enough to tell saved themes apart at a glance.
const THEME_SWATCHES = [
  '#ff5ec8', '#ff4d97', '#ff6f61', '#ff9f45', '#ffe066',
  '#c1f25e', '#6ee7a8', '#3ee0c8', '#5cd6ff', '#6c9bff',
  '#8f7bff', '#b98cff', '#e58cff', '#ffb3d1', '#a8ecd6',
  '#ffffff', '#e6e9ef', '#c2c7d0', '#9ba1ac',
];

// Snapshot the current look as a saveable bundle, reading each key from wherever it
// lives (camera keys on `view`, everything else on `settings`). `swatch` is the dot
// colour chosen in the dialog; it falls back to the accent.
function captureTheme(label, swatch) {
  const dot = swatch || settings.uiAccent;
  const theme = { id: `custom-${Date.now()}`, label, theme_dot_swatch: dot, theme_dot_accent: dot };
  for (const key of THEME_VALUE_KEYS) {
    theme[key] = VIEW_KEYS.has(key) ? view[key] : settings[key];
  }
  return theme;
}

// A bundle is importable if it has a name and at least one recognised theme value —
// enough to reject unrelated JSON without being fussy about which keys are present.
function isValidTheme(candidate) {
  return candidate && typeof candidate === 'object'
    && typeof candidate.label === 'string'
    && THEME_VALUE_KEYS.some((key) => key in candidate);
}

// Download the saved themes as one JSON file — a backup, or something to hand to
// another browser (localStorage doesn't travel between them).
function exportThemes() {
  const blob = new Blob([JSON.stringify(customThemes, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'taxitaxi-themes.json';
  link.click();
  URL.revokeObjectURL(url);
}

// Merge bundles from a parsed file (a single theme or an array), giving each a fresh
// id so an import can never collide with a theme already saved. Returns how many
// were added.
function mergeImportedThemes(data) {
  const incoming = (Array.isArray(data) ? data : [data]).filter(isValidTheme);
  for (const theme of incoming) {
    customThemes = [...customThemes, { ...theme, id: `custom-${Date.now()}-${customThemes.length}` }];
  }
  if (incoming.length > 0) persistCustomThemes();
  return incoming.length;
}

function applyTheme(id) {
  const theme = resolveTheme(id);
  if (!theme) return;

  settings.theme = id;
  for (const [key, value] of Object.entries(themeValues(theme))) {
    // Camera-motion keys belong to `view`/applyView; everything else is a look
    // setting on `settings`/applySetting. Splitting here is what lets a single
    // theme bundle drive both panels.
    if (VIEW_KEYS.has(key)) applyView(key, value);
    else applySetting(key, value);
  }
}

// The buttons are built from the bundles rather than written out in the markup,
// so a new theme file is the only edit needed to get a new button.
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
  // Collapse can be driven from the section title or the chevron. In plain sections the
  // chevron sits inside the title button; in sections with an info button it's pulled out
  // into its own .section-collapse button so it can sit to the right of the "i". Either
  // way the chevron lives somewhere in the header, so find it on the section.
  for (const section of panel.querySelectorAll('section')) {
    const toggle = section.querySelector('.section-toggle');
    if (!toggle) continue;
    const chev = section.querySelector('.chev');
    const collapse = () => {
      const collapsed = section.toggleAttribute('data-collapsed');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      if (chev) chev.textContent = collapsed ? '+' : '−';
    };
    toggle.addEventListener('click', collapse);
    const collapseButton = section.querySelector('.section-collapse');
    if (collapseButton) collapseButton.addEventListener('click', collapse);
  }

  return { syncInputs: () => inputs.forEach(syncInput) };
}

// Builds the save-theme dialog once: fills the swatch grid, tracks the chosen colour
// and the live name counter, and on submit captures the current look under that name
// and colour. Returns a function that opens it; `onSaved` runs after a save so the
// caller can re-render the theme row.
function setupSaveThemeDialog(onSaved) {
  const dialog = document.querySelector('#save-theme-dialog');
  const form = dialog.querySelector('form');
  const nameInput = dialog.querySelector('#save-theme-name');
  const counter = dialog.querySelector('#save-theme-counter');
  const grid = dialog.querySelector('#save-theme-swatches');
  const customInput = dialog.querySelector('#save-theme-custom');
  const customSwatch = dialog.querySelector('.custom-swatch');

  let selectedColor = THEME_SWATCHES[0];

  // Single-select across the presets and the custom picker: passing a preset element
  // highlights it, passing null means the custom picker is the active choice.
  const selectColor = (color, presetEl) => {
    selectedColor = color;
    grid.querySelectorAll('.swatch-option').forEach((el) => {
      el.classList.toggle('is-selected', el === presetEl);
    });
    customSwatch.classList.toggle('is-selected', presetEl === null);
  };

  const presetEls = THEME_SWATCHES.map((color) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'swatch-option';
    option.style.color = color; // drives the CSS glow
    option.style.background = color;
    option.title = color;
    option.addEventListener('click', () => selectColor(color, option));
    grid.append(option);
    return option;
  });

  customInput.addEventListener('input', () => selectColor(customInput.value, null));
  nameInput.addEventListener('input', () => { counter.textContent = `${nameInput.value.length}/10`; });
  dialog.querySelector('.dialog-cancel').addEventListener('click', () => dialog.close());

  // method="dialog" closes the dialog on submit; this runs first and does the save.
  form.addEventListener('submit', () => {
    const label = nameInput.value.trim() || `Theme ${customThemes.length + 1}`;
    const theme = captureTheme(label, selectedColor);
    customThemes = [...customThemes, theme];
    persistCustomThemes();
    settings.theme = theme.id; // current settings already *are* the captured values
    onSaved();
  });

  return () => {
    nameInput.value = '';
    counter.textContent = '0/10';
    customInput.value = THEME_SWATCHES[0];
    selectColor(THEME_SWATCHES[0], presetEls[0]);
    dialog.showModal();
    nameInput.focus();
  };
}

function setupControls() {
  const panel = document.querySelector('#panel');
  const themeRow = panel.querySelector('.themes');
  const { syncInputs } = wirePanel(panel, settings, applySetting);

  const syncAll = () => {
    syncInputs();
    // A theme can now move camera-motion settings too, so the Camera panel's
    // sliders have to be brought back into step alongside this one.
    syncCameraPanel();
    // The time slider carries a formatted readout wirePanel doesn't know how to fill.
    syncTimeControl();
    themeRow.querySelectorAll('[data-theme]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.theme === settings.theme);
    });
  };

  const makeThemeButton = (theme, isCustom) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.theme = theme.id;

    const swatch = document.createElement('i');
    // Fall back to the old `swatch`/`accent` keys so custom themes saved before the rename
    // still show a dot.
    const dotFill = theme.theme_dot_swatch || theme.swatch || settings.uiAccent;
    swatch.style.background = dotFill;
    swatch.style.color = theme.theme_dot_accent || theme.accent || dotFill; // dot glow = currentColor
    button.append(swatch, document.createTextNode(theme.label));
    button.addEventListener('click', () => {
      applyTheme(theme.id);
      syncAll();
    });

    if (isCustom) {
      // A saved theme carries a delete affordance; stopPropagation keeps the click
      // off the button's own "select this theme" handler.
      const remove = document.createElement('span');
      remove.className = 'theme-delete';
      remove.textContent = '×';
      remove.title = 'Delete this theme';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!window.confirm(`Delete theme “${theme.label}”?`)) return;
        if (settings.theme === theme.id) applyTheme(DEFAULT_THEME.id);
        customThemes = customThemes.filter((entry) => entry.id !== theme.id);
        persistCustomThemes();
        renderThemes();
      });
      button.append(remove);
    }
    return button;
  };

  // Opens the save-theme modal; on save it captures the look and re-renders the row.
  const openSaveDialog = setupSaveThemeDialog(() => renderThemes());

  const renderThemes = () => {
    themeRow.replaceChildren();
    for (const theme of THEME_LIST) themeRow.append(makeThemeButton(theme, false));
    for (const theme of customThemes) themeRow.append(makeThemeButton(theme, true));

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'theme-save';
    save.textContent = '+ Save theme';
    save.title = 'Save the current settings as a new theme';
    save.addEventListener('click', () => openSaveDialog());
    themeRow.append(save);

    // Export only makes sense once there's something saved; Import is always offered.
    if (customThemes.length > 0) {
      const exportButton = document.createElement('button');
      exportButton.type = 'button';
      exportButton.className = 'theme-io';
      exportButton.textContent = 'Export';
      exportButton.title = 'Download your saved themes as a .json file';
      exportButton.addEventListener('click', exportThemes);
      themeRow.append(exportButton);
    }

    const importButton = document.createElement('button');
    importButton.type = 'button';
    importButton.className = 'theme-io';
    importButton.textContent = 'Import';
    importButton.title = 'Load saved themes from a .json file';
    importButton.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const added = mergeImportedThemes(JSON.parse(reader.result));
            if (added > 0) renderThemes();
            else window.alert('No themes found in that file.');
          } catch {
            window.alert('That file is not a valid themes export.');
          }
        };
        reader.readAsText(file);
      });
      input.click();
    });
    themeRow.append(importButton);

    syncAll();
  };

  renderThemes();

  panel.querySelector('.panel-reset').addEventListener('click', () => {
    // Back to the theme's own baseline — for a saved theme, its saved values; for a
    // built-in, the file's. "Reset" undoes your tweaks without leaving the palette.
    applyTheme(settings.theme);
    syncAll();
  });
}

function setupCamera() {
  const panel = document.querySelector('#nav');
  const { syncInputs } = wirePanel(panel, view, applyView);

  // Let a theme switch resync these sliders (see applyTheme's VIEW_KEYS routing).
  syncCameraPanel = syncInputs;

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
  panel.querySelector('#nav-reset').addEventListener('click', resetView);

  // Save grabs a JPG of the current view; the checkbox decides whether it's a 4K
  // offscreen render or the window-resolution frame.
  const save4k = panel.querySelector('#save-4k');
  panel.querySelector('#save-image').addEventListener('click', () => {
    saveScreenshot({ fourK: save4k.checked });
  });

  // Push the defaults through the same path a click takes, so OrbitControls starts
  // out agreeing with what the panel is showing.
  for (const key of Object.keys(view)) applyView(key, view[key]);
  setMode(view.dragMode);
  syncInputs();
}

// Per-section help text, keyed by the info button's data-info. Kept as small HTML so
// each explanation can have a couple of short paragraphs; <strong> for the key terms.
const SECTION_INFO = {
  flows: {
    title: 'Trip flows',
    body: `
      <p>Each arc is one real trip, drawn from where it <strong>started</strong> to where it
      <strong>ended</strong>, with a glow travelling the arc so you can read which way the
      city is moving. Two independent sources: <strong>Taxi trips</strong> (cool→warm, 2015
      yellow-cab records) and <strong>CitiBike trips</strong> (green→blue). Show either or
      both.</p>
      <p>Only trips from around the current hour are shown, so dragging the
      <strong>Time of day</strong> slider sweeps the day: watch the morning rush into
      Midtown reverse into an evening spread back out.</p>
      <p class="info-controls"><strong>Width</strong> — ribbon thickness.
      <strong>Hour spread</strong> — how many hours share the screen at once: low is a crisp
      single-hour snapshot, high blends neighbouring hours. <strong>Opacity</strong> — fades
      the layer. All three apply to both sources.</p>`,
  },
  events: {
    title: '311 reports',
    body: `
      <p>Every point is a real <strong>311 complaint</strong> — the city's non-emergency
      service line — logged on a representative day, placed where it was reported.</p>
      <p>Colour is the category: <strong>pink</strong> noise, <strong>amber</strong>
      vehicle &amp; parking, <strong>cyan</strong> street life, <strong>green</strong>
      buildings &amp; sanitation. Each point surfaces at the <strong>hour it was
      filed</strong>, so the Time-of-day slider replays the city's day: quiet before
      dawn, noise complaints climbing into the night.</p>
      <p class="info-controls"><strong>Size</strong> — how big each point glows.
      <strong>Hour spread</strong> — how many hours of complaints show at once: low
      pinpoints a single hour, high keeps more on screen. <strong>Opacity</strong> —
      fades the whole layer up or down.</p>`,
  },
  heatmap: {
    title: 'Density heatmap',
    body: `
      <p>The buildings are re-coloured by how much traffic is moving nearby, right now —
      a live <strong>choropleth</strong> painted onto the city. Quiet blocks keep their
      normal colour; busy areas climb a <strong>cool → hot</strong> ramp (blue → teal →
      amber → red).</p>
      <p><strong>Taxi density</strong> and <strong>CitiBike density</strong> are separate
      sources that feed one shared field, so ticking both shows a single <strong>merged</strong>
      heatmap of where taxis and bikes together are thickest. It updates as they drive and
      shifts with the <strong>Time of day</strong> slider. Needs the buildings shown.</p>
      <p class="info-controls"><strong>Sensitivity</strong> — how much traffic a block
      needs before it reads as fully hot: raise it to make the map cooler and pick out
      only the busiest streets, lower it to light the city up sooner.</p>`,
  },
  collisions: {
    title: 'Collisions',
    body: `
      <p>Every point is a real <strong>motor-vehicle collision</strong> reported to NYPD,
      placed where it happened. Colour is severity: <strong>red</strong> a death,
      <strong>orange</strong> someone injured, <strong>blue</strong> property damage only.</p>
      <p>A year of crashes is aggregated <strong>by time of day</strong>: each shows at the
      hour it occurred, so the Time-of-day slider reveals when — and where — the roads turn
      dangerous. Quiet overnight, dense through the afternoon and evening rush.</p>
      <p class="info-controls"><strong>Size</strong> — how big each point glows.
      <strong>Hour spread</strong> — how many hours of crashes show at once.
      <strong>Opacity</strong> — fades the whole layer.</p>`,
  },
  crime: {
    title: 'Crime',
    body: `
      <p>Each point is a <strong>crime complaint</strong> filed with NYPD, placed at the
      reported location. Colour is the legal class: <strong>pink</strong> felony,
      <strong>amber</strong> misdemeanour, <strong>cyan</strong> violation.</p>
      <p>A month of complaints is aggregated <strong>by time of day</strong>, so scrubbing
      the Time-of-day slider replays when offences cluster across the map.</p>
      <p class="info-controls"><strong>Size</strong> — how big each point glows.
      <strong>Hour spread</strong> — how many hours of reports show at once.
      <strong>Opacity</strong> — fades the whole layer.</p>`,
  },
  citibike: {
    title: 'Citi Bike',
    body: `
      <p>A second fleet of <strong>light trails</strong>, just like the taxis but for bikes.
      Each bike spawns at a real Citi Bike <strong>start station</strong> and rides toward
      that trip's real <strong>drop-off station</strong>, so the glowing trails pile up on
      the corridors bikes actually use — the greenway, the protected avenues.</p>
      <p>The fleet size follows Citi Bike's real hourly volume, so the <strong>Time of
      day</strong> slider swells it through the morning and evening commutes. Bikes ride
      noticeably slower than the cabs.</p>
      <p class="info-controls"><strong>Head</strong> / <strong>Tail</strong> — the trail's
      hot tip and cooling body colours. <strong>Decay</strong> — how long trails linger
      (Long = a fuller long-exposure). <strong>Opacity</strong> — fades the whole fleet.</p>`,
  },
};

// Wire the little "i" buttons on section headers to a shared centred dialog.
function setupSectionInfo() {
  const dialog = document.querySelector('#info-dialog');
  if (!dialog) return;
  const titleEl = dialog.querySelector('#info-dialog-title');
  const textEl = dialog.querySelector('#info-dialog-text');

  for (const button of document.querySelectorAll('.section-info[data-info]')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation(); // don't also collapse the section
      const info = SECTION_INFO[button.dataset.info];
      if (!info) return;
      titleEl.textContent = info.title;
      textEl.innerHTML = info.body;
      dialog.showModal();
    });
  }

  // Close on the button, on a backdrop click, or on Escape (the last is native to
  // <dialog>). The backdrop is the dialog element itself outside its content box.
  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

setupPlaceLabel();
setupStats();
setupControls();
setupSectionInfo();
setupCamera();
// The panels start hidden and the loader covers the screen until Continue. If init
// throws unexpectedly, reveal the scene anyway so the user is never trapped behind
// the overlay.
init().catch((error) => {
  console.error('Initialisation failed:', error);
  if (loaderContinue) loaderContinue.hidden = false;
  revealScene();
});
animate();
