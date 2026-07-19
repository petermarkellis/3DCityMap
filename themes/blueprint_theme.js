// Ink on paper, not light in a tube: a lifted navy ground so the city sits on
// a *surface*, a saturated slate line that stays blue at full heat, and a
// near-zero white core. Bloom is dialled right back — draughtsman's ink does
// not glow.
//
// Every value below is one the control panel can also set live; the comments name
// the panel SECTION each group belongs to.
export default {
  // Theme — identity, plus the accent the whole control panel is tinted with.
  id: 'blueprint',
  label: 'Blueprint',
  theme_dot_swatch: '#2f5fb0',
  theme_dot_accent: '#5b93e6',

  // UI styling — the control-panel chrome. uiAccent tints most of it; uiPanel is the
  // panel/card base colour; uiButton is the button fill.
  uiAccent: '#5b93e6',
  uiPanel: '#090a0c',
  uiButton: '#5b93e6',

  // Image — tone mapping and the post-process passes.
  exposure: 1.35, contrast: 1.15, bloom: 0.25,
  depthOfField: true, dofStrength: 0.45,

  // Taxi trails — the glowing road heat. `trailOpacity` is the trail-glow strength.
  // Ink doesn't get whiter as more is laid down, so the head barely lifts —
  // a pale blue rather than white, keeping it drawn instead of incandescent.
  trailTail: '#ee9417', trailHead: '#bcd8ff',
  trailDecay: 'long', trailOpacity: 0.82,

  // Density heatmap defaults. Sensitivity + how vivid the colours read; the on/off
  // toggles stay out of the theme so switching palette never flips the layer.
  heatmapGain: 1.0, heatmapIntensity: 1.0,

  // Environment — reflection colour/strength, plus the sky and floor colours.
  // The sky and ground hexes look absurdly bright in a colour picker, and
  // have to: they are sRGB, get decoded to linear, then ACES pulls them down
  // again. A "correct" navy like #0c1a3a lands on near-black on screen.
  envColor: '#44587e', envIntensity: 1.8,
  skyColor: '#466090', groundColor: '#7b889d',
  floorReflection: 0.79, floorRoughness: 0.42,
  // waterTintStrength 0 = off; raise it (0..1) to wash the water toward waterTint.
  waterTint: '#3a6fd0', waterTintStrength: 0.0,
  // Ground fog — low-lying mist. `fog` enables it for this theme; the rest are its look.
  fog: false, fogColor: '#eaf1ff', fogOpacity: 0.28, fogStrength: 0.06, fogNoise: 0.67,
  // Distance haze — `hazeStrength` scales the far-fog density, `hazeFade` thins it on zoom-out.
  hazeStrength: 0.5, hazeFade: true,

  // Sun — the key directional light, plus the ambient hemisphere (sky/ground
  // halves). The hemisphere has no direct UI slider but travels with the theme.
  sunColor: '#cfe0ff', sunIntensity: 0.60,
  skyLight: '#4a6ba8', groundLight: '#1a3766',

  // Fill lights — the two shadow-lifting softboxes (Fill lights section). areaTarget picks
  // which surfaces they touch; areaOutlines (the placement border) stays out of the theme.
  areaOn: true, areaStrength: 0.55, areaColor: '#ffffff',
  areaWidth: 700, areaHeight: 460, areaTarget: 'both',
  area1X: -360, area1Y: 620, area1Z: 260,
  area2X: 380, area2Y: 680, area2Z: -240,

  // Buildings — surface response (the Softness/Metalness/Specular/Diffuse/Sheen
  // controls) and the facade palette.
  buildingsVisible: true, buildingOpacity: 1.00, reflectTrails: false,
  buildingRoughness: 0.72, buildingMetalness: 0.15,
  buildingSpecular: 1.00, buildingDiffuse: 1.00,
  buildingSheen: 0.40, buildingGrain: 0.35, buildingVariation: 0.35,
  buildingColor: '#4b515d', edgeColor: '#65748b', showEdges: true,
  // Cool blueprint clay: the facades catch the blue ambient at grazing angles.
  buildingSheenColor: '#26344f',
  variationColorA: '#1c2331', variationColorB: '#4a5568', variationColorC: '#2e3a4d',

  // Camera — how the view moves (the right-hand Camera panel). Speeds and damping
  // are the Motion controls; autoOrbit is the Auto-orbit drift. Drag mode stays a
  // personal preference, so it isn't carried here.
  orbitSpeed: 1.00, panSpeed: 1.00, zoomSpeed: 1.00, damping: 0.06,
  autoOrbit: false, autoOrbitSpeed: 0.35,
};
