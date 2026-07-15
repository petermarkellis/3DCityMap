// The trail is already white, so a white core adds nothing but glare — all
// the separation has to come from contrast instead.
//
// Every value below is one the control panel can also set live; the comments name
// the panel SECTION each group belongs to.
export default {
  // Theme — identity, plus the accent the whole control panel is tinted with.
  id: 'grayscale',
  label: 'Grayscale',
  swatch: '#7d848d',
  accent: '#c9ced6',

  // Image — tone mapping and the post-process passes.
  exposure: 0.85, contrast: 1.22, bloom: 0.38,
  depthOfField: true, dofStrength: 0.45,

  // Taxi trails — the glowing road heat. `trailOpacity` is the trail-glow strength.
  // Only place a pure-white head is right: there's no hue to preserve.
  trailTail: '#7d848d', trailHead: '#3d9fdb',
  trailDecay: 'long', trailOpacity: 0.82,

  // Environment — reflection colour/strength, plus the sky and floor colours.
  envColor: '#9aa4b0', envIntensity: 1.4,
  background: '#050506', groundColor: '#08090a',

  // Sun — the key directional light, plus the ambient hemisphere (sky/ground
  // halves). The hemisphere has no direct UI slider but travels with the theme.
  sunColor: '#e8ecf2', sunIntensity: 0.50,
  skyLight: '#444a52', groundLight: '#2b2e33',

  // Buildings — surface response (the Softness/Metalness/Specular/Diffuse/Sheen
  // controls) and the facade palette.
  buildingsVisible: true, buildingOpacity: 1.00, reflectTrails: true,
  buildingRoughness: 0.72, buildingMetalness: 0.15,
  buildingSpecular: 1.00, buildingDiffuse: 1.00,
  buildingSheen: 0.40, buildingGrain: 0.35, buildingVariation: 0.35,
  buildingColor: '#7a788c', edgeColor: '#585d64', showEdges: true,
  // Neutral cool-grey sheen — no hue to give the clay away, just soft matte wrap.
  buildingSheenColor: '#2c333d',
  variationColorA: '#5f6165', variationColorB: '#a5a8ac', variationColorC: '#767a80',

  // Camera — how the view moves (the right-hand Camera panel). Speeds and damping
  // are the Motion controls; autoOrbit is the Auto-orbit drift. Drag mode stays a
  // personal preference, so it isn't carried here.
  orbitSpeed: 1.00, panSpeed: 1.00, zoomSpeed: 1.00, damping: 0.06,
  autoOrbit: false, autoOrbitSpeed: 0.35,
};
