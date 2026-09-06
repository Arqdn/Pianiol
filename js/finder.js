// finder.js — turn a pasted link (or a typed song name) into playable notes.
//
// Pipeline:  link → video title (oEmbed) → identify artist/title
//                 → built-in library (fuzzy)      → strong hit? play it
//                 → public MIDI archives on the web → best file → download → parse → play
//                 → otherwise hand back the candidates we saw
//
// No audio is ever pulled from YouTube/TikTok — only the video's title is read.

import { fetchVideoMeta, extractUrlFromText } from './share.js';
import { normalizeTitle, fuzzyScore, searchSongs } from './search.js';
import { parseMidi, midiToSong } from './midi.js';
import { composeSong } from './ai.js';

export const LIBRARY_AUTO_THRESHOLD = 0.6; // library match good enough to auto-play
export const ONLINE_AUTO_THRESHOLD = 0.45; // web MIDI match good enough to auto-play
const NET_TIMEOUT = 9000;
const MAX_MIDI_BYTES = 3 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Identification                                                      */
/* ------------------------------------------------------------------ */

const SPLIT_RE = /\s+(?:-|–|—|\||•|:|~)\s+/;
const BY_RE = /^(.*?)\s+by\s+(.+)$/i;
// Fragments that are never a song name on their own ("1 hour", "extended", "hd"...).
const JUNK_RE = /^(?:\d+\s*(?:hours?|hrs?|h|min(?:ute)?s?|x)?|(?:extended|loop(?:ed)?|version|full|hd|hq|4k|8k|lyrics?|karaoke|instrumental|remix|cover|tutorial|topic|official|vevo|music|video|piano|guitar|violin|flute|synthesia)(?:\s+(?:version|edit|loop|mix))?)$/;

const isJunk = q => !q || q.length < 3 || JUNK_RE.test(q);

// Split a raw video title into artist/title parts using the common
// "Artist - Title" / "Title | Channel" / "Title by Artist" conventions and
// produce search queries in order of preference.
export function splitArtistTitle(raw) {
  const clean = String(raw || '').trim();
  const sep = SPLIT_RE.exec(clean);
  const parts = clean.split(SPLIT_RE).map(p => p.trim()).filter(Boolean);
  let artist = '';
  let title = clean;
  if (parts.length >= 2) {
    if (/[-–—]/.test(sep[0])) {
      // "Artist - Title" (YouTube convention).
      artist = parts[0];
      title = parts[1];
    } else {
      // "Title | Channel", "Title : subtitle" — the song is usually first.
      title = parts[0];
      artist = parts[1];
    }
  } else {
    const by = BY_RE.exec(clean);
    if (by) { title = by[1]; artist = by[2]; }
  }
  let nTitle = normalizeTitle(title);
  let nArtist = normalizeTitle(artist);
  const nFull = normalizeTitle(clean);
  if (isJunk(nTitle) && parts.length >= 2) {
    // "Für Elise - 1 Hour": the informative side was the other one.
    nTitle = normalizeTitle(parts[0] === title ? parts[1] : parts[0]);
    nArtist = '';
  }
  if (isJunk(nArtist)) nArtist = '';
  if (isJunk(nTitle)) nTitle = nFull;

  const queries = [];
  const push = q => { if (q && !isJunk(q) && !queries.includes(q)) queries.push(q); };
  push(nTitle && nArtist ? `${nArtist} ${nTitle}` : '');
  push(nTitle);
  // The "Artist - Title" convention isn't universal ("Title - Artist" is common
  // too), so the other half gets its turn before the raw full title.
  if (parts.length >= 2 && nArtist && nArtist.split(' ').length >= 2) push(nArtist);
  push(nFull);
  return { raw: clean, artist: nArtist, title: nTitle || nFull, queries };
}

// Resolve what a piece of user input *is*: a link (read its title) or a name.
export async function identify(input, { rawTitle = '', onStatus } = {}) {
  const url = extractUrlFromText(input);
  let videoTitle = rawTitle || '';
  let author = '';
  let provider = '';
  if (url) {
    onStatus?.('Reading the video title…');
    const meta = await fetchVideoMeta(url);
    if (meta && meta.title) {
      videoTitle = meta.title;
      author = meta.author || '';
      provider = meta.provider || '';
    }
  } else {
    videoTitle = String(input || '').trim();
  }
  if (!videoTitle) return null;
  const split = splitArtistTitle(videoTitle);
  // A channel name is often the artist; add it as a fallback query.
  if (author && !split.artist) {
    const a = normalizeTitle(author.replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, ''));
    if (a && a !== split.title) split.queries.push(`${a} ${split.title}`);
  }
  return { url, videoTitle, author, provider, ...split };
}

/* ------------------------------------------------------------------ */
/* Networking with CORS fallbacks                                      */
/* ------------------------------------------------------------------ */

const PROXIES = [
  u => u, // direct
  u => 'https://corsproxy.io/?' + encodeURIComponent(u),
  u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
];
let proxyPreference = 0; // remember the first route that worked for this session

async function timedFetch(url, ms, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onOuter = () => ctrl.abort();
  signal?.addEventListener('abort', onOuter, { once: true });
  try {
    return await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuter);
  }
}

// Fetch a URL as JSON or ArrayBuffer, trying direct first then CORS proxies.
// Resolves null on total failure; never throws (except on outer abort).
export async function fetchAny(url, { as = 'json', signal } = {}) {
  const order = [proxyPreference, ...PROXIES.map((_, i) => i).filter(i => i !== proxyPreference)];
  for (const i of order) {
    if (signal?.aborted) return null;
    try {
      const res = await timedFetch(PROXIES[i](url), NET_TIMEOUT, signal);
      if (!res.ok) continue;
      if (as === 'json') {
        const text = await res.text();
        const data = JSON.parse(text);
        if (data && typeof data === 'object') { proxyPreference = i; return data; }
      } else {
        const buf = await res.arrayBuffer();
        if (buf.byteLength > 0 && buf.byteLength <= MAX_MIDI_BYTES) { proxyPreference = i; return buf; }
      }
    } catch (err) {
      if (signal?.aborted) return null;
      // try the next route
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Online MIDI sources                                                 */
/* ------------------------------------------------------------------ */

function cleanFileName(name) {
  return String(name || '')
    .replace(/\.(midi?|kar)$/i, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMidiName(name) {
  return /\.(mid|midi|kar)$/i.test(String(name || ''));
}

// BitMidi — a large catalogue of user-uploaded MIDI files with a JSON search API.
export async function searchBitMidi(query, { signal } = {}) {
  const url = 'https://bitmidi.com/api/midi/search?q=' + encodeURIComponent(query) + '&page=0';
  const data = await fetchAny(url, { as: 'json', signal });
  const results = data?.result?.results;
  if (!Array.isArray(results)) return [];
  return results
    .filter(r => r && r.downloadUrl && isMidiName(r.downloadUrl))
    .map(r => {
      const display = cleanFileName(r.name || r.slug || '');
      return {
        source: 'bitmidi',
        sourceName: 'BitMidi',
        title: display || 'MIDI file',
        url: /^https?:\/\//.test(r.downloadUrl) ? r.downloadUrl : 'https://bitmidi.com' + r.downloadUrl,
        page: r.url ? 'https://bitmidi.com' + r.url : null,
        score: fuzzyScore(query, display),
      };
    });
}

// Internet Archive — search items, then list each item's files for .mid entries.
export async function searchArchive(query, { signal, maxItems = 6 } = {}) {
  const base = 'https://archive.org/advancedsearch.php?fl%5B%5D=identifier&fl%5B%5D=title&rows=12&page=1&output=json&q=';
  const qs = [
    `(${query}) AND format:(MIDI)`,
    `(${query}) AND (mediatype:audio OR mediatype:data)`,
  ];
  let docs = [];
  for (const q of qs) {
    const data = await fetchAny(base + encodeURIComponent(q), { as: 'json', signal });
    docs = data?.response?.docs || [];
    if (docs.length) break;
  }
  const items = docs
    .map(d => ({ id: d.identifier, title: String(d.title || d.identifier || ''), score: fuzzyScore(query, String(d.title || d.identifier || '')) }))
    .filter(d => d.id)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems);
  const out = [];
  await Promise.all(items.map(async item => {
    const files = await fetchAny('https://archive.org/metadata/' + encodeURIComponent(item.id) + '/files', { as: 'json', signal });
    const list = files?.result;
    if (!Array.isArray(list)) return;
    for (const f of list) {
      if (!f || !isMidiName(f.name)) continue;
      const display = cleanFileName(f.name);
      out.push({
        source: 'archive',
        sourceName: 'Internet Archive',
        title: display || item.title,
        subtitle: item.title !== display ? item.title : '',
        url: 'https://archive.org/download/' + encodeURIComponent(item.id) + '/' + encodeURIComponent(f.name),
        page: 'https://archive.org/details/' + encodeURIComponent(item.id),
        score: Math.max(fuzzyScore(query, display), item.score * 0.9),
      });
    }
  }));
  return out;
}

// Search every online source for a query list; returns candidates sorted by score.
export async function searchOnline(queries, { signal, onStatus } = {}) {
  const seen = new Map();
  const add = c => {
    if (!c || !c.url) return;
    const prev = seen.get(c.url);
    if (!prev || prev.score < c.score) seen.set(c.url, c);
  };
  // Primary query hits both sources; secondary queries only if the first came up dry.
  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    onStatus?.(qi === 0 ? 'Searching MIDI archives on the web…' : `Trying "${q}"…`);
    const settled = await Promise.allSettled([
      searchBitMidi(q, { signal }),
      searchArchive(q, { signal }),
    ]);
    for (const s of settled) if (s.status === 'fulfilled') s.value.forEach(add);
    const good = [...seen.values()].filter(c => c.score >= ONLINE_AUTO_THRESHOLD);
    if (good.length || signal?.aborted) break;
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

// Download a candidate MIDI and turn it into a runtime song. Null on failure.
export async function loadCandidate(candidate, { signal, onStatus } = {}) {
  onStatus?.(`Downloading "${candidate.title}"…`);
  const buf = await fetchAny(candidate.url, { as: 'buffer', signal });
  if (!buf) return null;
  try {
    const parsed = parseMidi(buf);
    const song = midiToSong(parsed);
    if (!song.notes || song.notes.length < 8) return null;
    if (!parsed.name || /^(untitled|track ?\d*|piano|melody)$/i.test(parsed.name)) {
      song.title = candidate.title;
    }
    song.artist = candidate.subtitle || `via ${candidate.sourceName}`;
    song.sourceUrl = candidate.page || candidate.url;
    return song;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* The resolver                                                        */
/* ------------------------------------------------------------------ */

// Resolve user input into something playable.
//   library:  array of library songs (title/artist/aliases/notes...)
//   toSong:   library song → runtime song
//   ai:       { apiKey, model } — when apiKey is set, the AI writes the notes
//   online:   { enabled } — whether to also search public MIDI archives
// Returns { kind: 'library'|'ai'|'online'|'none', identity, song?, score?, candidates, aiError?, needsKey? }
export async function resolve(input, { library, toSong, rawTitle = '', onStatus, signal, ai = {}, online = { enabled: false } } = {}) {
  const identity = await identify(input, { rawTitle, onStatus });
  if (!identity) return { kind: 'none', identity: null, candidates: [], reason: 'unreadable' };

  // 1. Built-in library.
  onStatus?.(`Found "${identity.videoTitle}" — checking the library…`);
  let libHits = [];
  for (const q of identity.queries) {
    for (const h of searchSongs(q, library, { limit: 5 })) {
      const prev = libHits.find(x => x.song === h.song);
      if (!prev) libHits.push(h); else if (h.score > prev.score) prev.score = h.score;
    }
  }
  libHits.sort((a, b) => b.score - a.score);
  const libCandidates = libHits.map(h => ({
    source: 'library', sourceName: 'Pianiol library', title: h.song.title,
    subtitle: h.song.artist, score: h.score, song: h.song,
  }));
  if (libHits[0] && libHits[0].score >= LIBRARY_AUTO_THRESHOLD) {
    return {
      kind: 'library', identity, score: libHits[0].score,
      song: toSong(libHits[0].song), candidates: libCandidates,
    };
  }

  // 2. AI writes the notes from its knowledge of the piece.
  let aiError = null;
  if (ai && ai.apiKey) {
    try {
      const song = await composeSong(
        { title: identity.title || identity.videoTitle, artist: identity.artist, context: identity.videoTitle },
        { apiKey: ai.apiKey, model: ai.model, signal, onStatus },
      );
      return { kind: 'ai', identity, song, candidates: libCandidates, score: 1 };
    } catch (err) {
      if (signal?.aborted) throw err;
      aiError = err && err.message ? err.message : 'AI request failed.';
    }
  }

  // 3. Public MIDI archives (optional).
  let onlineHits = [];
  if (online && online.enabled) {
    onlineHits = await searchOnline(identity.queries, { signal, onStatus });
  }
  const candidates = [...libCandidates, ...onlineHits].sort((a, b) => b.score - a.score);
  const tryList = onlineHits.filter(c => c.score >= ONLINE_AUTO_THRESHOLD).slice(0, 3);
  for (const c of tryList) {
    if (signal?.aborted) break;
    const song = await loadCandidate(c, { signal, onStatus });
    if (song) return { kind: 'online', identity, score: c.score, song, candidate: c, candidates, aiError };
  }

  return {
    kind: 'none', identity, candidates, aiError,
    needsKey: !(ai && ai.apiKey),
    reason: aiError ? 'ai-failed' : onlineHits.length ? 'weak' : 'nothing',
  };
}
