// search.js — title normalization and fuzzy song search for Pianiol.
// Plain ES module, no dependencies, no DOM access.

// Words that, when found inside a bracketed segment, mark the whole segment as noise.
const BRACKET_NOISE_RE = new RegExp(
  '\\b(?:official|video|videos|mv|m/v|lyric|lyrics|audio|hd|hq|4k|8k|live|cover|' +
    'remix|remaster|remastered|visualizer|visualiser|tutorial|synthesia|slowed|' +
    'reverb|sped|tiktok|short|shorts|explicit|version|edit|clip|feat|ft)\\b',
  'i'
);

// Unbracketed noise phrases, matched on whitespace boundaries. Longest first so
// "official music video" wins over "music video".
const NOISE_PHRASES = [
  'official music video',
  'official lyric video',
  'official video',
  'official audio',
  'music video',
  'lyric video',
  'full version',
  'piano tutorial',
  'piano cover',
  'easy piano',
  'on tiktok',
  '#shorts',
  'sped up',
  'synthesia',
  'lyrics',
  'slowed',
  'reverb',
  'tiktok',
  'shorts',
  'audio',
  'hd',
  '4k',
].sort((a, b) => b.length - a.length);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NOISE_PHRASE_RE = new RegExp(
  '(?:^|\\s)(?:' + NOISE_PHRASES.map(escapeRe).join('|') + ')(?=\\s|$)',
  'gi'
);

// "feat." / "ft." / "featuring" plus everything up to the next delimiter.
const FEAT_RE = /\b(?:featuring|feat\.?|ft\.?)\s+[^\-–—|()[\]{}]*/gi;
const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;
const BRACKET_RE = /\(([^()]*)\)|\[([^\]]*)\]|\{([^{}]*)\}/g;
const COMBINING_RE = /\p{M}/gu;
const SYMBOL_RE = /[^\p{L}\p{N}\s']/gu; // dashes, pipes, emoji, punctuation → space

export function normalizeTitle(raw) {
  if (raw == null) return '';
  let s = String(raw).toLowerCase().normalize('NFD').replace(COMBINING_RE, '');
  s = s.replace(/[’‘`´]/g, "'");
  // Bracketed noise segments (two passes to cope with simple nesting).
  for (let pass = 0; pass < 2; pass++) {
    s = s.replace(BRACKET_RE, (m, a, b, c) =>
      BRACKET_NOISE_RE.test(a ?? b ?? c ?? '') ? ' ' : m
    );
  }
  s = s.replace(FEAT_RE, ' ');
  s = s.replace(HASHTAG_RE, ' ');
  // Strip symbols/emoji; this also turns "artist - title" dashes into spaces,
  // keeping both sides.
  s = s.replace(SYMBOL_RE, ' ');
  s = s.replace(/\s+'\s+|(?:^|\s)'+|'+(?:\s|$)/g, ' '); // orphaned apostrophes
  s = s.replace(NOISE_PHRASE_RE, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function bigramCounts(s) {
  const counts = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  return counts;
}

function diceCoefficient(a, b) {
  if (a === b) return a.length ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const ca = bigramCounts(a);
  const cb = bigramCounts(b);
  let overlap = 0;
  for (const [gram, n] of ca) {
    const m = cb.get(gram);
    if (m) overlap += Math.min(n, m);
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

// 1 for identical tokens; prefix matches ("moon" vs "moonlight") earn
// partial credit proportional to the shared prefix; 0 otherwise.
function tokenSimilarity(a, b) {
  if (a === b) return 1;
  const shorter = a.length <= b.length ? a : b;
  const longer = shorter === a ? b : a;
  if (shorter.length >= 2 && longer.startsWith(shorter)) {
    return shorter.length / longer.length;
  }
  return 0;
}

// Greedy one-to-one assignment of query tokens to target tokens.
function softTokenOverlap(qTokens, tTokens) {
  const used = new Array(tTokens.length).fill(false);
  let credit = 0;
  let exact = 0;
  for (const q of qTokens) {
    let bestIdx = -1;
    let best = 0;
    for (let i = 0; i < tTokens.length; i++) {
      if (used[i]) continue;
      const c = tokenSimilarity(q, tTokens[i]);
      if (c > best) {
        best = c;
        bestIdx = i;
        if (best === 1) break;
      }
    }
    if (bestIdx !== -1) {
      used[bestIdx] = true;
      credit += best;
      if (best === 1) exact++;
    }
  }
  return { credit, exact };
}

function scoreNormalized(nq, nt) {
  if (!nq || !nt) return 0;
  if (nq === nt) return 1;
  const qTokens = nq.split(' ');
  const tTokens = nt.split(' ');
  const { credit, exact } = softTokenOverlap(qTokens, tTokens);
  const jaccard = credit > 0 ? credit / (qTokens.length + tTokens.length - credit) : 0;
  const dice = diceCoefficient(nq.replace(/ /g, ''), nt.replace(/ /g, ''));
  const coverage = credit / qTokens.length; // how much of the query was found
  let score = Math.max(0.55 * jaccard + 0.45 * dice, 0.7 * coverage);
  if (exact === qTokens.length) {
    // Every query token is present verbatim in the target.
    score = Math.max(score, 0.75 + 0.25 * score);
  }
  return Math.min(1, Math.max(0, score));
}

export function fuzzyScore(query, target) {
  return scoreNormalized(normalizeTitle(query), normalizeTitle(target));
}

export function searchSongs(query, songs, { limit = 8 } = {}) {
  const nq = normalizeTitle(query);
  if (!nq || !Array.isArray(songs)) return [];
  const results = [];
  for (const song of songs) {
    if (!song || typeof song !== 'object') continue;
    const candidates = [];
    if (song.title) candidates.push(String(song.title));
    if (song.artist && song.title) {
      candidates.push(String(song.artist) + ' ' + String(song.title));
    }
    if (Array.isArray(song.aliases)) {
      for (const alias of song.aliases) {
        if (alias) candidates.push(String(alias));
      }
    }
    let best = 0;
    for (const candidate of candidates) {
      const s = scoreNormalized(nq, normalizeTitle(candidate));
      if (s > best) best = s;
      if (best >= 1) break;
    }
    if (best >= 0.28) results.push({ song, score: best });
  }
  results.sort(
    (a, b) =>
      b.score - a.score ||
      String(a.song.title || '').localeCompare(String(b.song.title || ''))
  );
  return results.slice(0, Math.max(0, limit | 0));
}
