// Pianiol — WebAudio instrument engine.
// Exports INSTRUMENTS (the selectable sound recipes) and Synth (the engine).
// All scheduling is click-free (setValueAtTime / exponentialRamp / setTargetAtTime only)
// and every voice's nodes are stopped and disconnected when its tail ends.

export const INSTRUMENTS = [
  { id: 'piano', name: 'Piano', emoji: '🎹' },
  { id: 'epiano', name: 'E-Piano', emoji: '🎛️' },
  { id: 'musicbox', name: 'Music Box', emoji: '🎐' },
  { id: 'guitar', name: 'Guitar', emoji: '🎸' },
  { id: 'synth', name: 'Synth Lead', emoji: '🌊' },
  { id: 'strings', name: 'Strings', emoji: '🎻' },
  { id: 'flute', name: 'Flute', emoji: '🪈' },
  { id: 'marimba', name: 'Marimba', emoji: '🥢' },
];

const MAX_VOICES = 48;
const SILENT = 0.0001; // exponential/target floor (never ramp to exactly 0)

const midiToFreq = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

export class Synth {
  constructor() {
    this._ctx = null; // created lazily (autoplay policy)
    this._master = null; // GainNode (volume)
    this._comp = null; // DynamicsCompressorNode
    this._instrument = 'piano';
    this._volume = 0.9;
    this._voices = new Set(); // every live/scheduled voice
    this._held = new Map(); // midi -> voice (interactive sustained notes)
    this._noiseBuf = null;
  }

  get ctx() {
    if (!this._ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) throw new Error('Web Audio API is not supported in this browser');
      try {
        this._ctx = new AC({ latencyHint: 'interactive' });
      } catch (err) {
        this._ctx = new AC();
      }
      const ctx = this._ctx;
      this._master = ctx.createGain();
      this._master.gain.value = this._volume;
      this._comp = ctx.createDynamicsCompressor();
      this._comp.threshold.value = -16;
      this._comp.knee.value = 18;
      this._comp.ratio.value = 5;
      this._comp.attack.value = 0.003;
      this._comp.release.value = 0.25;
      this._master.connect(this._comp);
      this._comp.connect(ctx.destination);
    }
    return this._ctx;
  }

  async unlock() {
    const ctx = this.ctx;
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch (err) {
        console.warn('Pianiol: AudioContext resume failed', err);
      }
    }
  }

  get currentTime() {
    return this.ctx.currentTime;
  }

  setInstrument(id) {
    this._instrument = INSTRUMENTS.some((i) => i.id === id) ? id : 'piano';
  }

  get instrument() {
    return this._instrument;
  }

  setVolume(v) {
    let vol = Number(v);
    if (!Number.isFinite(vol)) vol = 0.9;
    this._volume = Math.min(1, Math.max(0, vol));
    if (this._master) {
      const g = this._master.gain;
      const t = this._ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(this._volume, t, 0.01); // ~30ms glide, no clicks
    }
  }

  // Schedule a complete note. `when` is absolute AudioContext time.
  playNote(midi, when, duration, velocity = 0.8) {
    const ctx = this.ctx;
    const t0 = Math.max(Number(when) || 0, ctx.currentTime + 0.002);
    const dur = Number.isFinite(duration) ? Math.max(duration, 0.04) : 0.5;
    const voice = this._spawn(midi, t0, velocity);
    if (voice && !voice.released) this._release(voice, t0 + dur);
  }

  // Start a sustained note now (interactive key press).
  noteOn(midi, velocity = 0.8) {
    const ctx = this.ctx;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    const prev = this._held.get(midi);
    if (prev) {
      this._cut(prev, 0.03);
      this._held.delete(midi);
    }
    const voice = this._spawn(midi, ctx.currentTime + 0.002, velocity);
    if (voice) this._held.set(midi, voice);
  }

  // Release the sustained note for that midi with a natural tail.
  noteOff(midi) {
    if (!this._ctx) return;
    const voice = this._held.get(midi);
    this._held.delete(midi);
    if (voice) this._release(voice, this._ctx.currentTime);
  }

  // Kill everything with a short 50ms fade.
  allOff() {
    if (!this._ctx) return;
    for (const voice of this._voices) this._cut(voice, 0.05);
    this._held.clear();
  }

  // ---------- internals ----------

  _noise() {
    if (!this._noiseBuf) {
      const sr = this._ctx.sampleRate;
      const buf = this._ctx.createBuffer(1, sr, sr);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this._noiseBuf = buf;
    }
    return this._noiseBuf;
  }

  // Attack + decay-toward-sustain envelope on a gain AudioParam.
  _env(g, t0, atk, peak, sus, decayTC) {
    g.setValueAtTime(SILENT, t0);
    g.exponentialRampToValueAtTime(Math.max(peak, 0.001), t0 + atk);
    g.setTargetAtTime(Math.max(sus, SILENT), t0 + atk, decayTC);
  }

  _dispose(voice) {
    for (const n of voice.nodes) {
      try {
        n.disconnect();
      } catch (err) { /* already disconnected */ }
    }
    this._voices.delete(voice);
    if (this._held.get(voice.midi) === voice) this._held.delete(voice.midi);
  }

  // Natural release: fade the voice envelope at time t and stop all sources.
  _release(voice, t) {
    if (voice.released) return;
    voice.released = true;
    t = Math.max(t, voice.minRel);
    voice.env.gain.setTargetAtTime(SILENT, t, voice.relTC);
    if (voice.onRelease) voice.onRelease(t);
    const end = t + voice.relTC * 8 + 0.03;
    for (const s of voice.sources) {
      try {
        s.stop(end);
      } catch (err) { /* stop already scheduled */ }
    }
    voice.endTime = end;
  }

  // Forced fast fade (allOff / retrigger). Cancels any pending automation so a
  // note scheduled in the future cannot come back to life.
  _cut(voice, fade = 0.05) {
    const t = this._ctx.currentTime;
    const g = voice.env.gain;
    let cur = SILENT;
    try {
      cur = Math.max(g.value, SILENT);
    } catch (err) { /* keep floor */ }
    try {
      g.cancelScheduledValues(t);
      g.setValueAtTime(cur, t);
      g.setTargetAtTime(SILENT, t, fade / 3);
    } catch (err) { /* param gone */ }
    const end = t + fade + 0.05;
    for (const s of voice.sources) {
      try {
        s.stop(end);
      } catch (err) { /* stop already scheduled */ }
    }
    voice.released = true;
    voice.endTime = end;
  }

  _spawn(midi, t0, velocity) {
    if (!Number.isFinite(midi)) return null;
    const ctx = this.ctx;
    if (this._voices.size >= MAX_VOICES) {
      // Sweep out voices whose tails have passed (in case onended lagged),
      // otherwise silently drop this new note.
      const now = ctx.currentTime;
      for (const v of this._voices) {
        if (v.endTime && v.endTime < now - 0.05) this._dispose(v);
      }
      if (this._voices.size >= MAX_VOICES) return null;
    }
    let vel = Number(velocity);
    if (!Number.isFinite(vel)) vel = 0.8;
    vel = Math.min(1, Math.max(0.03, vel));
    const freq = midiToFreq(midi);

    const env = ctx.createGain();
    env.gain.value = SILENT;
    env.connect(this._master);
    const voice = {
      midi,
      t0,
      env,
      nodes: [env],
      sources: [],
      released: false,
      endTime: 0,
      relTC: 0.1,
      minRel: t0,
      natural: null, // one-shot voices set their self-release time
      onRelease: null,
    };
    this._buildVoice(voice, this._instrument, freq, t0, vel);

    for (const s of voice.sources) s.start(t0);
    voice.sources[0].onended = () => this._dispose(voice);
    this._voices.add(voice);
    if (voice.natural != null) this._release(voice, t0 + voice.natural);
    return voice;
  }

  _buildVoice(voice, id, freq, t0, vel) {
    const ctx = this._ctx;
    const env = voice.env;
    const osc = (type, f, det = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      if (det) o.detune.value = det;
      voice.nodes.push(o);
      voice.sources.push(o);
      return o;
    };
    const gain = (v) => {
      const g = ctx.createGain();
      g.gain.value = v;
      voice.nodes.push(g);
      return g;
    };
    const filt = (type, f, q) => {
      const fl = ctx.createBiquadFilter();
      fl.type = type;
      fl.frequency.value = f;
      fl.Q.value = q;
      voice.nodes.push(fl);
      return fl;
    };
    const noise = () => {
      const s = ctx.createBufferSource();
      s.buffer = this._noise();
      s.loop = true;
      voice.nodes.push(s);
      voice.sources.push(s);
      return s;
    };

    switch (id) {
      case 'epiano': { // sine + slight FM for a Rhodes-like tine, soft attack
        const atk = 0.012;
        const car = osc('sine', freq);
        car.connect(env);
        const mod = osc('sine', freq);
        const mg = gain(0);
        mg.gain.setValueAtTime(freq * 0.9 * vel, t0);
        mg.gain.setTargetAtTime(freq * 0.04, t0 + 0.02, 0.25);
        mod.connect(mg);
        mg.connect(car.frequency);
        const tng = gain(SILENT); // tine sparkle
        tng.gain.setValueAtTime(SILENT, t0);
        tng.gain.exponentialRampToValueAtTime(0.12, t0 + 0.005);
        tng.gain.setTargetAtTime(SILENT, t0 + 0.005, 0.07);
        osc('sine', freq * 4).connect(tng);
        tng.connect(env);
        this._env(env.gain, t0, atk, vel * 0.8, vel * 0.1, 1.1);
        voice.relTC = 0.12;
        voice.minRel = t0 + atk + 0.01;
        break;
      }
      case 'musicbox': { // an octave up, fast attack, long sparkly decay
        const f = freq * 2;
        const dec = Math.min(3.2, Math.max(1, 2.6 * Math.pow(880 / f, 0.25)));
        osc('sine', f).connect(env);
        const pg = gain(SILENT); // 4x partial, dies faster than the fundamental
        pg.gain.setValueAtTime(0.18, t0);
        pg.gain.setTargetAtTime(SILENT, t0 + 0.01, dec / 6);
        osc('sine', f * 4).connect(pg);
        pg.connect(env);
        this._env(env.gain, t0, 0.002, vel * 0.75, SILENT, dec / 3);
        voice.relTC = 0.3;
        voice.natural = dec * 1.5;
        voice.minRel = t0 + 0.01;
        break;
      }
      case 'guitar': { // Karplus-Strong: noise burst into a damped feedback delay
        const period = 1 / freq;
        const t60 = Math.min(4.5, Math.max(0.6, 3.2 * Math.pow(220 / freq, 0.6)));
        const fb = Math.min(0.996, Math.exp(Math.log(0.001) / (t60 * freq)));
        const src = noise();
        const bg = gain(SILENT); // one-period excitation burst
        bg.gain.setValueAtTime(SILENT, t0);
        bg.gain.linearRampToValueAtTime(vel * 0.9, t0 + 0.001);
        bg.gain.setTargetAtTime(SILENT, t0 + period, 0.002);
        src.connect(bg);
        const dl = ctx.createDelay(0.1);
        dl.delayTime.value = Math.min(period, 0.09);
        voice.nodes.push(dl);
        const damp = filt('lowpass', Math.min(7000, Math.max(1200, freq * 6)), 0.4);
        const fbg = gain(fb);
        bg.connect(dl);
        dl.connect(damp);
        damp.connect(fbg);
        fbg.connect(dl);
        damp.connect(env);
        const pick = gain(0.45); // direct burst = pick transient
        bg.connect(pick);
        pick.connect(env);
        env.gain.setValueAtTime(0.8, t0);
        voice.relTC = 0.07;
        voice.natural = t60; // never rings forever
        voice.minRel = t0 + 0.01;
        break;
      }
      case 'synth': { // 2 detuned saws + resonant lowpass sweeping down
        const atk = 0.01;
        const cutoff = Math.min(freq * 12, 12000);
        const lp = filt('lowpass', cutoff, 7);
        lp.frequency.setValueAtTime(cutoff, t0);
        lp.frequency.setTargetAtTime(Math.max(freq * 2.2, 500), t0 + atk, 0.16);
        lp.connect(env);
        osc('sawtooth', freq, -9).connect(lp);
        osc('sawtooth', freq, 9).connect(lp);
        this._env(env.gain, t0, atk, vel * 0.5, vel * 0.38, 0.5);
        voice.relTC = 0.11;
        voice.minRel = t0 + atk + 0.005;
        voice.onRelease = (t) => lp.frequency.setTargetAtTime(Math.max(freq * 1.2, 300), t, 0.1);
        break;
      }
      case 'strings': { // 3 detuned saws, slow attack, gentle lowpass, 5Hz vibrato
        const atk = 0.08;
        const lp = filt('lowpass', Math.min(freq * 4.5, 6500), 0.3);
        lp.connect(env);
        const lfo = osc('sine', 5);
        const lg = gain(SILENT); // vibrato depth (cents) fades in
        lg.gain.setValueAtTime(SILENT, t0);
        lg.gain.setTargetAtTime(6, t0 + 0.25, 0.4);
        lfo.connect(lg);
        for (const det of [-8, 0, 8]) {
          const o = osc('sawtooth', freq, det);
          o.connect(lp);
          lg.connect(o.detune);
        }
        this._env(env.gain, t0, atk, vel * 0.42, vel * 0.36, 0.6);
        voice.relTC = 0.22;
        voice.minRel = t0 + atk + 0.02;
        break;
      }
      case 'flute': { // sine + a little triangle, breath noise, fading-in vibrato
        const atk = 0.04;
        const main = osc('sine', freq);
        main.connect(env);
        const tg = gain(0.22);
        const tri = osc('triangle', freq);
        tri.connect(tg);
        tg.connect(env);
        const bp = filt('bandpass', Math.min(freq * 2.5, 9000), 0.9);
        const ng = gain(SILENT); // breath level
        ng.gain.setValueAtTime(SILENT, t0);
        ng.gain.setTargetAtTime(vel * 0.035, t0, 0.1);
        noise().connect(bp);
        bp.connect(ng);
        ng.connect(env);
        const lfo = osc('sine', 5);
        const lg = gain(SILENT);
        lg.gain.setValueAtTime(SILENT, t0);
        lg.gain.setTargetAtTime(7, t0 + 0.3, 0.35);
        lfo.connect(lg);
        lg.connect(main.detune);
        lg.connect(tri.detune);
        this._env(env.gain, t0, atk, vel * 0.6, vel * 0.5, 0.4);
        voice.relTC = 0.1;
        voice.minRel = t0 + atk + 0.01;
        break;
      }
      case 'marimba': { // sine + 4x partial, percussive decay scaled by pitch
        const dec = Math.min(0.9, Math.max(0.4, 1.15 * Math.pow(261 / freq, 0.4)));
        osc('sine', freq).connect(env);
        const pg = gain(SILENT);
        pg.gain.setValueAtTime(0.25, t0);
        pg.gain.setTargetAtTime(SILENT, t0 + 0.004, dec / 7);
        osc('sine', freq * 4).connect(pg);
        pg.connect(env);
        this._env(env.gain, t0, 0.002, vel * 0.9, SILENT, dec / 4);
        voice.relTC = 0.05;
        voice.natural = dec * 1.6;
        voice.minRel = t0 + 0.008;
        break;
      }
      default: { // piano: detuned tri/sine layers, attack transient, closing lowpass
        const dec = Math.min(7, Math.max(1, 5.5 * Math.pow(220 / freq, 0.7)));
        const atk = 0.004;
        const cutoff = Math.min(freq * 9, 10000);
        const lp = filt('lowpass', cutoff, 0.4);
        lp.frequency.setValueAtTime(cutoff, t0);
        lp.frequency.setTargetAtTime(Math.max(freq * 1.5, 280), t0 + atk, dec / 4);
        lp.connect(env);
        osc('triangle', freq, -3).connect(lp);
        osc('triangle', freq, 3).connect(lp);
        const og = gain(0.35); // octave shimmer
        osc('sine', freq * 2, 2).connect(og);
        og.connect(lp);
        const trg = gain(SILENT); // bright hammer transient
        trg.gain.setValueAtTime(SILENT, t0);
        trg.gain.exponentialRampToValueAtTime(vel * 0.5, t0 + 0.003);
        trg.gain.setTargetAtTime(SILENT, t0 + 0.003, 0.012);
        osc('sawtooth', freq * 1.005).connect(trg);
        trg.connect(lp);
        this._env(env.gain, t0, atk, vel * 0.85, SILENT, dec / 3);
        voice.relTC = 0.08;
        voice.minRel = t0 + atk + 0.01;
        voice.onRelease = (t) => lp.frequency.setTargetAtTime(Math.max(freq, 200), t, 0.08);
        break;
      }
    }
  }
}
