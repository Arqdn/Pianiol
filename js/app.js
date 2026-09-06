// Pianiol — app shell: screens, search, link → notes resolver, listen mode, player controls.
import { Synth, INSTRUMENTS } from './synth.js';
import { FallingNotes } from './engine.js';
import { parseMidi, midiToSong } from './midi.js';
import { SONGS, songToNotes, midiToName } from './library.js';
import { searchSongs } from './search.js';
import { parseSharedParams, extractUrlFromText, videoIdThumb } from './share.js';
import { resolve, loadCandidate } from './finder.js';
import {
  PROVIDERS, AI_MODELS, OPENROUTER_DEFAULT_MODEL,
  getProvider, setProvider, detectProvider, applySetupParams,
  getApiKey, setApiKey, hasApiKey, isBuiltInKey, getAiModel, setAiModel,
} from './ai.js';
import { Transcriber } from './transcribe.js';
import { isSupported as mlSupported, decodeFile, AudioCapture, getMicStream, getTabStream, transcribeSamples } from './transcribe-ml.js';
import { midiInputSupported, connectMidiInput } from './midi-input.js';
import { askCoach } from './coach.js';

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
  cancelExact();
  cancelCoach();
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
function providerLabel(id) {
  return id === 'openrouter' ? 'OpenRouter' : 'Claude';
}
const PROVIDER_NOTES = {
  anthropic: 'Get a key at console.anthropic.com → API keys, and set a spending limit there. A typical song costs a few cents. Declined requests fall back to another Claude model automatically.',
  openrouter: 'Get a key at openrouter.ai → Keys. The default model, NVIDIA Nemotron Ultra (free tier), costs nothing; any OpenRouter model id works in the box above.',
};
function refreshAiUi() {
  const provider = getProvider();
  const has = hasApiKey(provider);
  const builtIn = isBuiltInKey(provider);
  $('#ai-card-sub').textContent = has ? `Ready · ${providerLabel(provider)}` : 'Set up';
  $('#btn-ai').classList.toggle('ready', has);
  $('#ai-provider-select').value = provider;
  $('#ai-key-status').textContent = builtIn
    ? 'Using the built-in OpenRouter key — nothing to set up. Paste your own key to use it instead.'
    : has
      ? `${providerLabel(provider)} key saved: ${maskKey(getApiKey(provider))}`
      : `No ${providerLabel(provider)} key saved yet.`;
  $('#ai-key-input').value = '';
  $('#ai-key-input').placeholder = has && !builtIn ? 'Paste a new key to replace it' : (provider === 'openrouter' ? 'sk-or-…' : 'sk-ant-…');
  const isOr = provider === 'openrouter';
  $('#ai-model-select').hidden = isOr;
  $('#ai-or-model-input').hidden = !isOr;
  if (isOr) $('#ai-or-model-input').value = getAiModel('openrouter');
  else $('#ai-model-select').value = getAiModel('anthropic');
  $('#ai-provider-note').textContent = PROVIDER_NOTES[provider];
  $('#ai-online-toggle').checked = onlineEnabled();
  $('#ai-remove-key').hidden = !has || builtIn;
}

// Save a key typed anywhere; a recognizable prefix picks the provider automatically.
function saveKey(key) {
  const detected = detectProvider(key);
  const provider = setApiKey(key, detected || getProvider());
  toast(detected
    ? `${providerLabel(provider)} key saved on this device.`
    : `Key saved for ${providerLabel(provider)} (prefix not recognised — change the provider under ✨ AI notes if needed).`);
  refreshAiUi();
  return provider;
}

(() => {
  const provSel = $('#ai-provider-select');
  for (const p of PROVIDERS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    provSel.appendChild(opt);
  }
  provSel.addEventListener('change', () => { setProvider(provSel.value); refreshAiUi(); });

  const sel = $('#ai-model-select');
  for (const m of AI_MODELS) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => setAiModel(sel.value, 'anthropic'));
  $('#ai-or-model-input').addEventListener('change', e => {
    setAiModel(e.target.value.trim() || OPENROUTER_DEFAULT_MODEL, 'openrouter');
    refreshAiUi();
  });
  $('#ai-online-toggle').addEventListener('change', e => {
    try { localStorage.setItem('pianiol.online', e.target.checked ? '1' : '0'); } catch { /* ignore */ }
  });
  $('#btn-ai').addEventListener('click', () => { refreshAiUi(); openSheet($('#ai-backdrop')); });
  $('#ai-form').addEventListener('submit', e => {
    e.preventDefault();
    const key = $('#ai-key-input').value.trim();
    if (key) { saveKey(key); closeSheet($('#ai-backdrop')); }
    else refreshAiUi();
  });
  $('#ai-remove-key').addEventListener('click', () => { setApiKey('', getProvider()); refreshAiUi(); toast('API key removed.'); });

  // One-tap setup link (#setup&provider=…&key=…) — saved to this device, then scrubbed from the URL.
  const applied = applySetupParams(location.hash);
  if (applied) {
    history.replaceState(null, '', location.pathname + location.search);
    toast(`✨ AI notes ready — using ${providerLabel(applied.provider)}.`, 4500);
  }
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
    onEnd() {
      setPlayIcon(false);
      if (mode === 'learn' && engine.stats.hits + engine.stats.misses >= 4) offerCoach('You finished the song!');
    },
    onWait(targets) { showLearnHint(targets); },
    onLearnEvent(evt) {
      if (evt.type === 'hit' || evt.type === 'miss') updateLearnStats();
      if (evt.type === 'loop' && evt.count % 3 === 0 && mode === 'learn') offerCoach(`Loop ${evt.count} done.`);
    },
  });
}

/* ---------------- learn mode ---------------- */

let mode = 'play';
let loopA = null;
let coachOffered = false;

function showLearnHint(targets) {
  const el = $('#learn-hint');
  if (mode !== 'learn') { el.hidden = true; return; }
  if (targets && targets.length) {
    el.textContent = 'Play: ' + targets.map(t => t.name).join(' + ');
    el.classList.remove('done');
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function updateLearnStats() {
  if (!engine) return;
  const s = engine.stats;
  const total = s.hits + s.misses;
  $('#learn-stats').textContent = `✔ ${s.hits} · ✖ ${s.misses}${total ? ` · ${Math.round(s.accuracy * 100)}%` : ''}`;
}

function setMode(next) {
  mode = next === 'learn' ? 'learn' : 'play';
  for (const b of document.querySelectorAll('#mode-seg .seg-btn')) b.classList.toggle('active', b.dataset.mode === mode);
  $('#learn-bar').hidden = mode !== 'learn';
  if (engine) {
    const hands = document.querySelector('#hands-seg .seg-btn.active')?.dataset.hands || 'both';
    engine.setLearn(mode === 'learn', { hands, hints: $('#hints-toggle').checked });
    if (mode === 'learn') { engine.resetStats(); coachOffered = false; updateLearnStats(); }
  }
  if (mode !== 'learn') showLearnHint(null);
}

document.querySelectorAll('#mode-seg .seg-btn').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('#hands-seg .seg-btn').forEach(b => b.addEventListener('click', () => {
  for (const x of document.querySelectorAll('#hands-seg .seg-btn')) x.classList.toggle('active', x === b);
  if (engine) engine.setLearnHands(b.dataset.hands);
}));
$('#hints-toggle').addEventListener('change', e => { if (engine) engine.setHints(e.target.checked); });

function refreshLoopUi() {
  const lp = engine && engine.loop;
  $('#loop-clear').hidden = !lp && loopA == null;
  $('#loop-a').classList.toggle('active', loopA != null || !!lp);
  $('#loop-b').classList.toggle('active', !!lp);
  $('#loop-label').textContent = lp ? `Loop ${fmtTime(lp.start)}–${fmtTime(lp.end)}` : loopA != null ? `A = ${fmtTime(loopA)} · now set B` : '';
}
$('#loop-a').addEventListener('click', () => {
  if (!engine) return;
  loopA = engine.time;
  engine.clearLoop();
  refreshLoopUi();
});
$('#loop-b').addEventListener('click', () => {
  if (!engine) return;
  const b = engine.time;
  const a = loopA != null ? loopA : Math.max(0, b - 8);
  if (b - a < 0.5) { toast('Move a bit further into the song before setting B.'); return; }
  engine.setLoop(a, b);
  loopA = null;
  refreshLoopUi();
});
$('#loop-clear').addEventListener('click', () => { if (engine) engine.clearLoop(); loopA = null; refreshLoopUi(); });

function applyPlan(plan) {
  if (!engine || !currentSong) return;
  setMode('learn');
  for (const x of document.querySelectorAll('#hands-seg .seg-btn')) x.classList.toggle('active', x.dataset.hands === plan.hands);
  engine.setLearnHands(plan.hands);
  const opts = [...$('#speed-select').options].map(o => parseFloat(o.value));
  const nearest = opts.reduce((best, v) => Math.abs(v - plan.speed) < Math.abs(best - plan.speed) ? v : best, opts[0]);
  $('#speed-select').value = String(nearest);
  engine.setSpeed(nearest);
  engine.setLoop(plan.startSec, plan.endSec);
  loopA = null;
  refreshLoopUi();
  engine.resetStats();
  updateLearnStats();
  engine.seek(plan.startSec);
  synth.unlock().then(() => { engine.play(); setPlayIcon(true); });
  toast(`🎓 ${plan.label}`, 4000);
}

/* ---------------- AI coach ---------------- */

let coachCtrl = null;
let coachPlan = null;

function cancelCoach() {
  if (coachCtrl) { coachCtrl.abort(); coachCtrl = null; }
}

function offerCoach(reason) {
  if (coachOffered || !hasApiKey()) return;
  coachOffered = true;
  toast(`${reason} Tap ✨ Coach for feedback on what to practise.`, 5000);
}

async function runCoach() {
  if (!engine || !currentSong) { toast('Open a song first.'); return; }
  if (!hasApiKey()) { refreshAiUi(); openSheet($('#ai-backdrop')); toast('Add an AI key so the coach can look at your playing.'); return; }
  const stats = engine.stats;
  if (stats.hits + stats.misses < 1) { toast('Play a little in Learn mode first, then ask the coach.'); return; }
  cancelCoach();
  coachCtrl = new AbortController();
  const { signal } = coachCtrl;
  if (engine.state === 'playing') { engine.pause(); setPlayIcon(false); }
  openSheet($('#coach-backdrop'));
  $('#coach-loading').hidden = false;
  $('#coach-content').hidden = true;
  $('#coach-error').hidden = true;
  $('#coach-status').textContent = 'Looking at how you played…';
  try {
    const result = await askCoach({ song: currentSong, stats }, {
      provider: getProvider(), apiKey: getApiKey(), model: getAiModel(), signal,
      onStatus(msg) { if (!signal.aborted) $('#coach-status').textContent = msg; },
    });
    if (signal.aborted) return;
    coachPlan = result.plan;
    $('#coach-message').textContent = result.message;
    $('#coach-plan-label').textContent = result.plan.label;
    $('#coach-loading').hidden = true;
    $('#coach-content').hidden = false;
  } catch (err) {
    if (signal.aborted) return;
    $('#coach-loading').hidden = true;
    $('#coach-error').textContent = err && err.message ? err.message : 'The coach is unavailable right now.';
    $('#coach-error').hidden = false;
  } finally {
    if (coachCtrl && coachCtrl.signal === signal) coachCtrl = null;
  }
}
$('#btn-coach').addEventListener('click', runCoach);
$('#coach-apply').addEventListener('click', () => {
  const plan = coachPlan;
  closeAllSheets();
  if (plan) applyPlan(plan);
});

/* ---------------- MIDI keyboard ---------------- */

let midiConn = null;
if (midiInputSupported()) {
  $('#btn-midi').hidden = false;
  $('#btn-midi').addEventListener('click', async () => {
    if (midiConn) { midiConn.disconnect(); midiConn = null; $('#btn-midi').classList.remove('active'); toast('MIDI keyboard disconnected.'); return; }
    try {
      initEngine();
      midiConn = await connectMidiInput({
        onNoteOn: n => { engine.pressKey(n); },
        onNoteOff: n => { engine.releaseKey(n); },
        onDevices: names => { if (midiConn) toast(names.length ? `🎹 ${names.join(', ')}` : 'No MIDI keyboard found — plug one in.', 3500); },
      });
      $('#btn-midi').classList.add('active');
      toast(midiConn.devices.length ? `🎹 Connected: ${midiConn.devices.join(', ')}` : 'MIDI enabled — plug in a keyboard and it will just work.', 4000);
    } catch (err) {
      console.warn(err);
      toast('Could not access MIDI devices in this browser.');
    }
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
  loopA = null;
  coachOffered = false;
  refreshLoopUi();
  updateLearnStats();
  showLearnHint(null);
  if (mode === 'learn') {
    const hands = document.querySelector('#hands-seg .seg-btn.active')?.dataset.hands || 'both';
    engine.setLearn(true, { hands, hints: $('#hints-toggle').checked });
  }
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
  saveKey(key);
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
      ai: { provider: getProvider(), apiKey: getApiKey(), model: getAiModel() },
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

$('#match-exact').addEventListener('click', () => {
  closeSheet($('#sheet-backdrop'));
  openExactSheet();
});

function checkShareTarget() {
  const params = new URLSearchParams(location.search);
  const shared = parseSharedParams(params);
  const sharedFile = params.has('shared-file');
  if (params.has('title') || params.has('text') || params.has('url') || sharedFile || params.has('share-error')) {
    history.replaceState(null, '', location.pathname);
  }
  if (params.has('share-error')) toast('That share could not be read — try again or pick the file from inside Pianiol.');
  if (sharedFile) { loadSharedFile(); return; }
  if (shared) findAndPlay(shared.videoUrl || shared.rawTitle, { rawTitle: shared.rawTitle });
}

// A file shared into Pianiol arrives via the service worker's cache (see sw.js).
async function loadSharedFile() {
  try {
    const cache = await caches.open('pianiol-share');
    const res = await cache.match('shared-media');
    if (!res) { toast('The shared file was not found — please share it again.'); return; }
    const blob = await res.blob();
    const name = decodeURIComponent(res.headers.get('x-file-name') || 'Shared audio');
    await cache.delete('shared-media');
    openExactSheet();
    await transcribeBlob(blob, name);
  } catch (err) {
    console.warn(err);
    toast('Could not read the shared file.');
  }
}

/* ---------------- exact notes from audio ---------------- */

let exactCtrl = null;
let capture = null;
let captureTimer = 0;

function cancelExact() {
  if (exactCtrl) { exactCtrl.abort(); exactCtrl = null; }
  if (capture && capture.running) { capture.stop().catch(() => {}); }
  capture = null;
  clearInterval(captureTimer);
}

function exactView(which) {
  $('#exact-choose').hidden = which !== 'choose';
  $('#exact-record').hidden = which !== 'record';
  $('#exact-progress').hidden = which !== 'progress';
  $('#exact-error').hidden = true;
}

function exactError(msg) {
  exactView('choose');
  $('#exact-error').textContent = msg;
  $('#exact-error').hidden = false;
}

function openExactSheet() {
  cancelExact();
  openSheet($('#exact-backdrop'));
  exactView('choose');
  $('#exact-tab').hidden = !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  if (!mlSupported()) exactError('This browser cannot run the pitch-detection model.');
}

$('#btn-exact').addEventListener('click', openExactSheet);
$('#exact-file').addEventListener('click', () => $('#audio-file').click());
$('#audio-file').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if ($('#exact-backdrop').hidden) openExactSheet();
  await transcribeBlob(file, file.name);
});

async function transcribeBlob(blob, name) {
  cancelExact();
  exactCtrl = new AbortController();
  const { signal } = exactCtrl;
  exactView('progress');
  setExactProgress('Decoding the audio…', 0);
  try {
    const samples = await decodeFile(blob, { maxSeconds: 360 });
    if (signal.aborted) return;
    await transcribeAndOpen(samples, { title: String(name || 'Audio').replace(/\.[a-z0-9]{2,5}$/i, ''), signal });
  } catch (err) {
    if (signal.aborted) return;
    console.warn(err);
    exactError(err && err.message ? err.message : 'Could not transcribe that file.');
  }
}

function setExactProgress(msg, pct) {
  $('#exact-status').textContent = msg;
  if (typeof pct === 'number') $('#exact-bar').style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

async function transcribeAndOpen(samples, { title, signal }) {
  const song = await transcribeSamples(samples, {
    title,
    signal,
    onStatus(msg) { if (!signal.aborted) setExactProgress(msg); },
    onProgress(p) { if (!signal.aborted) setExactProgress(`Listening for notes… ${p}%`, p); },
  });
  if (signal.aborted) return;
  lastResolve = null;
  openPlayer(song);
  toast(`🎧 ${song.notes.length} notes found in the recording · ${instrumentName(synth.instrument)}`, 4500);
}

async function startCapture(kind) {
  cancelExact();
  exactCtrl = new AbortController();
  const { signal } = exactCtrl;
  let stream;
  try {
    stream = kind === 'tab' ? await getTabStream() : await getMicStream();
  } catch (err) {
    if (signal.aborted) return;
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    exactError(denied
      ? (kind === 'tab' ? 'Screen/tab sharing was cancelled.' : 'Microphone access was blocked — allow it and try again.')
      : (err && err.message) || 'Could not start capturing audio.');
    return;
  }
  if (signal.aborted) { for (const t of stream.getTracks()) t.stop(); return; }
  capture = new AudioCapture();
  exactView('record');
  $('#exact-record-hint').textContent = kind === 'tab'
    ? 'Recording the tab. Play the video now, then stop when it\'s done (or after the part you want).'
    : 'Recording. Play the song out loud now, then stop when it\'s done.';
  $('#exact-timer').textContent = '0:00';
  $('#exact-level').style.width = '0%';
  try {
    await capture.start(stream, {
      maxSeconds: 360,
      onLevel(rms, secs) {
        $('#exact-level').style.width = `${Math.min(100, rms * 300)}%`;
        $('#exact-timer').textContent = fmtTime(secs);
      },
    });
  } catch (err) {
    console.warn(err);
    exactError('Could not start recording in this browser.');
  }
  // Tab capture ends when the user stops sharing from the browser bar.
  for (const t of stream.getTracks()) t.addEventListener('ended', () => { if (capture && capture.running) finishCapture(); });
}

async function finishCapture() {
  if (!capture || !capture.running) return;
  const cap = capture;
  const signal = exactCtrl ? exactCtrl.signal : new AbortController().signal;
  exactView('progress');
  setExactProgress('Preparing the recording…', 0);
  let samples = null;
  try { samples = await cap.stop(); } catch (err) { console.warn(err); }
  capture = null;
  if (signal.aborted) return;
  if (!samples || samples.length < 22050) { exactError('The recording was too short — try again and stop after the song has played.'); return; }
  try {
    await transcribeAndOpen(samples, { title: 'Recorded audio', signal });
  } catch (err) {
    if (signal.aborted) return;
    console.warn(err);
    exactError(err && err.message ? err.message : 'Could not transcribe the recording.');
  }
}

$('#exact-tab').addEventListener('click', () => startCapture('tab'));
$('#exact-mic').addEventListener('click', () => startCapture('mic'));
$('#exact-stop').addEventListener('click', finishCapture);

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
  // When an updated version takes over, reload once so the page runs the new code
  // (never mid-song).
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    if (engine && engine.state === 'playing') return;
    location.reload();
  });
}

// Small debug/testing hook (read-only).
window.__pianiol = { get engine() { return engine; }, get mode() { return mode; }, get song() { return currentSong; } };

renderLibrary();
checkShareTarget();
