// Presets. A theme is just a bundle of the same values the sliders write, so
// picking one and then hand-tweaking from there works exactly as you'd expect.
//
// `skyLight`/`groundLight` are the two halves of the hemisphere light: the first
// tints up-facing surfaces (roofs), the second is the bounce coming back off the
// lit street. Keeping them in the theme is what stops a blue city from having
// warm orange light pooling around its feet.
//
// To add a theme: drop a file next to this one and add it to THEME_LIST. It
// carries its own button label and swatch, so nothing in the markup has to know
// about it.
import clay from './clay_theme.js';
import blueprint from './blueprint_theme.js';
import phosphor from './phosphor_theme.js';
import grayscale from './grayscale_theme.js';

// Order here is the order the buttons appear in the panel.
export const THEME_LIST = [clay, blueprint, phosphor, grayscale];

export const THEMES = Object.fromEntries(THEME_LIST.map((theme) => [theme.id, theme]));

export const DEFAULT_THEME = clay;

// Identity, not look: these name the theme and draw its button, and there is no
// `applySetting` case for them. Everything else in a bundle is a live setting.
const META_KEYS = new Set(['id', 'label', 'theme_dot_swatch', 'theme_dot_accent']);

export const themeValues = (theme) => (
  Object.fromEntries(Object.entries(theme).filter(([key]) => !META_KEYS.has(key)))
);
2