// Local, git-ignored configuration. To use it:
//   1. Copy this file to `config.local.js` (same folder).
//   2. Paste your values in.
// index.html loads config.local.js (if present) before main.js.
//
// TAXI_APP_TOKEN is a Socrata APP TOKEN — a PUBLIC rate-limit identifier, safe to
// expose in a browser. Create one at data.cityofnewyork.us → sign in → profile →
// Developer Settings → "App Tokens" → Create New App Token (keep "Public?" checked).
//
// Do NOT put a Socrata API Key *Secret* (or any real credential) here or anywhere
// client-side: a static site can't hide it, and it would ship to every visitor.
window.TAXI_APP_TOKEN = '';
