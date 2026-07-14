// Ink on paper, not light in a tube: a lifted navy ground so the city sits on
// a *surface*, a saturated slate line that stays blue at full heat, and a
// near-zero white core. Bloom is dialled right back — draughtsman's ink does
// not glow.
// The background and ground hexes look absurdly bright in a colour picker,
// and have to: they are sRGB, get decoded to linear, then ACES pulls them
// down again. A "correct" navy like #0c1a3a lands on near-black on screen.
export default {
  id: 'blueprint',
  label: 'Blueprint',
  swatch: '#2f5fb0',
  accent: '#5b93e6',
  exposure: 0.95, contrast: 1.15, bloom: 0.25,
  // Ink doesn't get whiter as more is laid down, so the head barely lifts —
  // a pale blue rather than white, keeping it drawn instead of incandescent.
  trailTail: '#ee9417', trailHead: '#bcd8ff',
  envColor: '#3a72d8', envIntensity: 1.8,
  sunColor: '#cfe0ff', sunIntensity: 0.60,
  buildingColor: '#383f4c', edgeColor: '#5676a5',
  variationColorA: '#232935', variationColorB: '#4a5568', variationColorC: '#2e3a4d',
  background: '#1e3d75', groundColor: '#24487f',
  skyLight: '#4a6ba8', groundLight: '#1a3766',
};
