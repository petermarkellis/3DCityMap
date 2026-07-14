// The trail is already white, so a white core adds nothing but glare — all
// the separation has to come from contrast instead.
export default {
  id: 'grayscale',
  label: 'Grayscale',
  swatch: '#7d848d',
  accent: '#c9ced6',
  exposure: 0.85, contrast: 1.22, bloom: 0.38,
  // Only place a pure-white head is right: there's no hue to preserve.
  trailTail: '#7d848d', trailHead: '#3d9fdb',
  envColor: '#9aa4b0', envIntensity: 1.4,
  sunColor: '#e8ecf2', sunIntensity: 0.50,
  buildingColor: '#7a788c', edgeColor: '#585d64',
  variationColorA: '#5f6165', variationColorB: '#a5a8ac', variationColorC: '#767a80',
  background: '#050506', groundColor: '#08090a',
  skyLight: '#444a52', groundLight: '#2b2e33',
};
