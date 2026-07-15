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
  swatch: '#2f5fb0',
  accent: '#5b93e6',

  // Image — tone mapping and the post-process passes.
  exposure: 0.95, contrast: 1.15, bloom: 0.25,
  depthOfField: true, dofStrength: 0.45,

  // Taxi trails — the glowing road heat. `trailOpacity` is the trail-glow strength.
  // Ink doesn't get whiter as more is laid down, so the head barely lifts —
  // a pale blue rather than white, keeping it drawn instead of incandescent.
  trailTail: '#ee9417', trailHead: '#bcd8ff',
  trailDecay: 'long', trailOpacity: 0.82,

  // Environment — reflection colour/strength, plus the sky and floor colours.
  // The background and ground hexes look absurdly bright in a colour picker, and
  // have to: they are sRGB, get decoded to linear, then ACES pulls them down
  // again. A "correct" navy like #0c1a3a lands on near-black on screen.
  envColor: '#44587e', envIntensity: 1.8,
  background: '#466090', groundColor: '#7b889d',

  // Sun — the key directional light, plus the ambient hemisphere (sky/ground
  // halves). The hemisphere has no direct UI slider but travels with the theme.
  sunColor: '#cfe0ff', sunIntensity: 0.60,
  skyLight: '#4a6ba8', groundLight: '#1a3766',

  // Buildings — surface response (the Softness/Metalness/Specular/Diffuse/Sheen
  // controls) and the facade palette.
  buildingsVisible: true, buildingOpacity: 1.00, reflectTrails: true,
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
