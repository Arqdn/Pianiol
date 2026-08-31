// Pianiol — Listen mode: microphone melody transcription.
// Captures mic audio, tracks the dominant pitch (McLeod-style NSDF autocorrelation),
// and segments the stream into discrete note events.

const FRAME_MS = 33;            // ~30 Hz analysis rate
const FFT_SIZE = 2048;
const MIN_FREQ = 60;
const MAX_FREQ = 1200;
const MIN_RMS = 0.01;
const MIN_CLARITY = 0.9;
const PEAK_TOLERANCE = 0.9;     // MPM: accept smallest lag within 0.9 of global max
const MEDIAN_WINDOW = 5;
const CHANGE_FRAMES = 3;        // frames of a differing semitone before a note split
const SILENCE_END_FRAMES = 4;   // unvoiced frames that end a note
const MIN_NOTE_SEC = 0.09;
const REATTACK_RATIO = 2.5;
const REATTACK_GUARD_SEC = 0.12; // ignore re-attacks right after a note onset
const MIDI_MIN = 36;
const MIDI_MAX = 96;

function median(values) {
  const s = Array.from(values).sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export class Transcriber {
  constructor() {
    this._ctx = null;
    this._stream = null;
    this._source = null;
    this._analyser = null;
    this._timer = null;
    this._buf = null;
    this._nsdf = null;
    this._running = false;
    this._t0 = 0;
    this._onNote = null;
    this._onLevel = null;
    this._onPitch = null;
    this._notes = [];
    this._recent = [];   // recent voiced midiFloat readings (median filter)
    this._pending = [];  // consecutive frames at a new semitone (note-split vote)
    this._active = null; // {start, semi, frames, lastT}
    this._silence = 0;
    this._rmsAvg = 0;
  }

  get running() { return this._running; }

  async start({ onNote, onLevel, onPitch } = {}) {
    if (this._running) return;
    // Any getUserMedia failure propagates to the caller.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this._ctx = new AC();
      if (this._ctx.state === 'suspended') await this._ctx.resume();
      this._stream = stream;
      this._source = this._ctx.createMediaStreamSource(stream);
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = FFT_SIZE;
      this._analyser.smoothingTimeConstant = 0;
      this._source.connect(this._analyser);
      this._buf = new Float32Array(FFT_SIZE);
      this._nsdf = new Float32Array((FFT_SIZE >> 1) + 2);
    } catch (err) {
      for (const track of stream.getTracks()) track.stop();
      if (this._ctx) this._ctx.close().catch(() => {});
      this._ctx = this._stream = this._source = this._analyser = null;
      throw err;
    }
    this._onNote = typeof onNote === 'function' ? onNote : null;
    this._onLevel = typeof onLevel === 'function' ? onLevel : null;
    this._onPitch = typeof onPitch === 'function' ? onPitch : null;
    this._notes = [];
    this._recent = [];
    this._pending = [];
    this._active = null;
    this._silence = 0;
    this._rmsAvg = 0;
    this._t0 = performance.now();
    this._running = true;
    this._timer = setInterval(() => this._frame(), FRAME_MS);
  }

  stop() {
    if (this._timer !== null) { clearInterval(this._timer); this._timer = null; }
    if (this._active) this._endNote(this._active.lastT + FRAME_MS / 1000);
    if (this._stream) {
      for (const track of this._stream.getTracks()) track.stop();
      this._stream = null;
    }
    if (this._source) { try { this._source.disconnect(); } catch (_) {} this._source = null; }
    this._analyser = null;
    if (this._ctx) { this._ctx.close().catch(() => {}); this._ctx = null; }
    this._running = false;

    const notes = this._notes.map((n) => ({ ...n }));
    let durationSec = 0;
    if (notes.length > 0) {
      const shift = 0.5 - notes[0].time;
      let lastEnd = 0;
      for (const n of notes) {
        n.time += shift;
        lastEnd = Math.max(lastEnd, n.time + n.duration);
      }
      durationSec = lastEnd + 0.5;
    }
    return { title: 'Listened melody', notes, durationSec };
  }

  _frame() {
    if (!this._running || !this._analyser) return;
    const t = (performance.now() - this._t0) / 1000;
    this._analyser.getFloatTimeDomainData(this._buf);

    let sumSq = 0;
    for (let i = 0; i < this._buf.length; i++) sumSq += this._buf[i] * this._buf[i];
    const rms = Math.min(1, Math.sqrt(sumSq / this._buf.length));
    if (this._onLevel) this._onLevel(rms);

    const pitch = rms >= MIN_RMS ? this._detectPitch(this._buf) : null;
    if (this._onPitch) this._onPitch(pitch);

    const reattack = this._rmsAvg > 1e-4 && rms > REATTACK_RATIO * this._rmsAvg;
    this._rmsAvg = this._rmsAvg === 0 ? rms : this._rmsAvg * 0.9 + rms * 0.1;

    if (pitch === null) {
      this._silence++;
      this._pending.length = 0;
      if (this._silence >= SILENCE_END_FRAMES) {
        if (this._active) this._endNote(this._active.lastT);
        this._recent.length = 0;
      }
      return;
    }

    this._silence = 0;
    this._recent.push(pitch);
    if (this._recent.length > MEDIAN_WINDOW) this._recent.shift();
    const semi = Math.round(median(this._recent));

    if (!this._active) {
      this._startNote(t, semi);                                  // (a) onset after silence
    } else if (reattack && t - this._active.start >= REATTACK_GUARD_SEC) {
      this._endNote(t);                                          // (c) re-attack, same pitch
      this._startNote(t, semi);
    } else if (Math.abs(semi - this._active.semi) >= 1) {
      this._pending.push({ t, semi });                           // (b) sustained pitch change
      if (this._pending.length >= CHANGE_FRAMES) {
        const first = this._pending[0];
        const held = this._pending.slice();
        this._endNote(first.t);
        this._startNote(first.t, held[held.length - 1].semi);
        for (const p of held) {
          this._active.frames.push(p.semi);
          this._active.lastT = p.t;
        }
      }
    } else {
      this._pending.length = 0;
      this._active.frames.push(semi);
      this._active.lastT = t;
    }
  }

  _startNote(t, semi) {
    this._pending.length = 0;
    this._active = { start: t, semi, frames: [semi], lastT: t };
  }

  _endNote(endT) {
    const n = this._active;
    this._active = null;
    this._pending.length = 0;
    if (!n) return;
    const duration = endT - n.start;
    if (duration < MIN_NOTE_SEC) return;
    const midi = Math.max(MIDI_MIN, Math.min(MIDI_MAX, Math.round(median(n.frames))));
    this._notes.push({ midi, time: n.start, duration, velocity: 0.8, hand: 1 });
    if (this._onNote) this._onNote({ midi, time: n.start, duration });
  }

  // NSDF (normalized square-difference) autocorrelation with MPM peak picking.
  _detectPitch(buf) {
    const sr = this._ctx.sampleRate;
    const n = buf.length;
    const minLag = Math.max(2, Math.floor(sr / MAX_FREQ));
    const maxLag = Math.min(Math.ceil(sr / MIN_FREQ), n >> 1);
    if (minLag + 2 >= maxLag) return null;

    const nsdf = this._nsdf;
    for (let tau = minLag - 1; tau <= maxLag + 1; tau++) {
      let ac = 0, m = 0;
      for (let i = 0, j = tau; j < n; i++, j++) {
        const a = buf[i], b = buf[j];
        ac += a * b;
        m += a * a + b * b;
      }
      nsdf[tau] = m > 0 ? (2 * ac) / m : 0;
    }

    // Collect local maxima, then take the smallest lag within tolerance of the
    // global peak — suppresses octave-down (double-period) errors.
    let globalMax = -Infinity;
    const peaks = [];
    for (let tau = minLag; tau <= maxLag; tau++) {
      const v = nsdf[tau];
      if (v > 0 && v > nsdf[tau - 1] && v >= nsdf[tau + 1]) {
        peaks.push(tau);
        if (v > globalMax) globalMax = v;
      }
    }
    if (peaks.length === 0 || globalMax < MIN_CLARITY * PEAK_TOLERANCE) return null;
    let best = -1;
    for (const tau of peaks) {
      if (nsdf[tau] >= PEAK_TOLERANCE * globalMax) { best = tau; break; }
    }
    if (best < 0) return null;

    // Parabolic interpolation for sub-bin lag and peak height.
    const y0 = nsdf[best - 1], y1 = nsdf[best], y2 = nsdf[best + 1];
    const denom = y0 - 2 * y1 + y2;
    let shift = 0;
    if (Math.abs(denom) > 1e-12) shift = Math.max(-1, Math.min(1, (0.5 * (y0 - y2)) / denom));
    const clarity = Math.min(1, y1 - 0.25 * (y0 - y2) * shift);
    if (clarity < MIN_CLARITY) return null;

    const freq = sr / (best + shift);
    if (!(freq >= MIN_FREQ && freq <= MAX_FREQ)) return null;
    return 69 + 12 * Math.log2(freq / 440);
  }
}
