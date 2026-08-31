// Pianiol — app shell: screens, search, share-target flow, listen mode, player controls.
import { Synth, INSTRUMENTS } from './synth.js';
import { FallingNotes } from './engine.js';
import { parseMidi, midiToSong } from './midi.js';
import { SONGS, songToNotes, midiToName } from './library.js';
import { searchSongs } from './search.js';
import { parseSharedParams, extractUrlFromText, fetchVideoMeta, videoIdThumb } from './share.js';
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

/* ---------------- player ---------------- */

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
    return;
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
}

$('#btn-back').addEventListener('click', () => {
  if (engine) engine.pause();
  setPlayIcon(false);
  showScreen('home');
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

/* ---------------- instruments ---------------- */

const instSel = $('#instrument-select');
for (const inst of INSTRUMENTS) {
  const opt = document.createElement('option');
  opt.value = inst.id;
  opt.textContent = `${inst.emoji} ${inst.name}`;
  instSel.appendChild(opt);
}
instSel.addEventListener('change', () => synth.setInstrument(instSel.value));

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
    btn.addEventListener('click', () => openPlayer(songToNotes(song)));
    grid.appendChild(btn);
  }
}

const searchInput = $('#search-input');
const searchResults = $('#search-results');

function runSearch() {
  const q = searchInput.value.trim();
  if (q.length < 2) { searchResults.hidden = true; return; }
  const hits = searchSongs(q, SONGS, { limit: 6 });
  searchResults.textContent = '';
  if (!hits.length) {
    const div = document.createElement('div');
    div.className = 'search-empty';
    div.textContent = 'No match in the library — try Import MIDI or Listen mode.';
    searchResults.appendChild(div);
  } else {
    for (const { song, score } of hits) {
      const btn = document.createElement('button');
      btn.className = 'search-result';
      btn.innerHTML = `<span>🎵</span><span><span class="sr-title"></span> <span class="sr-artist"></span></span><span class="sr-score"></span>`;
      btn.querySelector('.sr-title').textContent = song.title;
      btn.querySelector('.sr-artist').textContent = `· ${song.artist}`;
      btn.querySelector('.sr-score').textContent = `${Math.round(score * 100)}%`;
      btn.addEventListener('click', () => {
        searchResults.hidden = true;
        searchInput.value = '';
        openPlayer(songToNotes(song));
      });
      searchResults.appendChild(btn);
    }
  }
  searchResults.hidden = false;
}

searchInput.addEventListener('input', runSearch);
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const url = extractUrlFromText(searchInput.value);
    if (url) { handleVideoUrl(url, ''); searchInput.value = ''; searchResults.hidden = true; return; }
    const first = searchResults.querySelector('.search-result');
    if (first) first.click();
  }
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
    openPlayer(song);
  } catch (err) {
    console.warn(err);
    toast('Could not read that file — is it a Standard MIDI (.mid) file?');
  }
});

/* ---------------- paste-a-link ---------------- */

$('#btn-link').addEventListener('click', () => {
  openSheet($('#link-backdrop'));
  setTimeout(() => $('#link-input').focus(), 50);
});
$('#link-form').addEventListener('submit', e => {
  e.preventDefault();
  const url = extractUrlFromText($('#link-input').value);
  closeSheet($('#link-backdrop'));
  $('#link-input').value = '';
  if (url) handleVideoUrl(url, '');
  else toast('That does not look like a link.');
});

/* ---------------- share target / video matching ---------------- */

async function handleVideoUrl(videoUrl, rawTitle) {
  const backdrop = $('#sheet-backdrop');
  openSheet(backdrop);
  $('#match-loading').hidden = false;
  $('#match-content').hidden = true;

  let title = rawTitle || '';
  let author = '';
  if (videoUrl) {
    const meta = await fetchVideoMeta(videoUrl);
    if (meta && meta.title) { title = meta.title; author = meta.author || ''; }
  }

  $('#match-loading').hidden = true;
  $('#match-content').hidden = false;

  const thumb = videoUrl ? videoIdThumb(videoUrl) : null;
  const thumbEl = $('#match-thumb');
  thumbEl.onerror = () => { thumbEl.hidden = true; };
  if (thumb) { thumbEl.src = thumb; thumbEl.hidden = false; } else { thumbEl.hidden = true; }
  $('#match-title').textContent = title || 'Shared video';
  $('#match-author').textContent = author;

  const list = $('#match-list');
  list.textContent = '';
  const query = [title, author].filter(Boolean).join(' ');
  const hits = query ? searchSongs(query, SONGS, { limit: 5 }) : [];

  if (hits.length) {
    $('#match-heading').textContent = 'Best matches in the library';
    for (const { song, score } of hits) {
      const btn = document.createElement('button');
      btn.className = 'match-item';
      btn.innerHTML = `<span>🎵</span><span class="mi-body"><span class="mi-title"></span><span class="mi-artist"></span></span><span class="mi-score"></span>`;
      btn.querySelector('.mi-title').textContent = song.title;
      btn.querySelector('.mi-artist').textContent = song.artist;
      btn.querySelector('.mi-score').textContent = `${Math.round(score * 100)}% match`;
      btn.addEventListener('click', () => openPlayer(songToNotes(song)));
      list.appendChild(btn);
    }
  } else {
    $('#match-heading').textContent = title
      ? 'No library match for this one yet'
      : 'Could not read the video title';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'You can still get the notes: transcribe it with Listen mode while the video plays, or import a MIDI of the song.';
    list.appendChild(p);
  }
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
  if (shared) handleVideoUrl(shared.videoUrl, shared.rawTitle);
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
