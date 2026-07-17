// Clay — warm sodium trails over a soft, warm-grey city.
//
// Every value below is one the control panel can also set live. The comments name
// the panel SECTION each group belongs to, so the file reads top-to-bottom in the
// same order as the controls on screen.
export default {
  // Theme identity — the two colours of the dot on this theme's button (fill + glow).
  id: 'clay',
  label: 'Clay',
  theme_dot_swatch: '#ff4d0a',
  theme_dot_accent: '#ff8c2a',

  // UI styling — the control-panel chrome. uiAccent tints most of it (sliders, checks,
  // text, borders, glow); uiPanel is the panel/card base colour; uiButton is the button fill.
  uiAccent: '#d19866',
  uiPanel: '#090a0c',
  uiButton: '#a67a53',

  // Image — tone mapping and the post-process passes.
  exposure: 1.11, contrast: 1.00, bloom: 0.55,
  depthOfField: true, dofStrength: 0.45,

  // Taxi trails — the glowing road heat. `trailOpacity` is the trail-glow strength.
  // Sodium tail, near-white hot tip: a filament heating up.
  trailTail: '#ff4d0a', trailHead: '#fff0d2',
  trailDecay: 'long', trailOpacity: 0.82,

  // Environment — reflection colour/strength, plus the sky and floor colours.
  // waterTintStrength 0 leaves the river on its floor colour; raise it (0..1) to wash
  // the water toward waterTint.
  envColor: '#fff6ef', envIntensity: 1.6,
  background: '#2b2e36', groundColor: '#50452b',
  waterTint: '#2f6f7f', waterTintStrength: 0.09,
  // Ground fog — low-lying mist. `fog` enables it for this theme; the rest are its look.
  fog: false, fogColor: '#ffffff', fogOpacity: 0.1, fogStrength: 0.03, fogNoise: 0.67,

  // Sun — the key directional light, plus the ambient hemisphere (sky/ground
  // halves). The hemisphere has no direct UI slider but travels with the theme.
  sunColor: '#e1d6cb', sunIntensity: 2.48,
  skyLight: '#3c4458', groundLight: '#4a2410',

  // Buildings — surface response (the Softness/Metalness/Specular/Diffuse/Sheen
  // controls) and the facade palette.
  buildingsVisible: true, buildingOpacity: 1.00, reflectTrails: false,
  buildingRoughness: 0.72, buildingMetalness: 0.15,
  buildingSpecular: 1.00, buildingDiffuse: 1.00,
  buildingSheen: 0.40, buildingGrain: 0.35, buildingVariation: 0.35,
  buildingColor: '#46433f', edgeColor: '#69513f', showEdges: true,
  // A dim, desaturated take on the trail glow: at grazing angles the facades pick
  // up a faint warmth from the light they sit in, without tinting the palette.
  buildingSheenColor: '#3d2417',
  // Each building drifts from buildingColor toward one of these three. Two are
  // darker than the base and one lighter, so the city reads as blocks catching
  // the light differently rather than as three flat groups.
  variationColorA: '#2b2926', variationColorB: '#d0b490', variationColorC: '#3a3532',

  // Camera — how the view moves (the right-hand Camera panel). Speeds and damping
  // are the Motion controls; autoOrbit is the Auto-orbit drift. Drag mode stays a
  // personal preference, so it isn't carried here.
  orbitSpeed: 1.00, panSpeed: 1.00, zoomSpeed: 1.00, damping: 0.06,
  autoOrbit: false, autoOrbitSpeed: 0.35,
};
