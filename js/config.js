// config.js — optional built-in AI access so Pianiol works with no setup.
//
// Pianiol is a static site with no server, so a key placed here becomes part
// of the public app and is used by every visitor. To ship your own free-tier
// OpenRouter key, paste it between the quotes on the openrouterKey line and
// commit — the site redeploys automatically. Anyone can still paste a
// different key under ✨ AI notes, which takes precedence.
export const BUILT_IN = {
  provider: 'openrouter',
  openrouterKey: '',
  openrouterModel: 'nvidia/llama-3.1-nemotron-ultra-253b-v1:free',
};
