export default {
  id: 'ember',
  label: 'Orange burn',
  swatch: '#ff4d0a',
  accent: '#ff8c2a',
  exposure: 0.90, contrast: 1.00, bloom: 0.55,
  // Sodium tail, near-white hot tip: a filament heating up.
  trailTail: '#ff4d0a', trailHead: '#fff0d2',
  envColor: '#fff6ef', envIntensity: 1.6,
  sunColor: '#ffd0a0', sunIntensity: 0.45,
  buildingColor: '#46433f', edgeColor: '#69513f',
  // Each building drifts from buildingColor toward one of these three. Two are
  // darker than the base and one lighter, so the city reads as blocks catching
  // the light differently rather than as three flat groups.
  variationColorA: '#2b2926', variationColorB: '#d0b490', variationColorC: '#3a3532',
  background: '#364663', groundColor: '#50452b',
  skyLight: '#35425e', groundLight: '#4a2410',
};
