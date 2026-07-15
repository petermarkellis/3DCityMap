// Orange burn — a filament heating up: sodium-orange trails over a warm-grey city.
//
// Every value below is one the control panel can also set live. The comments name
// the panel SECTION each group belongs to, so the file reads top-to-bottom in the
// same order as the controls on screen.
export default {
  // Theme — identity, plus the accent the whole control panel is tinted with.
  id: 'ember',
  label: 'Orange burn',
  swatch: '#ff4d0a',
  accent: '#ff8c2a',

  // Image — tone mapping and the post-process passes.
  exposure: 0.90, contrast: 1.00, bloom: 0.55,
  depthOfField: true, dofStrength: 0.45,

  // Taxi trails — the glowing road heat. `trailOpacity` is the trail-glow strength.
  // Sodium tail, near-white hot tip: a filament heating up.
  trailTail: '#ff4d0a', trailHead: '#fff0d2',
  trailDecay: 'long', trailOpacity: 0.82,

  // Environment — reflection colour/strength, plus the sky and floor colours.
  envColor: '#fff6ef', envIntensity: 1.6,
  background: '#364663', groundColor: '#50452b',

  // Sun — the key directional light, plus the ambient hemisphere (sky/ground
  // halves). The hemisphere has no direct UI slider but travels with the theme.
  sunColor: '#ffd0a0', sunIntensity: 0.45,
  skyLight: '#35425e', groundLight: '#4a2410',

  // Buildings — surface response (the Softness/Metalness/Specular/Diffuse/Sheen
  // controls) and the facade palette.
  buildingsVisible: true, buildingOpacity: 1.00, reflectTrails: true,
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
