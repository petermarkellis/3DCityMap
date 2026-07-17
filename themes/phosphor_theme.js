// Everything tinted, nothing neutral — a phosphor tube has one colour and the
// only variable is how hard it's driven. Bloom runs hot on purpose; that
// smeared halo around bright glyphs *is* the look.
//
// Every value below is one the control panel can also set live; the comments name
// the panel SECTION each group belongs to.
export default {
  // Theme — identity, plus the accent the whole control panel is tinted with.
  id: 'phosphor',
  label: 'Green CRT',
  theme_dot_swatch: '#11d4ad',
  theme_dot_accent: '#3dffa0',

  // UI styling — the control-panel chrome. uiAccent tints most of it; uiPanel is the
  // panel/card base colour; uiButton is the button fill.
  uiAccent: '#3dffa0',
  uiPanel: '#090a0c',
  uiButton: '#3dffa0',

  // Image — tone mapping and the post-process passes.
  exposure: 1.20, contrast: 1.15, bloom: 0.75,
  depthOfField: true, dofStrength: 0.45,

  // Taxi trails — the glowing road heat. `trailOpacity` is the trail-glow strength.
  // A phosphor tube driven hard blows out to white-green, not pure white.
  trailTail: '#11d4ad', trailHead: '#e2fff0',
  trailDecay: 'long', trailOpacity: 0.82,

  // Environment — reflection colour/strength, plus the sky and floor colours.
  envColor: '#aadac3', envIntensity: 1.5,
  background: '#464e4b', groundColor: '#45594e',
  floorReflection: 0.66, floorRoughness: 0.42,
  // waterTintStrength 0 = off; raise it (0..1) to wash the water toward waterTint.
  waterTint: '#1fb08a', waterTintStrength: 0.0,
  // Ground fog — low-lying mist. `fog` enables it for this theme; the rest are its look.
  fog: false, fogColor: '#e6fff2', fogOpacity: 0.28, fogStrength: 0.06, fogNoise: 0.67,

  // Sun — the key directional light, plus the ambient hemisphere (sky/ground
  // halves). The hemisphere has no direct UI slider but travels with the theme.
  sunColor: '#9dffc8', sunIntensity: 0.40,
  skyLight: '#1e5136', groundLight: '#0d3a20',

  // Buildings — surface response (the Softness/Metalness/Specular/Diffuse/Sheen
  // controls) and the facade palette.
  buildingsVisible: true, buildingOpacity: 1.00, reflectTrails: false,
  buildingRoughness: 0.72, buildingMetalness: 0.15,
  buildingSpecular: 1.00, buildingDiffuse: 1.00,
  buildingSheen: 0.40, buildingGrain: 0.35, buildingVariation: 0.35,
  buildingColor: '#51675a', edgeColor: '#526f5f', showEdges: true,
  // A dim green sheen so the clay sits in the phosphor glow.
  buildingSheenColor: '#16342a',
  variationColorA: '#1e4b33', variationColorB: '#addbc1', variationColorC: '#768f80',

  // Camera — how the view moves (the right-hand Camera panel). Speeds and damping
  // are the Motion controls; autoOrbit is the Auto-orbit drift. Drag mode stays a
  // personal preference, so it isn't carried here.
  orbitSpeed: 1.00, panSpeed: 1.00, zoomSpeed: 1.00, damping: 0.06,
  autoOrbit: false, autoOrbitSpeed: 0.35,
};
