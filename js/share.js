// share.js — Web Share Target parsing and video metadata fetching for Pianiol.
// Plain ES module, no dependencies, no DOM access.

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`]+/i;
const TRAILING_PUNCT_RE = /[)\]}>.,;:!?»"']+$/;

// First http(s) URL substring in a blob of text, or null. Exported for reuse
// by the "paste a link" box.
export function extractUrlFromText(text) {
  if (typeof text !== 'string' || !text) return null;
  const match = URL_IN_TEXT_RE.exec(text);
  if (!match) return null;
  const url = match[0].replace(TRAILING_PUNCT_RE, '');
  return url.length > 'https://'.length ? url : null;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function detectSource(url) {
  if (!url) return 'unknown';
  const host = hostOf(url);
  if (!host) return 'unknown';
  if (
    host === 'youtu.be' ||
    host.endsWith('.youtu.be') ||
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtube-nocookie.com' ||
    host.endsWith('.youtube-nocookie.com')
  ) {
    return 'youtube';
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  return 'unknown';
}

function stripUrls(text) {
  return text.replace(/https?:\/\/[^\s<>"'`]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

// Parse a Web Share Target GET's URLSearchParams (params: title, text, url).
// Android YouTube puts the URL in "text" (sometimes with the title before it);
// TikTok shares a whole line in "text" too.
export function parseSharedParams(searchParams) {
  if (!searchParams || typeof searchParams.get !== 'function') return null;
  const title = (searchParams.get('title') || '').trim();
  const text = (searchParams.get('text') || '').trim();
  const urlParam = (searchParams.get('url') || '').trim();

  const videoUrl =
    extractUrlFromText(urlParam) ||
    extractUrlFromText(text) ||
    extractUrlFromText(title);

  let rawTitle = '';
  if (title) rawTitle = stripUrls(title);
  if (!rawTitle && text) rawTitle = stripUrls(text);

  if (!videoUrl && !rawTitle) return null;
  return { videoUrl: videoUrl || null, rawTitle, source: detectSource(videoUrl) };
}

async function fetchJson(url, timeoutMs) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      signal: controller ? controller.signal : undefined,
      headers: { accept: 'application/json' },
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// Fetch {title, author, provider} for a video URL via oEmbed endpoints.
// Tries each endpoint in order with a 6s timeout; first success wins;
// every failure path resolves to null — this never throws.
export async function fetchVideoMeta(videoUrl) {
  if (typeof videoUrl !== 'string') return null;
  const url = videoUrl.trim();
  if (!/^https?:\/\//i.test(url)) return null;

  const enc = encodeURIComponent(url);
  const source = detectSource(url);
  const endpoints = ['https://noembed.com/embed?url=' + enc];
  if (source === 'youtube') {
    endpoints.push('https://www.youtube.com/oembed?url=' + enc + '&format=json');
  } else if (source === 'tiktok') {
    endpoints.push('https://www.tiktok.com/oembed?url=' + enc);
  }

  for (const endpoint of endpoints) {
    const data = await fetchJson(endpoint, 6000);
    if (!data) continue;
    // noembed reports failures as {error: "..."} with HTTP 200.
    if (data.error) continue;
    const title = typeof data.title === 'string' ? data.title.trim() : '';
    if (!title) continue;
    const author = typeof data.author_name === 'string' ? data.author_name.trim() : '';
    let provider =
      typeof data.provider_name === 'string' && data.provider_name.trim()
        ? data.provider_name.trim()
        : '';
    if (!provider) {
      provider = source === 'youtube' ? 'YouTube' : source === 'tiktok' ? 'TikTok' : 'unknown';
    }
    return { title, author, provider };
  }
  return null;
}

const YT_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const YT_PATH_PREFIXES = new Set(['shorts', 'embed', 'live', 'v']);

// hqdefault thumbnail URL for a YouTube video URL (watch?v=, youtu.be/,
// shorts/, embed/), else null.
export function videoIdThumb(videoUrl) {
  if (typeof videoUrl !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(videoUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^(?:www\.|m\.|music\.)/, '');
  let id = null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be') {
    id = parts[0] || null;
  } else if (
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtube-nocookie.com'
  ) {
    id = parsed.searchParams.get('v');
    if (!id) {
      const idx = parts.findIndex((p) => YT_PATH_PREFIXES.has(p));
      if (idx !== -1 && parts[idx + 1]) id = parts[idx + 1];
    }
  } else {
    return null;
  }
  if (!id || !YT_ID_RE.test(id)) return null;
  return 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
}
