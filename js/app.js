// Pianiol — app shell: screens, search, link → notes resolver, listen mode, player controls.
import { Synth, INSTRUMENTS } from './synth.js';
import { FallingNotes } from './engine.js';
import { parseMidi, midiToSong } from './midi.js';
import { SONGS, songToNotes, midiToName } from './library.js';
import { searchSongs } from './search.js';
import { parseSharedParams, extractUrlFromText, videoIdThumb } from './share.js';
import { resolve, loadCandidate } from './finder.js';
import { AI_MODELS, getApiKey, setApiKey, hasApiKey, getAiModel, setAiModel } from './ai.js';
import { Transcriber } from './transcribe.js';

const $ = sel => document.querySelector(sel);

const synth = new Synth();
let engine = null;
let currentSong = null;
let seeking = false;
let transposeSemis = 0;
let deferredInstall = null;
const transcriber = new Transcriber();

/* ---------------- screens & sheets ---------------- */

function showScreen(name) {
  $('#home').hidden = name !== 'home';
  $('#player').hidden = name !== 'player';
  if (name === 'player' && engine) requestAnimationFrame(() => engine.resize());
}

function openSheet(backdrop) { backdrop.hidden = false; }
function closeSheet(backdrop) { backdrop.hidden = true; }
function closeAllSheets() {
  for (const el of document.querySelectorAll('.sheet-backdrop')) el.hidden = true;
  stopListening(false);
  cancelResolve();
}

document.addEventListener('click', e => {
  if (e.target.closest('[data-close-sheet]')) closeAllSheets();
  else if (e.target.classList && e.target.classList.contains('sheet-backdrop')) closeAllSheets();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllSheets(); });

let toastTimer = 0;
function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/* ---------------- instruments (persisted) ---------------- */

const instSelects = [$('#instrument-select'), $('#match-instrument-select')];
for (const sel of instSelects) {
  for (const inst of INSTRUMENTS) {
    const opt = document.createElement('option');
    opt.value = inst.id;
    opt.textContent = `${inst.emoji} ${inst.name}`;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => setInstrument(sel.value));
}

function setInstrument(id) {
  if (!INSTRUMENTS.some(i => i.id === id)) id = 'piano';
  synth.setInstrument(id);
  for (const sel of instSelects) sel.value = id;
  try { localStorage.setItem('pianiol.instrument', id); } catch { /* private mode */ }
}
function instrumentName(id) {
  const inst = INSTRUMENTS.find(i => i.id === id);
  return inst ? inst.name : 'Piano';
}
(() => {
  let saved = 'piano';
  try { saved = localStorage.getItem('pianiol.instrument') || 'piano'; } catch { /* ignore */ }
  setInstrument(saved);
})();

/* ---------------- AI settings ---------------- */

function onlineEnabled() {
  try { return localStorage.getItem('pianiol.online') === '1'; } catch { return false; }
}
function maskKey(key) {
  return key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : '••••';
}
function refreshAiUi() {
  const has = hasApiKey();
  $('#ai-card-sub').textContent = has ? 'Ready' : 'Set up';
  $('#btn-ai').classList.toggle('ready', has);
  $('#ai-key-status').textContent = has ? `Key saved: ${maskKey(getApiKey())}` : 'No key saved yet.';
  $('#ai-key-input').value = '';
  $('#ai-key-input').placeholder = has ? 'Paste a new key to replace it' : 'sk-ant-…';
  $('#ai-model-select').value = getAiModel();
  $('#ai-online-toggle').checked = onlineEnabled();
  $('#ai-remove-key').hidden = !has;
}

(() => {
  const sel = $('#ai-model-select');
  for (const m of AI_MODELS) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => setAiModel(sel.value));
  $('#ai-online-toggle').addEventListener('change', e => {
    try { localStorage.setItem('pianiol.online', e.target.checked ? '1' : '0'); } catch { /* ignore */ }
  });
  $('#btn-ai').addEventListener('click', () => { refreshAiUi(); openSheet($('#ai-backdrop')); });
  $('#ai-form').addEventListener('submit', e => {
    e.preventDefault();
    const key = $('#ai-key-input').value.trim();
    if (key) { setApiKey(key); toast('API key saved on this device.'); }
    refreshAiUi();
    if (key) closeSheet($('#ai-backdrop'));
  });
  $('#ai-remove-key').addEventListener('click', () => { setApiKey(''); refreshAiUi(); toast('API key removed.'); });
  refreshAiUi();
})();

/* ---------------- player ---------------- */

let lastResolve = null; // candidates to offer again when the user backs out of an auto-play
let lastInput = null;   // what the resolver last worked on, so "save key & retry" can re-run it

function initEngine() {
  if (engine) return;
  engine = new FallingNotes({
    canvas: $('#stage'),
    synth,
    onProgress(t, d) {
      if (!seeking && d > 0) $('#seek-bar').value = String(Math.round((t / d) * 1000));
      $('#time-now').textContent = fmtTime(t);
    },
    onEnd() { setPlayIcon(false); },
  });
}

function setPlayIcon(playing) { $('#btn-play').textContent = playing ? '❚❚' : '▶'; }

function openPlayer(song, { autoplay = true } = {}) {
  if (!song || !song.notes || !song.notes.length) {
    toast('No notes found in that song.');
    return false;
  }
  initEngine();
  closeAllSheets();
  currentSong = song;
  transposeSemis = 0;
  $('#transpose-label').textContent = '0';
  $('#player-song-title').textContent = song.title || 'Untitled';
  $('#player-song-artist').textContent = song.artist || '';
  $('#time-total').textContent = fmtTime(song.durationSec);
  $('#time-now').textContent = '0:00';
  $('#seek-bar').value = '0';
  engine.setTranspose(0);
  engine.setSong(song);
  engine.setSpeed(parseFloat($('#speed-select').value) || 1);
  showScreen('player');
  if (autoplay) {
    synth.unlock().then(() => { engine.play(); setPlayIcon(true); });
  } else {
    setPlayIcon(false);
  }
  return true;
}

$('#btn-back').addEventListener('click', () => {
  if (engine) engine.pause();
  setPlayIcon(false);
  showScreen('home');
  // Auto-played from a link? Offer the other matches on the way out.
  if (lastResolve && lastResolve.candidates.length > 1) {
    showCandidates(lastResolve, { heading: 'Pick a different match' });
  }
});

$('#btn-play').addEventListener('click', async () => {
  if (!engine || !currentSong) return;
  await synth.unlock();
  if (engine.state === 'playing') {
    engine.pause();
    setPlayIcon(false);
  } else {
    engine.play();
    setPlayIcon(true);
  }
});

$('#seek-bar').addEventListener('input', () => {
  if (!engine || !currentSong) return;
  seeking = true;
  const frac = (parseInt($('#seek-bar').value, 10) || 0) / 1000;
  $('#time-now').textContent = fmtTime(frac * currentSong.durationSec);
});
$('#seek-bar').addEventListener('change', () => {
  if (engine && currentSong) {
    const frac = (parseInt($('#seek-bar').value, 10) || 0) / 1000;
    engine.seek(frac * currentSong.durationSec);
  }
  seeking = false;
});

$('#speed-select').addEventListener('change', () => {
  if (engine) engine.setSpeed(parseFloat($('#speed-select').value) || 1);
});

function nudgeTranspose(d) {
  transposeSemis = Math.max(-12, Math.min(12, transposeSemis + d));
  $('#transpose-label').textContent = transposeSemis > 0 ? `+${transposeSemis}` : String(transposeSemis);
  if (engine) engine.setTranspose(transposeSemis);
}
$('#btn-transpose-down').addEventListener('click', () => nudgeTranspose(-1));
$('#btn-transpose-up').addEventListener('click', () => nudgeTranspose(1));

/* ---------------- library & search ---------------- */

function renderLibrary() {
  const grid = $('#song-grid');
  grid.textContent = '';
  for (const song of SONGS) {
    const btn = document.createElement('button');
    btn.className = 'song-card';
    const beats = song.notes.length ? Math.max(...song.notes.map(n => n[0] + n[1])) : 0;
    const secs = beats * (60 / (song.bpm || 100)) + 1;
    btn.innerHTML = `
      <span class="sc-title"></span>
      <span class="sc-artist"></span>
      <span class="sc-meta"></span>`;
    btn.querySelector('.sc-title').textContent = song.title;
    btn.querySelector('.sc-artist').textContent = song.artist;
    btn.querySelector('.sc-meta').textContent = `${song.notes.length} notes · ${fmtTime(secs)}`;
    btn.addEventListener('click', () => { lastResolve = null; openPlayer(songToNotes(song)); });
    grid.appendChild(btn);
  }
}

const searchInput = $('#search-input');
const searchResults = $('#search-results');

function resultRow(className, html) {
  const btn = document.createElement('button');
  btn.className = `search-result ${className}`.trim();
  btn.innerHTML = html;
  return btn;
}

function runSearch() {
  const q = searchInput.value.trim();
  if (q.length < 2) { searchResults.hidden = true; return; }
  searchResults.textContent = '';

  const url = extractUrlFromText(q);
  if (url) {
    const btn = resultRow('web', `<span>🔗</span><span>Find the notes for this link</span>`);
    btn.addEventListener('click', () => { searchInput.value = ''; searchResults.hidden = true; findAndPlay(url); });
    searchResults.appendChild(btn);
    searchResults.hidden = false;
    return;
  }

  const hits = searchSongs(q, SONGS, { limit: 6 });
  for (const { song, score } of hits) {
    const btn = resultRow('', `<span>🎵</span><span><span class="sr-title"></span> <span class="sr-artist"></span></span><span class="sr-score"></span>`);
    btn.querySelector('.sr-title').textContent = song.title;
    btn.querySelector('.sr-artist').textContent = `· ${song.artist}`;
    btn.querySelector('.sr-score').textContent = `${Math.round(score * 100)}%`;
    btn.addEventListener('click', () => {
      searchResults.hidden = true;
      searchInput.value = '';
      lastResolve = null;
      openPlayer(songToNotes(song));
    });
    searchResults.appendChild(btn);
  }
  if (q.length >= 3) {
    const btn = resultRow('web', `<span>🌐</span><span>Search the web for “<span class="sr-q"></span>”</span>`);
    btn.querySelector('.sr-q').textContent = q;
    btn.addEventListener('click', () => { searchInput.value = ''; searchResults.hidden = true; findAndPlay(q); });
    searchResults.appendChild(btn);
  }
  searchResults.hidden = false;
}

searchInput.addEventListener('input', runSearch);
searchInput.addEventListener('paste', () => {
  // Let the paste land, then auto-run if it was a link.
  setTimeout(() => {
    const url = extractUrlFromText(searchInput.value);
    if (url) { searchInput.value = ''; searchResults.hidden = true; findAndPlay(url); }
    else runSearch();
  }, 0);
});
searchInput.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const q = searchInput.value.trim();
  const url = extractUrlFromText(q);
  searchResults.hidden = true;
  if (url) { searchInput.value = ''; findAndPlay(url); return; }
  const first = searchResults.querySelector('.search-result:not(.web)');
  if (first) { first.click(); return; }
  if (q.length >= 2) { searchInput.value = ''; findAndPlay(q); }
});
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('.search-wrap')) searchResults.hidden = true;
});

/* ---------------- MIDI import ---------------- */

$('#btn-import').addEventListener('click', () => $('#midi-file').click());
$('#match-import').addEventListener('click', () => { closeAllSheets(); $('#midi-file').click(); });
$('#midi-file').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const parsed = parseMidi(buf);
    const song = midiToSong(parsed);
    if (!song.title || song.title === 'Imported MIDI') {
      song.title = file.name.replace(/\.(midi?|MIDI?)$/, '');
    }
    song.artist = song.artist || 'Imported MIDI';
    lastResolve = null;
    openPlayer(song);
  } catch (err) {
    console.warn(err);
    toast('Could not read that file — is it a Standard MIDI (.mid) file?');
  }
});

/* ---------------- paste-a-link sheet ---------------- */

$('#btn-link').addEventListener('click', () => {
  openSheet($('#link-backdrop'));
  setTimeout(() => $('#link-input').focus(), 50);
});
$('#link-form').addEventListener('submit', e => {
  e.preventDefault();
  const url = extractUrlFromText($('#link-input').value);
  closeSheet($('#link-backdrop'));
  $('#link-input').value = '';
  if (url) findAndPlay(url);
  else toast('That does not look like a link.');
});

/* ---------------- link / name → notes resolver ---------------- */

let resolveCtrl = null;

function cancelResolve() {
  if (resolveCtrl) { resolveCtrl.abort(); resolveCtrl = null; }
}

function setStatus(msg) {
  $('#match-status').textContent = msg;
  $('#match-loading').hidden = false;
}

function showIdentity(identity, fallbackTitle) {
  const thumbEl = $('#match-thumb');
  const thumb = identity && identity.url ? videoIdThumb(identity.url) : null;
  thumbEl.onerror = () => { thumbEl.hidden = true; };
  if (thumb) { thumbEl.src = thumb; thumbEl.hidden = false; } else { thumbEl.hidden = true; }
  $('#match-title').textContent = (identity && identity.videoTitle) || fallbackTitle || 'Shared video';
  $('#match-author').textContent = (identity && identity.author) || '';
}

function sourceBadge(c) {
  const span = document.createElement('span');
  span.className = `mi-source ${c.source === 'library' ? 'library' : c.source === 'ai' ? 'ai' : ''}`;
  span.textContent = c.source === 'library' ? 'library' : c.sourceName;
  return span;
}

function showCandidates(result, { heading } = {}) {
  const backdrop = $('#sheet-backdrop');
  openSheet(backdrop);
  $('#match-loading').hidden = true;
  $('#match-content').hidden = false;
  showIdentity(result.identity, '');
  const list = $('#match-list');
  list.textContent = '';
  const cands = result.candidates.slice(0, 8);
  const errEl = $('#match-ai-error');
  errEl.hidden = !result.aiError;
  errEl.textContent = result.aiError || '';
  const keyForm = $('#match-key-form');
  keyForm.hidden = !(result.needsKey || (result.aiError && /rejected|No API key/i.test(result.aiError)));
  if (!keyForm.hidden) $('#match-key-input').value = '';

  if (heading) $('#match-heading').textContent = heading;
  else if (result.reason === 'unreadable') $('#match-heading').textContent = 'Could not read that link';
  else if (result.needsKey && !cands.length) $('#match-heading').textContent = 'Not in the library — let AI write it';
  else if (result.needsKey) $('#match-heading').textContent = 'Close matches below, or let AI write the real one';
  else if (result.aiError) $('#match-heading').textContent = cands.length ? 'AI could not write this one — closest matches' : 'AI could not write this one';
  else if (cands.length) $('#match-heading').textContent = 'Closest matches — tap one to play';
  else $('#match-heading').textContent = 'Nothing found for this one yet';

  for (const c of cands) {
    const btn = document.createElement('button');
    btn.className = 'match-item';
    btn.innerHTML = `<span>🎵</span><span class="mi-body"><span class="mi-title"></span><span class="mi-artist"></span></span>`;
    btn.querySelector('.mi-title').textContent = c.title;
    btn.querySelector('.mi-artist').textContent = c.subtitle || `${Math.round(c.score * 100)}% match`;
    btn.appendChild(sourceBadge(c));
    btn.addEventListener('click', () => playCandidate(c, result));
    list.appendChild(btn);
  }
  if (!cands.length && keyForm.hidden) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'You can still get the notes: transcribe it with Listen mode while the video plays, or import a MIDI of the song.';
    list.appendChild(p);
  }
}

$('#match-key-form').addEventListener('submit', e => {
  e.preventDefault();
  const key = $('#match-key-input').value.trim();
  if (!key) return;
  setApiKey(key);
  refreshAiUi();
  if (lastInput) findAndPlay(lastInput.input, { rawTitle: lastInput.rawTitle });
});

async function playCandidate(c, result) {
  lastResolve = result;
  if (c.source === 'library') { openPlayer(songToNotes(c.song)); return; }
  cancelResolve();
  resolveCtrl = new AbortController();
  $('#match-content').hidden = true;
  setStatus(`Downloading "${c.title}"…`);
  const song = await loadCandidate(c, { signal: resolveCtrl.signal, onStatus: setStatus });
  if (resolveCtrl && resolveCtrl.signal.aborted) return;
  if (song) {
    openPlayer(song);
    toast(`▶ ${song.title} · ${instrumentName(synth.instrument)}`);
  } else {
    toast('That file could not be loaded — try another match.');
    showCandidates(result);
  }
}

// The main entry point: a link, a shared video, or a typed song name.
async function findAndPlay(input, { rawTitle = '' } = {}) {
  cancelResolve();
  resolveCtrl = new AbortController();
  const { signal } = resolveCtrl;
  lastInput = { input, rawTitle };

  openSheet($('#sheet-backdrop'));
  $('#match-content').hidden = true;
  showIdentity(null, rawTitle || (extractUrlFromText(input) ? 'Shared video' : input));
  setStatus(extractUrlFromText(input) ? 'Reading the video title…' : `Looking for "${input}"…`);

  let result;
  try {
    result = await resolve(input, {
      library: SONGS,
      toSong: songToNotes,
      rawTitle,
      signal,
      ai: { apiKey: getApiKey(), model: getAiModel() },
      online: { enabled: onlineEnabled() },
      onStatus(msg) { if (!signal.aborted) { setStatus(msg); } },
    });
  } catch (err) {
    if (signal.aborted) return;
    console.warn(err);
    result = { kind: 'none', identity: null, candidates: [], reason: 'error', aiError: err && err.message };
  }
  if (signal.aborted) return;
  resolveCtrl = null;

  if (result.identity) showIdentity(result.identity, '');

  if (result.kind === 'library' || result.kind === 'online' || result.kind === 'ai') {
    lastResolve = result;
    openPlayer(result.song);
    const inst = instrumentName(synth.instrument);
    if (result.kind === 'ai') {
      const conf = result.song.confidence && result.song.confidence !== 'high' ? ` (AI confidence: ${result.song.confidence})` : '';
      toast(`✨ Notes written by AI${conf} · ${inst}`, 5000);
    } else {
      const where = result.kind === 'library' ? 'from the library' : `from ${result.candidate.sourceName}`;
      const more = result.candidates.length > 1 ? ' Not it? Tap ← for other matches.' : '';
      toast(`▶ ${result.song.title} ${where} · ${inst}.${more}`, 5000);
    }
    return;
  }
  showCandidates(result);
}

$('#match-listen').addEventListener('click', () => {
  closeSheet($('#sheet-backdrop'));
  openListenSheet();
});

function checkShareTarget() {
  const params = new URLSearchParams(location.search);
  const shared = parseSharedParams(params);
  if (params.has('title') || params.has('text') || params.has('url')) {
    history.replaceState(null, '', location.pathname);
  }
  if (shared) findAndPlay(shared.videoUrl || shared.rawTitle, { rawTitle: shared.rawTitle });
}

/* ---------------- listen mode ---------------- */

let heardCount = 0;

function openListenSheet() {
  openSheet($('#listen-backdrop'));
  $('#listen-error').hidden = true;
  $('#listen-note').textContent = '—';
  $('#level-fill').style.width = '0%';
  $('#listen-count').textContent = '0 notes heard';
  $('#btn-record').hidden = false;
  $('#btn-record').textContent = '● Start listening';
  $('#btn-record-done').hidden = true;
  heardCount = 0;
}

$('#btn-listen').addEventListener('click', openListenSheet);

$('#btn-record').addEventListener('click', async () => {
  if (transcriber.running) return;
  $('#listen-error').hidden = true;
  try {
    await transcriber.start({
      onLevel(rms) {
        $('#level-fill').style.width = `${Math.min(100, rms * 300)}%`;
      },
      onPitch(midiFloat) {
        $('#listen-note').textContent = midiFloat == null ? '—' : midiToName(Math.round(midiFloat));
      },
      onNote() {
        heardCount++;
        $('#listen-count').textContent = `${heardCount} note${heardCount === 1 ? '' : 's'} heard`;
      },
    });
    $('#btn-record').hidden = true;
    $('#btn-record-done').hidden = false;
  } catch (err) {
    console.warn(err);
    $('#listen-error').textContent = 'Microphone unavailable — check permission and try again.';
    $('#listen-error').hidden = false;
  }
});

function stopListening(open) {
  if (!transcriber.running) return null;
  const song = transcriber.stop();
  if (open) {
    if (song && song.notes.length >= 3) {
      lastResolve = null;
      openPlayer(song);
    } else {
      toast('Not enough notes heard — try again closer to the speaker.');
      openListenSheet();
    }
  }
  return song;
}

$('#btn-record-done').addEventListener('click', () => stopListening(true));

/* ---------------- install prompt ---------------- */

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  $('#install-hint').hidden = false;
});
$('#btn-install').addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice.catch(() => {});
  deferredInstall = null;
  $('#install-hint').hidden = true;
});

/* ---------------- boot ---------------- */

window.addEventListener('resize', () => { if (engine) engine.resize(); });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
  });
}

renderLibrary();
checkShareTarget();
