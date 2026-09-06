// transcribe-ml.js — exact notes from audio.
//
// Runs Spotify's Basic Pitch (a small neural polyphonic pitch model, Apache-2.0)
// in the browser via TensorFlow.js. Audio can come from a decoded file, a live
// MediaStream (microphone / tab capture), or an <audio>/<video> element.
// Everything happens on the device; no audio leaves it.

const SR = 22050; // Basic Pitch's native sample rate
const LIB_URL = new URL('../vendor/basic-pitch/basic-pitch.js', import.meta.url).href;
const MODEL_URL = new URL('../vendor/basic-pitch/model.json', import.meta.url).href;
const WORKLET_URL = new URL('./pcm-worklet.js', import.meta.url).href;

let libPromise = null;

// Load the library + model once (≈2 MB the first time; cached by the service worker after).
export async function loadBasicPitch({ onStatus } = {}) {
  if (!libPromise) {
    libPromise = (async () => {
      onStatus && onStatus('Loading the pitch-detection model…');
      const lib = await import(LIB_URL);
      const tf = lib.tf;
      try {
        await tf.setBackend('webgl');
        await tf.ready();
      } catch {
        await tf.setBackend('cpu');
        await tf.ready();
      }
      const bp = new lib.BasicPitch(MODEL_URL);
      await bp.model; // surfaces a load error early
      return { lib, tf, bp };
    })().catch(err => { libPromise = null; throw err; });
  }
  return libPromise;
}

export function isSupported() {
  return typeof OfflineAudioContext !== 'undefined' && typeof WebAssembly !== 'undefined';
}

/* ------------------------------------------------------------------ */
/* Getting audio in                                                    */
/* ------------------------------------------------------------------ */

// Mix an AudioBuffer down to mono at 22050 Hz (what the model expects).
export async function resampleMono(audioBuffer, { maxSeconds = 360 } = {}) {
  const seconds = Math.min(audioBuffer.duration, maxSeconds);
  const length = Math.max(1, Math.ceil(seconds * SR));
  const off = new OfflineAudioContext(1, length, SR);
  const src = off.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(off.destination);
  src.start(0);
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

// Decode an audio (or video) file and return mono 22050 Hz samples.
export async function decodeFile(fileOrBlob, opts = {}) {
  const ab = await fileOrBlob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let buffer;
  try {
    buffer = await ctx.decodeAudioData(ab.slice(0));
  } catch (err) {
    throw new Error('Could not decode that file. Try an MP3, WAV, M4A, OGG or a video with an ordinary audio track.');
  } finally {
    try { await ctx.close(); } catch { /* ignore */ }
  }
  return resampleMono(buffer, opts);
}

// Collect raw PCM from any MediaStream (microphone, tab/screen capture) until stop().
export class AudioCapture {
  constructor() {
    this._ctx = null;
    this._chunks = [];
    this._length = 0;
    this._node = null;
    this._source = null;
    this._stream = null;
    this._level = 0;
    this._running = false;
    this._maxSamples = 0;
  }

  get running() { return this._running; }
  get level() { return this._level; }
  get seconds() { return this._ctx ? this._length / this._ctx.sampleRate : 0; }

  async start(stream, { maxSeconds = 360, onLevel } = {}) {
    if (this._running) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this._ctx = new Ctx();
    await this._ctx.resume().catch(() => {});
    this._stream = stream;
    this._chunks = [];
    this._length = 0;
    this._maxSamples = maxSeconds * this._ctx.sampleRate;
    this._source = this._ctx.createMediaStreamSource(stream);
    const push = samples => {
      if (!this._running) return;
      if (this._length + samples.length > this._maxSamples) { this.stop(); return; }
      this._chunks.push(samples);
      this._length += samples.length;
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      this._level = Math.sqrt(sum / samples.length);
      onLevel && onLevel(this._level, this.seconds);
    };
    let node = null;
    if (this._ctx.audioWorklet) {
      try {
        await this._ctx.audioWorklet.addModule(WORKLET_URL);
        node = new AudioWorkletNode(this._ctx, 'pcm-capture');
        node.port.onmessage = e => push(e.data);
      } catch { node = null; }
    }
    if (!node) {
      // Fallback for browsers without AudioWorklet.
      node = this._ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = e => push(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    this._node = node;
    this._source.connect(node);
    // Keep the graph alive without feeding the capture back to the speakers.
    const mute = this._ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(this._ctx.destination);
    this._running = true;
  }

  // Stops capturing and returns the recording as mono 22050 Hz samples (null if empty).
  async stop() {
    if (!this._running) return null;
    this._running = false;
    try { this._source && this._source.disconnect(); } catch { /* ignore */ }
    try { this._node && this._node.disconnect(); } catch { /* ignore */ }
    if (this._stream) for (const t of this._stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
    const ctx = this._ctx;
    const total = this._length;
    let out = null;
    if (total > 0) {
      const buffer = ctx.createBuffer(1, total, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let off = 0;
      for (const c of this._chunks) { data.set(c, off); off += c.length; }
      out = await resampleMono(buffer);
    }
    this._chunks = [];
    this._length = 0;
    try { await ctx.close(); } catch { /* ignore */ }
    this._ctx = null;
    return out;
  }
}

// Microphone stream (no processing so pitches stay intact).
export function getMicStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
}

// Tab / screen audio (desktop Chrome & Edge). Throws a readable error if no audio was shared.
export async function getTabStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    throw new Error('Tab capture is not available in this browser — use a file or the microphone instead.');
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true, audio: true, systemAudio: 'include', selfBrowserSurface: 'exclude',
  });
  if (!stream.getAudioTracks().length) {
    for (const t of stream.getTracks()) t.stop();
    throw new Error('No audio was shared. Pick the tab playing the song and tick "Share tab audio".');
  }
  return stream;
}

/* ------------------------------------------------------------------ */
/* Inference                                                           */
/* ------------------------------------------------------------------ */

// Run the model on mono 22050 Hz samples → raw note events {startTimeSeconds, durationSeconds, pitchMidi, amplitude}.
export async function detectNotes(samples, opts = {}) {
  const { onStatus, onProgress, signal } = opts;
  const { lib, bp } = await loadBasicPitch({ onStatus });
  if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
  onStatus && onStatus('Listening for notes… 0%');
  const frames = [], onsets = [], contours = [];
  await bp.evaluateModel(
    samples,
    (f, o, c) => { for (const x of f) frames.push(x); for (const x of o) onsets.push(x); for (const x of c) contours.push(x); },
    pct => {
      // The library reports a 0–1 fraction.
      const p = Math.max(0, Math.min(100, Math.round(pct <= 1 ? pct * 100 : pct)));
      onProgress && onProgress(p);
      onStatus && onStatus(`Listening for notes… ${p}%`);
    },
  );
  if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const { onsetThresh = 0.5, frameThresh = 0.3, minNoteLen = 11 } = opts.params || {};
  const events = lib.outputToNotesPoly(frames, onsets, onsetThresh, frameThresh, minNoteLen, true, null, null, true, 11);
  return lib.noteFramesToTime(lib.addPitchBendsToNoteEvents(contours, events));
}

// Drop a note that is exactly an octave above a simultaneous, louder note — the
// classic harmonic ghost. Real octave doublings played with comparable force survive.
export function dedupeOctaves(events, { ratio = 0.8, windowSec = 0.05 } = {}) {
  const sorted = events.slice().sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
  const drop = new Set();
  for (let i = 0; i < sorted.length; i++) {
    const lo = sorted[i];
    for (let j = i + 1; j < sorted.length && sorted[j].startTimeSeconds - lo.startTimeSeconds <= windowSec; j++) {
      const hi = sorted[j];
      if (Math.round(hi.pitchMidi) - Math.round(lo.pitchMidi) !== 12) continue;
      const overlap = Math.min(lo.startTimeSeconds + lo.durationSeconds, hi.startTimeSeconds + hi.durationSeconds)
        - Math.max(lo.startTimeSeconds, hi.startTimeSeconds);
      if (overlap < 0.6 * Math.min(lo.durationSeconds, hi.durationSeconds)) continue;
      if (hi.amplitude < ratio * lo.amplitude) drop.add(hi);
    }
    // Same check with the lower note starting slightly after the upper one.
    for (let j = i - 1; j >= 0 && lo.startTimeSeconds - sorted[j].startTimeSeconds <= windowSec; j--) {
      const hi = sorted[j];
      if (Math.round(hi.pitchMidi) - Math.round(lo.pitchMidi) !== 12) continue;
      if (hi.amplitude < ratio * lo.amplitude) drop.add(hi);
    }
  }
  return sorted.filter(e => !drop.has(e));
}

// Turn note events into the runtime song the player expects.
export function eventsToSong(events, { title = 'Transcribed from audio', artist = 'exact notes from the recording', octaveRatio = 0.8 } = {}) {
  const notes = [];
  for (const e of dedupeOctaves(events, { ratio: octaveRatio })) {
    if (!(e.durationSeconds >= 0.06) || !(e.amplitude >= 0.08)) continue;
    const midi = Math.round(e.pitchMidi);
    if (midi < 21 || midi > 108) continue;
    notes.push({
      midi,
      time: e.startTimeSeconds,
      duration: Math.min(e.durationSeconds, 6),
      velocity: Math.max(0.3, Math.min(1, e.amplitude * 1.4)),
      hand: midi >= 60 ? 1 : 0,
    });
  }
  notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
  let durationSec = 0;
  if (notes.length) {
    const shift = 0.5 - notes[0].time;
    for (const n of notes) {
      n.time += shift;
      if (n.time + n.duration > durationSec) durationSec = n.time + n.duration;
    }
  }
  return { title, artist, notes, durationSec, source: 'audio' };
}

// One call: samples → song.
export async function transcribeSamples(samples, opts = {}) {
  const events = await detectNotes(samples, opts);
  const song = eventsToSong(events, opts);
  if (song.notes.length < 4) throw new Error('Hardly any notes were detected — try a clearer recording, louder, or closer to the source.');
  return song;
}
