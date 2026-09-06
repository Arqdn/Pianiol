// ai.js — ask an AI model to write out a song as note data ("AI finds the notes").
//
// Two providers, both called straight from the browser with the user's own key
// (kept only in this device's localStorage):
//   • Anthropic (Claude) — streaming + structured outputs (JSON schema) + refusal fallbacks
//   • OpenRouter — OpenAI-compatible chat completions; default model NVIDIA Nemotron Ultra (free)

import { songToNotes } from './library.js';

export const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic — Claude', keyPrefix: 'sk-ant-', keyStorage: 'pianiol.anthropicKey', modelStorage: 'pianiol.aiModel' },
  { id: 'openrouter', name: 'OpenRouter — Nemotron Ultra & other models', keyPrefix: 'sk-or-', keyStorage: 'pianiol.openrouterKey', modelStorage: 'pianiol.openrouterModel' },
];
export const AI_MODELS = [
  { id: 'claude-opus-5', name: 'Claude Opus 5 — best accuracy' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 — faster, cheaper' },
];
export const DEFAULT_MODEL = 'claude-opus-5';
export const OPENROUTER_DEFAULT_MODEL = 'nvidia/llama-3.1-nemotron-ultra-253b-v1:free';

const PROVIDER_STORAGE = 'pianiol.aiProvider';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } }
function providerInfo(id) { return PROVIDERS.find(p => p.id === id) || PROVIDERS[0]; }

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export function detectProvider(key) {
  const k = String(key || '').trim();
  const p = PROVIDERS.find(x => k.startsWith(x.keyPrefix));
  return p ? p.id : null;
}
export function getProvider() {
  const saved = lsGet(PROVIDER_STORAGE);
  if (PROVIDERS.some(p => p.id === saved)) return saved;
  const withKey = PROVIDERS.find(p => (lsGet(p.keyStorage) || '').trim());
  return withKey ? withKey.id : 'anthropic';
}
export function setProvider(id) { lsSet(PROVIDER_STORAGE, PROVIDERS.some(p => p.id === id) ? id : null); }

export function getApiKey(provider = getProvider()) { return (lsGet(providerInfo(provider).keyStorage) || '').trim(); }
// Saving a key whose prefix identifies a provider switches to that provider.
export function setApiKey(key, provider) {
  const k = key ? String(key).trim() : '';
  const id = provider || detectProvider(k) || getProvider();
  lsSet(providerInfo(id).keyStorage, k || null);
  if (k) setProvider(id);
  return id;
}
export function hasApiKey(provider = getProvider()) { return getApiKey(provider).length > 0; }

export function getAiModel(provider = getProvider()) {
  const m = lsGet(providerInfo(provider).modelStorage);
  if (provider === 'anthropic') return AI_MODELS.some(x => x.id === m) ? m : DEFAULT_MODEL;
  return (m || '').trim() || OPENROUTER_DEFAULT_MODEL;
}
export function setAiModel(id, provider = getProvider()) {
  const info = providerInfo(provider);
  if (provider === 'anthropic') lsSet(info.modelStorage, AI_MODELS.some(x => x.id === id) ? id : null);
  else lsSet(info.modelStorage, (id || '').trim() || null);
}

// One-tap setup link: "#setup&provider=openrouter&key=sk-or-…&model=…" (fragment never reaches the server).
export function applySetupParams(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return null;
  const p = new URLSearchParams(raw);
  if (!p.has('setup')) return null;
  const key = (p.get('key') || '').trim();
  const provider = p.get('provider') || detectProvider(key);
  if (!key || !PROVIDERS.some(x => x.id === provider)) return null;
  setApiKey(key, provider);
  if (p.get('model')) setAiModel(p.get('model'), provider);
  return { provider };
}

/* ------------------------------------------------------------------ */
/* Prompt & schema                                                     */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `You are the transcriber inside Pianiol, a falling-notes piano app. Given a song name (and sometimes the artist or the title of a video it came from), write the piece out as note data the app can play.

Note format: each entry in "notes" is one string, "start duration pitch hand".
- start and duration are in beats from the beginning of the piece; decimals are fine (0.5 = an eighth note when the beat is a quarter). Chords are several entries with the same start.
- pitch uses scientific notation with sharps only: C4 is middle C; write A#3, never Bb3.
- hand is 1 for the melody / right hand and 0 for the accompaniment / left hand.

What to write:
- Melody (hand 1): the real, recognizable tune with correct pitches and rhythm. Cover the main material — for a song, a verse and the chorus; for a classical piece, its main theme and natural repeat — typically 60 to 200 melody notes.
- Accompaniment (hand 0): a simple, correct left hand that follows the piece's actual harmony — bass notes with broken or block chords, mostly in octaves 2 and 3, roughly one note per beat.
- bpm: a natural performance tempo. beatsPerBar: the number of beats per bar in the meter you used.
- title and artist: the canonical names of the piece you transcribed.
- confidence: "high" if you know the piece well, "medium" if you know the main hook but are reconstructing the rest, "low" if you are largely guessing.

If the request is vague or names a video rather than a song, pick the most likely piece it refers to and transcribe that.`;

// Providers without structured outputs get the format spelled out and must answer with bare JSON.
const SONG_EXAMPLE = '{"title":"Twinkle Twinkle Little Star","artist":"Traditional","bpm":100,"beatsPerBar":4,"confidence":"high","notes":["0 1 C4 1","1 1 C4 1","2 1 G4 1","0 2 C3 0","2 2 E3 0"]}';
function jsonOnlySuffix(example) {
  return `\n\nAnswer with ONLY a JSON object — no prose before or after it, no markdown fences — shaped exactly like this example:\n${example}`;
}

const SONG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'artist', 'bpm', 'beatsPerBar', 'confidence', 'notes'],
  properties: {
    title: { type: 'string' },
    artist: { type: 'string' },
    bpm: { type: 'number' },
    beatsPerBar: { type: 'integer' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'array', items: { type: 'string' } },
  },
};

const NOTE_LINE_RE = /^\s*(\d+(?:\.\d+)?)\s+(\d*\.?\d+)\s+([A-G]#?-?\d)\s+([01])\s*$/;

function userMessage({ title, artist, context }) {
  const lines = [`Song: ${title}`];
  if (artist) lines.push(`Artist: ${artist}`);
  if (context && context !== title) lines.push(`Video title: ${context}`);
  lines.push('Write out the notes.');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Shared plumbing                                                     */
/* ------------------------------------------------------------------ */

function friendlyError(status, body, providerName) {
  const msg = body && body.error && (body.error.message || body.error.msg) ? String(body.error.message || body.error.msg) : '';
  if (status === 401) return 'That API key was rejected — check it and try again.';
  if (status === 402) return `Your ${providerName} account is out of credits — top it up or pick a free model.`;
  if (status === 403) return 'This API key is not allowed to do that (permission denied).';
  if (status === 429) return 'Rate limited by the API — wait a moment and try again.';
  if (status === 529 || status === 503 || status === 502) return 'The AI service is overloaded right now — try again shortly.';
  if (status === 400 && /credit|billing|balance/i.test(msg)) return `Your ${providerName} account has no credits — add billing and try again.`;
  return msg ? `AI request failed: ${msg}` : `AI request failed (HTTP ${status}).`;
}

async function postStream(url, headers, body, signal) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if (signal && signal.aborted) throw err;
    throw new Error('Could not reach the AI service — check your connection.');
  }
  return res;
}

// Read an SSE body, calling onData(jsonObject) for each "data:" frame.
async function readSse(res, onData) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue; // skips ": keep-alive" comments and event: lines
        const json = line.slice(5).trim();
        if (!json || json === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(json); } catch { continue; } // skip a malformed frame, keep streaming
        onData(evt); // provider error events throw from here on purpose
      }
    }
  }
}

// Pull the JSON object out of a model reply that may include reasoning, fences or prose.
export function extractJson(text) {
  let s = String(text || '');
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start === -1) throw new SyntaxError('no JSON object in reply');
  // Walk to the matching close brace so trailing prose doesn't break the parse.
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return JSON.parse(s.slice(start, i + 1)); }
  }
  return JSON.parse(s.slice(start)); // unbalanced → let JSON.parse report it
}

// Parse the model's JSON into a library-format song, validating every note.
export function parseAiSong(json, fallbackTitle) {
  const data = typeof json === 'string' ? extractJson(json) : json;
  const notes = [];
  for (const line of data.notes || []) {
    const m = NOTE_LINE_RE.exec(String(line));
    if (!m) continue;
    const start = parseFloat(m[1]);
    const dur = parseFloat(m[2]);
    if (!(dur > 0) || start < 0 || start > 4000) continue;
    notes.push([start, dur, m[3], parseInt(m[4], 10)]);
  }
  const melody = notes.filter(n => n[3] === 1).length;
  if (melody < 8) throw new Error('The AI did not produce a usable melody — try again or rephrase the song name.');
  const bpm = Number(data.bpm);
  return {
    id: 'ai-' + String(data.title || fallbackTitle || 'song').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    title: data.title || fallbackTitle || 'AI transcription',
    artist: data.artist || '',
    aliases: [],
    bpm: bpm >= 30 && bpm <= 250 ? bpm : 100,
    beatsPerBar: Number(data.beatsPerBar) || 4,
    confidence: ['high', 'medium', 'low'].includes(data.confidence) ? data.confidence : 'medium',
    notes: notes.sort((a, b) => a[0] - b[0]),
  };
}

function progressReporter(onStatus) {
  let last = -1;
  return soFar => {
    const n = (soFar.match(/"\s*,/g) || []).length; // each finished note string ends with quote-comma
    if (n !== last && n % 5 === 0) { last = n; onStatus && onStatus(`AI is writing the notes… ${n} so far`); }
  };
}

/* ------------------------------------------------------------------ */
/* Anthropic (Claude)                                                  */
/* ------------------------------------------------------------------ */

async function requestAnthropic({ system, user, schema, maxTokens }, { apiKey, model, signal, onStatus }) {
  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: 'high', format: { type: 'json_schema', schema } },
  };
  // Server-side refusal fallbacks route a declined request to another model in the same call.
  if (model === 'claude-opus-5') body.fallbacks = 'default';
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true', // required for calls made directly from a web page
  };
  if (body.fallbacks) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';

  const res = await postStream(ANTHROPIC_URL, headers, body, signal);
  if (!res.ok) {
    let parsed = null;
    try { parsed = await res.json(); } catch { /* not json */ }
    throw new Error(friendlyError(res.status, parsed, 'Anthropic'));
  }
  const report = progressReporter(onStatus);
  let text = '', stopReason = null, servedBy = model;
  await readSse(res, evt => {
    if (evt.type === 'message_start' && evt.message && evt.message.model) servedBy = evt.message.model;
    else if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') { text += evt.delta.text; report(text); }
    else if (evt.type === 'message_delta' && evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
    else if (evt.type === 'error') throw new Error(evt.error && evt.error.message ? evt.error.message : 'stream error');
  });
  if (stopReason === 'refusal') throw new Error('The AI declined to transcribe that request.');
  if (stopReason === 'max_tokens') throw new Error('The AI ran out of room writing this piece — try again.');
  return { text, servedBy };
}

/* ------------------------------------------------------------------ */
/* OpenRouter (OpenAI-compatible)                                      */
/* ------------------------------------------------------------------ */

// Find a live model id on OpenRouter matching a wanted id (e.g. when a ":free" variant was retired).
export async function resolveOpenRouterModel(wanted, { signal } = {}) {
  let list;
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, { signal });
    if (!res.ok) return null;
    list = (await res.json()).data || [];
  } catch { return null; }
  const ids = list.map(m => String(m.id || ''));
  if (ids.includes(wanted)) return wanted;
  const base = wanted.replace(/:free$/, '');
  if (ids.includes(base)) return base;
  const words = base.split('/').pop().split(/[-.]/).filter(w => /^[a-z]+$/i.test(w) && w.length > 3);
  const scored = ids
    .map(id => ({ id, hits: words.filter(w => id.toLowerCase().includes(w.toLowerCase())).length }))
    .filter(x => x.hits >= Math.max(1, words.length - 1))
    .sort((a, b) => b.hits - a.hits || (b.id.endsWith(':free') ? 1 : 0) - (a.id.endsWith(':free') ? 1 : 0));
  return scored.length ? scored[0].id : null;
}

async function requestOpenRouter(req, { apiKey, model, signal, onStatus }, _retried = false) {
  const { system, user, jsonExample, maxTokens } = req;
  const body = {
    model,
    stream: true,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [
      // "detailed thinking off" is Nemotron's switch for direct answers; harmless for other models.
      { role: 'system', content: 'detailed thinking off\n\n' + system + jsonOnlySuffix(jsonExample) },
      { role: 'user', content: user },
    ],
  };
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer ' + apiKey,
    'x-title': 'Pianiol',
  };
  const res = await postStream(OPENROUTER_URL, headers, body, signal);
  if (!res.ok) {
    let parsed = null;
    try { parsed = await res.json(); } catch { /* not json */ }
    const msg = parsed && parsed.error ? String(parsed.error.message || '') : '';
    // Model id gone (e.g. a ":free" variant retired)? Look up the current id once and retry.
    if (!_retried && (res.status === 404 || res.status === 400) && /model|endpoint/i.test(msg)) {
      onStatus && onStatus('Looking up the current model id…');
      const found = await resolveOpenRouterModel(model, { signal });
      if (found && found !== model) {
        setAiModel(found, 'openrouter');
        return requestOpenRouter(req, { apiKey, model: found, signal, onStatus }, true);
      }
    }
    throw new Error(friendlyError(res.status, parsed, 'OpenRouter'));
  }
  const report = progressReporter(onStatus);
  let text = '', finish = null, servedBy = model;
  await readSse(res, evt => {
    if (evt.error) throw new Error(evt.error.message || 'stream error');
    if (evt.model) servedBy = evt.model;
    const choice = evt.choices && evt.choices[0];
    if (!choice) return;
    if (choice.delta && typeof choice.delta.content === 'string') { text += choice.delta.content; report(text); }
    if (choice.finish_reason) finish = choice.finish_reason;
  });
  if (finish === 'length') throw new Error('The AI ran out of room writing this piece — try again.');
  if (finish === 'content_filter') throw new Error('The AI declined to transcribe that request.');
  return { text, servedBy };
}

/* ------------------------------------------------------------------ */
/* Compose                                                             */
/* ------------------------------------------------------------------ */

// Generic "ask the configured AI for a JSON object" — used for songs and for coaching.
// req: { system, user, schema, jsonExample, maxTokens }. Returns { data, text, servedBy }.
export async function askJson(req, { provider, apiKey, model, signal, onStatus } = {}) {
  const prov = provider || getProvider();
  const key = apiKey || getApiKey(prov);
  if (!key) throw new Error('No API key set.');
  const useModel = model || getAiModel(prov);
  const run = prov === 'openrouter' ? requestOpenRouter : requestAnthropic;
  const { text, servedBy } = await run({ maxTokens: 4000, ...req }, { apiKey: key, model: useModel, signal, onStatus });
  let data;
  try {
    data = extractJson(text);
  } catch {
    throw new Error('The AI reply was cut off or not in the expected format — please try again.');
  }
  return { data, text, servedBy, provider: prov };
}

// Ask the configured AI for the notes of a song. Returns a runtime song (engine
// format) with .artist, .confidence and .aiModel set. Throws with a friendly message.
export async function composeSong(song, { provider, apiKey, model, signal, onStatus } = {}) {
  const prov = provider || getProvider();
  onStatus && onStatus('Asking AI to write the notes…');
  const { data, servedBy } = await askJson(
    { system: SYSTEM_PROMPT, user: userMessage(song), schema: SONG_SCHEMA, jsonExample: SONG_EXAMPLE, maxTokens: prov === 'openrouter' ? 12000 : 16000 },
    { provider: prov, apiKey, model, signal, onStatus },
  );
  const libSong = parseAiSong(data, song.title);
  const out = songToNotes(libSong);
  out.artist = libSong.artist ? `${libSong.artist} · written by AI` : 'written by AI';
  out.confidence = libSong.confidence;
  out.aiModel = servedBy;
  out.aiProvider = prov;
  return out;
}
