/*
 * Pianiol — falling-notes engine.
 * Owns one canvas: renders the fall zone + keyboard, schedules audio via an
 * injected synth, and handles touch/pointer piano input.
 * No imports; plain ES module.
 */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK_PC = [false, true, false, true, false, false, true, false, true, false, true, false];

const LOOKAHEAD = 0.3;        // seconds of audio scheduled ahead
const FALL_SECONDS = 3.2;     // visible travel time at 1x speed
const MAX_PARTICLES = 120;
const FLASH_MS = 250;
const PARTICLE_MS = 500;
const MIN_NOTE_H = 14;

// Hand palettes: [0] = left (warm orange), [1] = right/melody (teal).
const HANDS = [
  {
    top: '#ffb36b', bottom: '#f07f2e', border: 'rgba(255,214,166,0.95)',
    key: 'rgba(247,148,68,0.85)', glow: 'rgba(255,158,74,', name: 'rgba(255,255,255,0.75)'
  },
  {
    top: '#34e2e2', bottom: '#0aa2c0', border: 'rgba(178,247,247,0.95)',
    key: 'rgba(32,196,208,0.85)', glow: 'rgba(52,226,226,', name: 'rgba(255,255,255,0.75)'
  }
];

function midiName(midi) {
  const pc = ((midi % 12) + 12) % 12;
  return NOTE_NAMES[pc] + (Math.floor(midi / 12) - 1);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function roundRectPath(ctx, x, y, w, h, r) {
  if (w <= 0 || h <= 0) return ctx.beginPath();
  const rr = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

// Rounded only at the bottom (piano keys sit flush against the hit line).
function bottomRoundRectPath(ctx, x, y, w, h, r) {
  if (w <= 0 || h <= 0) return ctx.beginPath();
  const rr = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.closePath();
}

export class FallingNotes {
  constructor({ canvas, synth, onProgress, onEnd, onUserNote }) {
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');
    this._synth = synth;
    this._onProgress = typeof onProgress === 'function' ? onProgress : null;
    this._onEnd = typeof onEnd === 'function' ? onEnd : null;
    this._onUserNote = typeof onUserNote === 'function' ? onUserNote : null;

    // Song / timing state -------------------------------------------------
    this._song = null;
    this._notes = [];            // sorted by time
    this._times = null;          // Float64Array of note start times (binary search)
    this._scheduled = null;      // Uint8Array flags
    this._schedIndex = 0;        // next candidate for audio scheduling
    this._hitIndex = 0;          // next candidate for hit-line flash
    this._maxDur = 0;
    this._lastEnd = 0;
    this._duration = 0;

    this._state = 'stopped';
    this._songTime = 0;          // authoritative when not playing
    this._anchorSongTime = 0;
    this._anchorCtxTime = 0;
    this._speed = 1;
    this._transpose = 0;
    this._endFired = false;
    this._lastProgressAt = 0;

    // Layout --------------------------------------------------------------
    this._cssW = 0;
    this._cssH = 0;
    this._dpr = 1;
    this._kbTop = 0;             // y of keyboard top edge == hit line
    this._kbH = 0;
    this._blackH = 0;
    this._whiteW = 0;
    this._blackW = 0;
    this._loMidi = 48;           // C3
    this._hiMidi = 95;           // B6
    this._keys = [];             // geometry, whites then blacks appended
    this._whiteKeys = [];
    this._blackKeys = [];
    this._keyByMidi = new Array(128).fill(null);
    this._whiteGrad = null;      // cached keyboard gradients (rebuilt on resize)
    this._blackGrad = null;

    // Effects (pooled — no per-frame allocation) --------------------------
    this._particles = [];
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this._particles.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, born: 0, size: 0, hand: 1 });
    }
    this._liveParticles = 0;
    this._flashes = [];
    for (let i = 0; i < 32; i++) {
      this._flashes.push({ active: false, x: 0, w: 0, born: 0, hand: 1 });
    }
    this._liveFlashes = 0;

    // Per-frame scratch (reused) ------------------------------------------
    this._keyState = new Int8Array(128);   // 0 off, 1 hand0, 2 hand1, 3 user

    // Input ----------------------------------------------------------------
    this._userDown = new Set();            // midis held (pointer or programmatic)
    this._pointerKey = new Map();          // pointerId -> midi

    this._destroyed = false;
    this._dirty = true;
    this._raf = 0;

    // Bound handlers so destroy() can remove them.
    this._onPointerDown = (e) => this._pointerDown(e);
    this._onPointerMove = (e) => this._pointerMove(e);
    this._onPointerUp = (e) => this._pointerUp(e);
    this._onFrame = () => this._frame();

    canvas.style.touchAction = 'none';
    canvas.style.display = canvas.style.display || 'block';
    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerUp);
    canvas.addEventListener('lostpointercapture', this._onPointerUp);

    this.resize();
    this._raf = requestAnimationFrame(this._onFrame);
  }

  // ======================================================================
  // Public API
  // ======================================================================

  setSong(song) {
    this._synth.allOff?.();
    this._song = song || null;
    this._state = 'stopped';
    this._songTime = 0;
    this._endFired = false;

    if (song && Array.isArray(song.notes) && song.notes.length) {
      this._notes = song.notes.slice().sort((a, b) => a.time - b.time);
      const n = this._notes.length;
      this._times = new Float64Array(n);
      this._scheduled = new Uint8Array(n);
      let maxDur = 0;
      let lastEnd = 0;
      for (let i = 0; i < n; i++) {
        const nt = this._notes[i];
        this._times[i] = nt.time;
        const d = nt.duration || 0;
        if (d > maxDur) maxDur = d;
        const end = nt.time + d;
        if (end > lastEnd) lastEnd = end;
      }
      this._maxDur = maxDur;
      this._lastEnd = lastEnd;
      this._duration = (typeof song.durationSec === 'number' && song.durationSec > 0)
        ? song.durationSec : lastEnd;
    } else {
      this._notes = [];
      this._times = null;
      this._scheduled = null;
      this._maxDur = 0;
      this._lastEnd = 0;
      this._duration = 0;
    }
    this._schedIndex = 0;
    this._hitIndex = 0;
    this._computeRange();
    this._buildKeys();
    this._dirty = true;
  }

  play() {
    if (!this._song || !this._notes.length) return;
    this._synth.unlock();
    if (this._state === 'playing') return;
    if (this._state === 'stopped' || this._songTime >= this._lastEnd + 1) {
      if (this._songTime >= this._lastEnd + 1) this._songTime = 0;
      this._endFired = false;
    }
    this._anchorSongTime = this._songTime;
    this._anchorCtxTime = this._synth.currentTime;
    this._resetScheduling(this._songTime);
    this._state = 'playing';
    this._lastProgressAt = 0;
    this._dirty = true;
  }

  pause() {
    if (this._state !== 'playing') return;
    this._songTime = this.time;
    this._state = 'paused';
    this._synth.allOff?.();
    this._dirty = true;
  }

  stop() {
    if (this._state === 'playing') this._songTime = this.time;
    this._state = 'stopped';
    this._songTime = 0;
    this._endFired = false;
    this._synth.allOff?.();
    this._resetScheduling(0);
    this._dirty = true;
  }

  seek(sec) {
    const t = clamp(+sec || 0, 0, Math.max(this._duration, 0));
    const wasPlaying = this._state === 'playing';
    this._songTime = t;
    if (wasPlaying) {
      this._anchorSongTime = t;
      this._anchorCtxTime = this._synth.currentTime;
    }
    this._synth.allOff?.();
    this._resetScheduling(t);
    if (t < this._lastEnd + 1) this._endFired = false;
    this._dirty = true;
  }

  setSpeed(mult) {
    const s = clamp(+mult || 1, 0.25, 2);
    if (s === this._speed) return;
    // Re-anchor at the current instant so there is no time jump.
    if (this._state === 'playing') {
      this._songTime = this.time;
      this._anchorSongTime = this._songTime;
      this._anchorCtxTime = this._synth.currentTime;
    }
    this._speed = s;
    this._dirty = true;
  }

  setTranspose(semitones) {
    const t = clamp(Math.round(+semitones || 0), -12, 12);
    if (t === this._transpose) return;
    this._transpose = t;
    this._computeRange();
    this._buildKeys();
    this._dirty = true;
  }

  get state() { return this._state; }

  get time() {
    if (this._state === 'playing') {
      return this._anchorSongTime + (this._synth.currentTime - this._anchorCtxTime) * this._speed;
    }
    return this._songTime;
  }

  resize() {
    const rect = this._canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this._cssW = w;
    this._cssH = h;
    this._dpr = dpr;
    this._canvas.width = Math.round(w * dpr);
    this._canvas.height = Math.round(h * dpr);
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this._kbH = clamp(h * 0.24, 90, 190);
    this._kbTop = h - this._kbH;
    this._blackH = this._kbH * 0.62;
    this._buildKeys();
    this._dirty = true;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    cancelAnimationFrame(this._raf);
    const c = this._canvas;
    c.removeEventListener('pointerdown', this._onPointerDown);
    c.removeEventListener('pointermove', this._onPointerMove);
    c.removeEventListener('pointerup', this._onPointerUp);
    c.removeEventListener('pointercancel', this._onPointerUp);
    c.removeEventListener('lostpointercapture', this._onPointerUp);
    this._synth.allOff?.();
  }

  pressKey(midi) {
    const m = midi | 0;
    if (m < 0 || m > 127 || this._userDown.has(m)) return;
    this._synth.unlock();
    this._userDown.add(m);
    this._synth.noteOn(m, 0.85);
    this._dirty = true;
  }

  releaseKey(midi) {
    const m = midi | 0;
    if (!this._userDown.has(m)) return;
    this._userDown.delete(m);
    this._synth.noteOff(m);
    this._dirty = true;
  }

  // ======================================================================
  // Timing + scheduling internals
  // ======================================================================

  _lowerBound(t) {
    // First index whose start time >= t.
    const a = this._times;
    if (!a) return 0;
    let lo = 0, hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  _resetScheduling(t) {
    if (!this._scheduled) return;
    const idx = this._lowerBound(t);
    // Notes before t are treated as already played; notes at/after t are pending.
    this._scheduled.fill(1, 0, idx);
    this._scheduled.fill(0, idx);
    this._schedIndex = idx;
    this._hitIndex = idx;
  }

  _scheduleAudio(songTime) {
    const notes = this._notes;
    const n = notes.length;
    const horizon = songTime + LOOKAHEAD;
    while (this._schedIndex < n && this._times[this._schedIndex] < horizon) {
      const i = this._schedIndex++;
      if (this._scheduled[i]) continue;
      this._scheduled[i] = 1;
      const nt = notes[i];
      const when = this._anchorCtxTime + (nt.time - this._anchorSongTime) / this._speed;
      const dur = Math.max(0.02, (nt.duration || 0.05) / this._speed);
      const vel = (typeof nt.velocity === 'number') ? clamp(nt.velocity, 0.02, 1) : 0.8;
      this._synth.playNote(nt.midi + this._transpose, when, dur, vel);
    }
  }

  _advanceHits(songTime) {
    const notes = this._notes;
    const n = notes.length;
    while (this._hitIndex < n && this._times[this._hitIndex] <= songTime) {
      const nt = notes[this._hitIndex++];
      const geom = this._keyByMidi[nt.midi + this._transpose];
      if (geom) this._spawnHit(geom, (nt.hand === 0) ? 0 : 1);
    }
  }

  _spawnHit(geom, hand) {
    const now = performance.now();
    // Flash
    for (let i = 0; i < this._flashes.length; i++) {
      const f = this._flashes[i];
      if (!f.active) {
        f.active = true;
        f.x = geom.x + geom.w * 0.5;
        f.w = geom.w;
        f.born = now;
        f.hand = hand;
        this._liveFlashes++;
        break;
      }
    }
    // Sparkles: 4-6 tiny rising particles
    const count = 4 + ((Math.random() * 3) | 0);
    let made = 0;
    for (let i = 0; i < MAX_PARTICLES && made < count; i++) {
      const p = this._particles[i];
      if (p.active) continue;
      p.active = true;
      p.x = geom.x + geom.w * (0.15 + Math.random() * 0.7);
      p.y = this._kbTop - 2;
      p.vx = (Math.random() - 0.5) * 26;
      p.vy = -(45 + Math.random() * 70);
      p.born = now;
      p.size = 1.2 + Math.random() * 1.8;
      p.hand = hand;
      this._liveParticles++;
      made++;
    }
  }

  // ======================================================================
  // Key range + geometry
  // ======================================================================

  _computeRange() {
    let lo = 48, hi = 84; // C3..C6 default
    if (this._notes.length) {
      let mn = 127, mx = 0;
      for (let i = 0; i < this._notes.length; i++) {
        const m = this._notes[i].midi + this._transpose;
        if (m < mn) mn = m;
        if (m > mx) mx = m;
      }
      lo = Math.min(mn, lo);
      hi = Math.max(mx, hi);
    }
    lo = clamp(lo, 0, 120);
    hi = clamp(hi, lo, 127);
    // Pad out to full octaves: down to a C, up to a B.
    lo -= ((lo % 12) + 12) % 12;
    hi += 11 - (((hi % 12) + 12) % 12);
    this._loMidi = clamp(lo, 0, 127);
    this._hiMidi = clamp(hi, 0, 127);
  }

  _buildKeys() {
    const whites = this._whiteKeys;
    const blacks = this._blackKeys;
    whites.length = 0;
    blacks.length = 0;
    this._keyByMidi.fill(null);

    let whiteCount = 0;
    for (let m = this._loMidi; m <= this._hiMidi; m++) {
      if (!BLACK_PC[m % 12]) whiteCount++;
    }
    if (!whiteCount || !this._cssW) return;

    const whiteW = this._cssW / whiteCount;
    const blackW = whiteW * 0.6;
    this._whiteW = whiteW;
    this._blackW = blackW;

    let wi = 0;
    for (let m = this._loMidi; m <= this._hiMidi; m++) {
      const pc = m % 12;
      if (BLACK_PC[pc]) {
        const k = { midi: m, x: wi * whiteW - blackW * 0.5, w: blackW, black: true, isC: false };
        blacks.push(k);
        this._keyByMidi[m] = k;
      } else {
        const k = { midi: m, x: wi * whiteW, w: whiteW, black: false, isC: pc === 0 };
        whites.push(k);
        this._keyByMidi[m] = k;
        wi++;
      }
    }

    // Cache keyboard gradients (absolute y coords -> rebuilt with layout).
    const ctx = this._ctx;
    const wg = ctx.createLinearGradient(0, this._kbTop, 0, this._cssH);
    wg.addColorStop(0, '#e8e8ec');
    wg.addColorStop(0.06, '#fdfdfe');
    wg.addColorStop(0.85, '#f3f3f6');
    wg.addColorStop(1, '#dcdce2');
    this._whiteGrad = wg;

    const bg = ctx.createLinearGradient(0, this._kbTop, 0, this._kbTop + this._blackH);
    bg.addColorStop(0, '#3a3a42');
    bg.addColorStop(0.12, '#17171c');
    bg.addColorStop(0.8, '#0b0b0f');
    bg.addColorStop(1, '#26262e');
    this._blackGrad = bg;
  }

  // ======================================================================
  // Pointer input
  // ======================================================================

  _eventPos(e) {
    const rect = this._canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _keyAt(x, y) {
    if (y < this._kbTop || y > this._cssH || x < 0 || x > this._cssW) return null;
    // Black keys sit on top — test them first.
    if (y <= this._kbTop + this._blackH) {
      const blacks = this._blackKeys;
      for (let i = 0; i < blacks.length; i++) {
        const k = blacks[i];
        if (x >= k.x && x < k.x + k.w) return k;
      }
    }
    const wi = Math.floor(x / this._whiteW);
    const whites = this._whiteKeys;
    if (wi >= 0 && wi < whites.length) return whites[wi];
    return null;
  }

  _pointerDown(e) {
    const p = this._eventPos(e);
    const key = this._keyAt(p.x, p.y);
    if (!key) return; // outside keyboard: don't preventDefault, don't capture
    e.preventDefault();
    try { this._canvas.setPointerCapture(e.pointerId); } catch (_) { /* ok */ }
    this._pointerKey.set(e.pointerId, key.midi);
    this.pressKey(key.midi);
    if (this._onUserNote) this._onUserNote(key.midi, true);
  }

  _pointerMove(e) {
    if (!this._pointerKey.has(e.pointerId)) return;
    const prev = this._pointerKey.get(e.pointerId);
    const p = this._eventPos(e);
    const key = this._keyAt(p.x, p.y);
    if (key && key.midi === prev) return;
    e.preventDefault();
    // Release previous
    this._pointerKey.delete(e.pointerId);
    this.releaseKey(prev);
    if (this._onUserNote) this._onUserNote(prev, false);
    // Glissando onto the new key
    if (key) {
      this._pointerKey.set(e.pointerId, key.midi);
      this.pressKey(key.midi);
      if (this._onUserNote) this._onUserNote(key.midi, true);
    }
  }

  _pointerUp(e) {
    if (!this._pointerKey.has(e.pointerId)) return;
    const midi = this._pointerKey.get(e.pointerId);
    this._pointerKey.delete(e.pointerId);
    this.releaseKey(midi);
    if (this._onUserNote) this._onUserNote(midi, false);
  }

  // ======================================================================
  // Render loop
  // ======================================================================

  _frame() {
    if (this._destroyed) return;
    this._raf = requestAnimationFrame(this._onFrame);

    const playing = this._state === 'playing';
    let songTime = this.time;

    if (playing) {
      this._scheduleAudio(songTime);
      this._advanceHits(songTime);

      // Progress callback ~4x/sec
      const now = performance.now();
      if (this._onProgress && now - this._lastProgressAt >= 250) {
        this._lastProgressAt = now;
        this._onProgress(songTime, this._duration);
      }

      // End of song
      if (!this._endFired && songTime > this._lastEnd + 1) {
        this._endFired = true;
        this._songTime = clamp(songTime, 0, this._duration);
        this._state = 'paused';
        this._synth.allOff?.();
        if (this._onEnd) this._onEnd();
        songTime = this._songTime;
      }
    }

    const animating = this._liveParticles > 0 || this._liveFlashes > 0;
    if (!playing && !this._dirty && !animating) return;
    this._dirty = false;

    this._render(songTime);
  }

  _render(songTime) {
    const ctx = this._ctx;
    const w = this._cssW;
    const h = this._cssH;
    const kbTop = this._kbTop;
    const pps = (kbTop / FALL_SECONDS) * this._speed;

    ctx.clearRect(0, 0, w, h);

    // ---- Fall-zone guides ------------------------------------------------
    this._drawGuides(ctx, songTime, pps, kbTop, w);

    // ---- Key active-state map (reused Int8Array) -------------------------
    const ks = this._keyState;
    ks.fill(0);

    // ---- Falling notes ---------------------------------------------------
    if (this._notes.length && pps > 0) {
      const visStart = songTime - this._maxDur - 0.05;
      const visEnd = songTime + kbTop / pps + 0.05;
      const notes = this._notes;
      const n = notes.length;
      let i = this._lowerBound(visStart);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      for (; i < n; i++) {
        const nt = notes[i];
        if (nt.time > visEnd) break;
        const dispMidi = nt.midi + this._transpose;
        const geom = this._keyByMidi[dispMidi];
        if (!geom) continue;
        const hand = (nt.hand === 0) ? 0 : 1;

        // Mark sounding keys
        const dur = nt.duration || 0;
        if (songTime >= nt.time && songTime <= nt.time + dur) {
          ks[dispMidi] = hand + 1;
        }

        const bottom = kbTop - (nt.time - songTime) * pps;
        const height = Math.max(MIN_NOTE_H, dur * pps);
        const top = bottom - height;
        if (bottom <= 0 || top >= kbTop) continue; // fully outside fall zone

        const drawBottom = Math.min(bottom, kbTop);
        const drawTop = Math.max(top, -20);
        const dh = drawBottom - drawTop;
        if (dh <= 0.5) continue;

        const pal = HANDS[hand];
        const x = geom.x + 0.75;
        const nw = geom.w - 1.5;
        const grad = ctx.createLinearGradient(0, drawTop, 0, drawBottom);
        grad.addColorStop(0, pal.top);
        grad.addColorStop(1, pal.bottom);
        roundRectPath(ctx, x, drawTop, nw, dh, 6);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = pal.border;
        ctx.stroke();

        if (height >= 26 && dh >= 18 && nw >= 16) {
          ctx.font = 'bold 10px system-ui, sans-serif';
          ctx.fillStyle = pal.name;
          ctx.fillText(midiName(dispMidi), x + nw * 0.5, drawBottom - 6, nw - 2);
        }
      }
    }

    // ---- User-held keys override song highlight --------------------------
    for (const m of this._userDown) {
      if (m >= 0 && m < 128) ks[m] = 3;
    }

    // ---- Hit line --------------------------------------------------------
    ctx.save();
    ctx.shadowColor = 'rgba(255,255,255,0.75)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(0, kbTop - 1, w, 2);
    ctx.restore();

    // ---- Keyboard --------------------------------------------------------
    this._drawKeyboard(ctx, ks, kbTop, h);

    // ---- Hit flashes + particles ----------------------------------------
    this._drawEffects(ctx, kbTop);

    // ---- Progress bar ----------------------------------------------------
    if (this._duration > 0) {
      const frac = clamp(songTime / this._duration, 0, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(0, 0, w, 3);
      ctx.fillStyle = '#22c9d6';
      ctx.fillRect(0, 0, w * frac, 3);
    }
  }

  _drawGuides(ctx, songTime, pps, kbTop, w) {
    // Vertical lane separators at each C/F boundary.
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    const whites = this._whiteKeys;
    for (let i = 0; i < whites.length; i++) {
      const k = whites[i];
      const pc = k.midi % 12;
      if (pc === 0 || pc === 5) {
        ctx.fillRect(k.x, 0, 1, kbTop);
      }
    }
    // Scrolling beat grid, only when the song declares a bpm.
    const bpm = this._song && this._song.bpm;
    if (bpm && bpm > 0 && pps > 0) {
      const beatDur = 60 / bpm;
      const topTime = songTime + kbTop / pps;
      let bt = Math.max(0, Math.ceil(songTime / beatDur) * beatDur);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      const barStyle = 'rgba(255,255,255,0.09)';
      let beatNo = Math.round(bt / beatDur);
      for (; bt <= topTime; bt += beatDur, beatNo++) {
        const y = kbTop - (bt - songTime) * pps;
        if (y < 0 || y > kbTop) continue;
        if (beatNo % 4 === 0) {
          ctx.fillStyle = barStyle;
          ctx.fillRect(0, y, w, 1);
          ctx.fillStyle = 'rgba(255,255,255,0.05)';
        } else {
          ctx.fillRect(0, y, w, 1);
        }
      }
    }
  }

  _drawKeyboard(ctx, ks, kbTop, h) {
    const whites = this._whiteKeys;
    const blacks = this._blackKeys;
    const kbH = this._kbH;

    // Keyboard base (fills the 1px gaps between keys)
    ctx.fillStyle = '#101014';
    ctx.fillRect(0, kbTop, this._cssW, kbH);

    // White keys
    for (let i = 0; i < whites.length; i++) {
      const k = whites[i];
      bottomRoundRectPath(ctx, k.x + 0.5, kbTop + 1, k.w - 1, kbH - 3, 4);
      ctx.fillStyle = this._whiteGrad;
      ctx.fill();
      const st = ks[k.midi];
      if (st) {
        ctx.fillStyle = st === 3 ? 'rgba(255,255,255,0.35)' : HANDS[st - 1].key;
        ctx.fill();
        this._keyGlow(ctx, k, st, kbTop);
        if (st === 3) {
          ctx.fillStyle = 'rgba(34,201,214,0.55)';
          ctx.fill();
        }
      }
      if (k.isC) {
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = st ? 'rgba(255,255,255,0.85)' : 'rgba(110,110,120,0.9)';
        ctx.fillText(midiName(k.midi), k.x + k.w * 0.5, h - 7, k.w - 2);
      }
    }

    // Black keys on top
    const bh = this._blackH;
    for (let i = 0; i < blacks.length; i++) {
      const k = blacks[i];
      bottomRoundRectPath(ctx, k.x, kbTop, k.w, bh, 3);
      ctx.fillStyle = this._blackGrad;
      ctx.fill();
      const st = ks[k.midi];
      if (st) {
        ctx.fillStyle = st === 3 ? 'rgba(34,201,214,0.85)' : HANDS[st - 1].key;
        ctx.fill();
        this._keyGlow(ctx, k, st, kbTop);
      } else {
        // subtle gloss strip
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(k.x + k.w * 0.18, kbTop + 2, k.w * 0.2, bh * 0.5);
      }
    }
  }

  _keyGlow(ctx, key, st, kbTop) {
    const pal = HANDS[st === 3 ? 1 : st - 1];
    const gh = 46;
    const grad = ctx.createLinearGradient(0, kbTop - gh, 0, kbTop);
    grad.addColorStop(0, pal.glow + '0)');
    grad.addColorStop(1, pal.glow + '0.35)');
    ctx.fillStyle = grad;
    ctx.fillRect(key.x - 2, kbTop - gh, key.w + 4, gh);
  }

  _drawEffects(ctx, kbTop) {
    const now = performance.now();

    if (this._liveFlashes > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < this._flashes.length; i++) {
        const f = this._flashes[i];
        if (!f.active) continue;
        const age = now - f.born;
        if (age >= FLASH_MS) {
          f.active = false;
          this._liveFlashes--;
          continue;
        }
        const t = age / FLASH_MS;
        const alpha = (1 - t) * 0.8;
        const r = f.w * (0.7 + t * 1.1);
        const grad = ctx.createRadialGradient(f.x, kbTop, 0, f.x, kbTop, r);
        grad.addColorStop(0, HANDS[f.hand].glow + alpha + ')');
        grad.addColorStop(1, HANDS[f.hand].glow + '0)');
        ctx.fillStyle = grad;
        ctx.fillRect(f.x - r, kbTop - r, r * 2, r * 2);
      }
      ctx.restore();
    }

    if (this._liveParticles > 0) {
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const p = this._particles[i];
        if (!p.active) continue;
        const age = now - p.born;
        if (age >= PARTICLE_MS) {
          p.active = false;
          this._liveParticles--;
          continue;
        }
        const t = age / PARTICLE_MS;
        const dt = age / 1000;
        const x = p.x + p.vx * dt;
        const y = p.y + p.vy * dt;
        if (y < 0) continue;
        ctx.globalAlpha = 1 - t;
        ctx.fillStyle = HANDS[p.hand].top;
        ctx.beginPath();
        ctx.arc(x, y, p.size * (1 - t * 0.5), 0, 6.2832);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }
}
