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
  exposure: 1.3, contrast: 1.50, bloom: 0.12,
  depthOfField: true, dofStrength: 0.45,

  // Taxi trails — the glowing road heat. `trailOpacity` is the trail-glow strength.
  // Sodium tail, near-white hot tip: a filament heating up.
  trailTail: '#ff4d0a', trailHead: '#fff0d2',
  trailDecay: 'long', trailOpacity: 0.82,

  // Density heatmap — the choropleth painted onto the buildings. `heatmapGain` is the
  // Sensitivity (how much traffic reads as hot); `heatmapIntensity` is how vivid it looks.
  // The on/off toggles stay out of the theme so switching palette never flips the layer.
  heatmapGain: 1.0, heatmapIntensity: 1.0,

  // Environment — reflection colour/strength, plus the sky and floor colours.
  // waterTintStrength 0 leaves the river on its floor colour; raise it (0..1) to wash
  // the water toward waterTint.
  envColor: '#fff6ef', envIntensity: 1.6,
  skyColor: '#a3afcc', groundColor: '#b6bcc3',
  // Asphalt reflection: how much sky the wet-looking streets throw back, and how sharp.
  floorReflection: 0.70, floorRoughness: 0.42,
  waterTint: '#2f6f7f', waterTintStrength: 0.09,
  // Ground fog — low-lying mist. `fog` enables it for this theme; the rest are its look.
  fog: false, fogColor: '#ffffff', fogOpacity: 0.02, fogStrength: 0.03, fogNoise: 0.67,
  // Distance haze — the far-fog wash. `hazeStrength` scales its density; `hazeFade` thins
  // it as the camera pulls back so overviews stay clear.
  hazeStrength: 0.34, hazeFade: true,

  // Sun — the key directional light, plus the ambient hemisphere (sky/ground
  // halves). The hemisphere has no direct UI slider but travels with the theme.
  sunColor: '#e1d6cb', sunIntensity: 2.48,
  skyLight: '#a3afcc', groundLight: '#4a2410',

  // Fill lights — the two softboxes that lift the massing out of shadow (Fill lights
  // section). Strength / colour / size are shared by both; position is per-light;
  // `areaTarget` is which surfaces they touch ('both' | 'buildings' | 'surface'). The
  // yellow placement-outline toggle is a tool, not a look, so it stays out of the theme.
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
  buildingColor: '#625f5b', edgeColor: '#69513f', showEdges: true,
  // A dim, desaturated take on the trail glow: at grazing angles the facades pick
  // up a faint warmth from the light they sit in, without tinting the palette.
  buildingSheenColor: '#3d2417',
  // Each building drifts from buildingColor toward one of these three. Two are
  // darker than the base and one lighter, so the city reads as blocks catching
  // the light differently rather than as three flat groups.
  variationColorA: '#6c675e', variationColorB: '#d0b490', variationColorC: '#bab1ab',

  // Camera — how the view moves (the right-hand Camera panel). Speeds and damping
  // are the Motion controls; autoOrbit is the Auto-orbit drift. Drag mode stays a
  // personal preference, so it isn't carried here.
  orbitSpeed: 1.00, panSpeed: 1.00, zoomSpeed: 1.00, damping: 0.06,
  autoOrbit: false, autoOrbitSpeed: 0.35,

  // Time-of-day columns. Everything above is the daylit city — the implicit `day`
  // column — and each block below restates only the keys that move, against it.
  //
  // Only things that genuinely read as time-of-day are here. The trails, the facade
  // variation and the whole panel chrome are the theme's identity and hold still
  // around the clock. The sodium trails not changing is the point: they're the one
  // thing that IS the same at 3am, and holding them fixed while the city drops away
  // around them is what makes them look like they're finally doing the lighting.
  phases: {
    // Dawn — cool and clean. Deliberately not dusk played backwards: morning air is
    // clear, so the light is blue and the shadows are hard. The warmth is only in the
    // sun itself, not yet in the air around it.
    dawn: {
      sunColor: '#ffc9a0', sunIntensity: 0.95,
      exposure: 1.18, contrast: 1.00, bloom: 0.55,
      skyLight: '#2e4468', groundLight: '#3a2a1e',
      skyColor: '#1d2735',
      groundColor: '#3a3423',
      envColor: '#9fc0e8', envIntensity: 1.10,
      buildingColor: '#35342f',
    },

    // Dusk — the golden hour, and the whole reason for a four-stop ring: this column
    // sits well off the straight line between noon and midnight, so no day↔night lerp
    // could ever pass through it. Low sun, violet sky opposite it, and a warm bounce
    // off streets that have been in the sun all day.
    //
    // Amber, not orange. Three warm sources stack multiplicatively on a facade here —
    // the key light, the bounce off the street, and the env dome wrapping the whole
    // thing — so each one only has to be mildly saturated before the result reads as
    // hard copper. The trick is that the *hue* sells the hour and the saturation is
    // what overcooks it: these sit around 30–40° with the chroma held well back, and
    // the env dome carries most of the warmth because it's the softest of the three.
    dusk: {
      sunColor: '#ffc188', sunIntensity: 1.05,
      exposure: 1.14, contrast: 1.00, bloom: 0.55,
      // The sky half stays a cool violet — that opposition to the warm key is what
      // makes it read as low evening sun rather than a global orange wash.
      skyLight: '#46425f', groundLight: '#69543e',
      skyColor: '#936547',
      groundColor: '#4a4030',
      envColor: '#e1a6c1', envIntensity: 1.12,
      // Barely off the day value: the facades should be *lit* warm, not *painted* warm.
      buildingColor: '#454039',
    },

    // Night — the city gets out of the way of the trails.
    night: {
      // The sun becomes a moon: dim, and cool enough to read as a different light
      // rather than a turned-down version of the same one.
      sunColor: '#9fb0d8', sunIntensity: 0.42,
      // Open the exposure back up a little so night is moody rather than unreadable.
      exposure: 1.24, contrast: 1.00, bloom: 0.55,
      // The sky half of the hemisphere goes deep blue; the bounce off the street keeps
      // a trace of sodium, because at night that bounce is coming from the trails.
      skyLight: '#161b2b', groundLight: '#2a1408',
      skyColor: '#20232c',
      groundColor: '#231d13',
      // Reflections stop being a bright overcast dome and become a dim blue one.
      envColor: '#2b3a5c', envIntensity: 0.85,
      // Facades fall toward their own shadow. Kept a hair above black so the edge
      // lines and the sheen still have something to sit on.
      buildingColor: '#a09792',
    },
  },
};
