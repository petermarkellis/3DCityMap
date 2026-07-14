// Everything tinted, nothing neutral — a phosphor tube has one colour and the
// only variable is how hard it's driven. Bloom runs hot on purpose; that
// smeared halo around bright glyphs *is* the look.
export default {
  id: 'phosphor',
  label: 'Green CRT',
  swatch: '#11d4ad',
  accent: '#3dffa0',
  exposure: 0.90, contrast: 1.15, bloom: 0.75,
  // A phosphor tube driven hard blows out to white-green, not pure white.
  trailTail: '#11d4ad', trailHead: '#e2fff0',
  envColor: '#00e070', envIntensity: 1.5,
  sunColor: '#9dffc8', sunIntensity: 0.40,
  buildingColor: '#33714d', edgeColor: '#3f8f63',
  variationColorA: '#1e4b33', variationColorB: '#438a5f', variationColorC: '#2a6142',
  background: '#1f4234', groundColor: '#45594e',
  skyLight: '#1e5136', groundLight: '#0d3a20',
};
