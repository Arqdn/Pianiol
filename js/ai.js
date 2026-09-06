// ai.js — ask Claude to write out a song as note data ("AI finds the notes").
//
// Runs straight from the browser against the Claude API with the user's own
// key (stored only in this device's localStorage). Streams the response so the
// UI can show progress, uses structured outputs so the reply is guaranteed JSON,
// and opts into server-side refusal fallbacks.

import { songToNotes } from './library.js';

export const AI_MODELS = [
  { id: 'claude-opus-5', name: 'Claude Opus 5 — best accuracy' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 — faster, cheaper' },
];
export const DEFAULT_MODEL = 'claude-opus-5';

const KEY_STORAGE = 'pianiol.anthropicKey';
const MODEL_STORAGE = 'pianiol.aiModel';
const API_URL = 'https://api.anthropic.com/v1/messages';

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } }

export function getApiKey() { return (lsGet(KEY_STORAGE) || '').trim(); }
export function setApiKey(key) { lsSet(KEY_STORAGE, key ? String(key).trim() : null); }
export function hasApiKey() { return getApiKey().length > 0; }
export function getAiModel() {
  const m = lsGet(MODEL_STORAGE);
  return AI_MODELS.some(x => x.id === m) ? m : DEFAULT_MODEL;
}
export function setAiModel(id) { lsSet(MODEL_STORAGE, AI_MODELS.some(x => x.id === id) ? id : null); }

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

/* ------------------------------------------------------------------ */
/* Request                                                             */
/* ------------------------------------------------------------------ */

function friendlyError(status, body) {
  const msg = body && body.error && body.error.message ? body.error.message : '';
  if (status === 401) return 'That API key was rejected — check it and try again.';
  if (status === 403) return 'This API key is not allowed to do that (permission denied).';
  if (status === 429) return 'Rate limited by the API — wait a moment and try again.';
  if (status === 529 || status === 503) return 'The AI service is overloaded right now — try again shortly.';
  if (status === 400 && /credit|billing|balance/i.test(msg)) return 'Your API account has no credits — add billing at console.anthropic.com.';
  return msg ? `AI request failed: ${msg}` : `AI request failed (HTTP ${status}).`;
}

// Stream one Claude request; resolves { text, stopReason, model } once the stream ends.
async function streamMessage(body, { apiKey, signal, onProgress }) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    // Required for calls made directly from a web page (no server in between).
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (body.fallbacks) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';

  let res;
  try {
    res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if (signal && signal.aborted) throw err;
    throw new Error('Could not reach the AI service — check your connection.');
  }
  if (!res.ok) {
    let parsed = null;
    try { parsed = await res.json(); } catch { /* not json */ }
    throw new Error(friendlyError(res.status, parsed));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let stopReason = null;
  let model = body.model;

  const handle = evt => {
    if (evt.type === 'message_start' && evt.message && evt.message.model) model = evt.message.model;
    else if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
      text += evt.delta.text;
      if (onProgress) onProgress(text);
    } else if (evt.type === 'message_delta' && evt.delta && evt.delta.stop_reason) {
      stopReason = evt.delta.stop_reason;
    } else if (evt.type === 'error') {
      throw new Error(evt.error && evt.error.message ? evt.error.message : 'stream error');
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json || json === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(json); } catch { continue; } // skip a malformed frame, keep streaming
        handle(evt); // API 'error' events throw from here on purpose
      }
    }
  }
  return { text, stopReason, model };
}

/* ------------------------------------------------------------------ */
/* Compose                                                             */
/* ------------------------------------------------------------------ */

// Parse the model's JSON into a library-format song, validating every note.
export function parseAiSong(json, fallbackTitle) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
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
    confidence: data.confidence || 'medium',
    notes: notes.sort((a, b) => a[0] - b[0]),
  };
}

// Ask Claude for the notes of a song. Returns a runtime song (engine format)
// with .artist, .confidence and .aiModel set. Throws with a friendly message.
export async function composeSong({ title, artist = '', context = '' }, { apiKey, model, signal, onStatus } = {}) {
  const key = apiKey || getApiKey();
  if (!key) throw new Error('No API key set.');
  const useModel = model || getAiModel();

  const lines = [`Song: ${title}`];
  if (artist) lines.push(`Artist: ${artist}`);
  if (context && context !== title) lines.push(`Video title: ${context}`);
  lines.push('Write out the notes.');

  const body = {
    model: useModel,
    max_tokens: 16000,
    stream: true,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: lines.join('\n') }],
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: SONG_SCHEMA },
    },
  };
  // Server-side refusal fallbacks route a declined request to another model in the same call.
  if (useModel === 'claude-opus-5') body.fallbacks = 'default';

  onStatus && onStatus('Asking AI to write the notes…');
  let lastCount = -1;
  const { text, stopReason, model: servedBy } = await streamMessage(body, {
    apiKey: key,
    signal,
    onProgress(soFar) {
      // Each finished note string ends with a quote-comma pair.
      const n = (soFar.match(/"\s*,/g) || []).length;
      if (n !== lastCount && n % 5 === 0) { lastCount = n; onStatus && onStatus(`AI is writing the notes… ${n} so far`); }
    },
  });

  if (stopReason === 'refusal') throw new Error('The AI declined to transcribe that request.');
  if (stopReason === 'max_tokens') throw new Error('The AI ran out of room writing this piece — try again.');

  let libSong;
  try {
    libSong = parseAiSong(text, title);
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error('The AI reply was cut off — please try again.');
    throw err;
  }
  const song = songToNotes(libSong);
  song.artist = libSong.artist ? `${libSong.artist} · written by AI` : 'written by AI';
  song.confidence = libSong.confidence;
  song.aiModel = servedBy;
  return song;
}
