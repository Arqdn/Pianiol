// midi.js — Standard MIDI File (SMF) parser for Pianiol.
// Parses format 0/1/2 files with running status, tempo maps, and SMPTE timing.

const UTF8 = new TextDecoder('utf-8');

function readU16(b, o) { return (b[o] << 8) | b[o + 1]; }
function readU32(b, o) { return (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0); }
function chunkType(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

class Reader {
  constructor(bytes, start, end) { this.b = bytes; this.p = start; this.end = end; }
  get eof() { return this.p >= this.end; }
  u8() {
    if (this.p >= this.end) throw new Error('Unexpected end of track data');
    return this.b[this.p++];
  }
  peek() {
    if (this.p >= this.end) throw new Error('Unexpected end of track data');
    return this.b[this.p];
  }
  skip(n) {
    this.p += n;
    if (this.p > this.end) throw new Error('Unexpected end of track data');
  }
  vlq() {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.u8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('Variable-length quantity too long');
  }
}

// Parses one MTrk body, pushing tempo events and raw (tick-based) notes into
// `state`. A corrupt track stops parsing that track only; whatever was read
// before the corruption is kept, and unclosed note-ons are still flushed.
function parseTrack(bytes, start, end, trackIndex, state) {
  const r = new Reader(bytes, start, end);
  const pending = new Map(); // (channel<<8)|midi -> FIFO of {tick, velocity}
  let tick = 0;
  let running = 0;
  try {
    while (!r.eof) {
      tick += r.vlq();
      let status = r.peek();
      if (status & 0x80) {
        r.u8();
        if (status < 0xf0) running = status;
      } else {
        status = running;
        if (!(status & 0x80)) throw new Error('Data byte with no running status');
      }
      if (status === 0xff) { // meta event
        running = 0;
        const type = r.u8();
        const len = r.vlq();
        const dataStart = r.p;
        r.skip(len);
        if (type === 0x51 && len >= 3) {
          const us = (bytes[dataStart] << 16) | (bytes[dataStart + 1] << 8) | bytes[dataStart + 2];
          if (us > 0) state.tempos.push({ tick, us });
        } else if (type === 0x03 && state.name === null) {
          const text = UTF8.decode(bytes.subarray(dataStart, dataStart + len)).replace(/\0/g, '').trim();
          if (text) state.name = text;
        } else if (type === 0x2f) {
          break; // end of track
        }
      } else if (status === 0xf0 || status === 0xf7) { // sysex
        running = 0;
        r.skip(r.vlq());
      } else if (status >= 0xf0) {
        throw new Error('Unexpected system message in track');
      } else { // channel voice message
        const hi = status & 0xf0;
        const channel = status & 0x0f;
        const d1 = r.u8() & 0x7f;
        const d2 = (hi === 0xc0 || hi === 0xd0) ? 0 : (r.u8() & 0x7f);
        if (hi === 0x90 && d2 > 0) {
          let fifo = pending.get((channel << 8) | d1);
          if (!fifo) pending.set((channel << 8) | d1, fifo = []);
          fifo.push({ tick, velocity: d2 / 127 });
        } else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) {
          const fifo = pending.get((channel << 8) | d1);
          if (fifo && fifo.length) {
            const on = fifo.shift(); // oldest note-on wins (FIFO)
            state.rawNotes.push({
              midi: d1, channel, track: trackIndex,
              startTick: on.tick, endTick: tick, velocity: on.velocity, open: false,
            });
          }
        }
        // 0xa0/0xb0/0xe0 (2 bytes) and 0xc0/0xd0 (1 byte) consumed, ignored.
      }
    }
  } catch (err) {
    // Corrupt track: keep what was parsed so far, abandon the rest of it.
  }
  // Flush unclosed note-ons; they are given a fixed 0.25s duration later.
  for (const [key, fifo] of pending) {
    for (const on of fifo) {
      state.rawNotes.push({
        midi: key & 0xff, channel: key >> 8, track: trackIndex,
        startTick: on.tick, endTick: on.tick, velocity: on.velocity, open: true,
      });
    }
  }
}

// Merges tempo events from all tracks into ordered segments carrying the
// cumulative time in seconds at each tempo change.
function buildTempoMap(tempos, ticksPerQuarter) {
  const sorted = tempos.slice().sort((a, b) => a.tick - b.tick);
  const segments = [{ tick: 0, sec: 0, spt: 500000 / 1e6 / ticksPerQuarter }];
  for (const { tick, us } of sorted) {
    const last = segments[segments.length - 1];
    const spt = us / 1e6 / ticksPerQuarter;
    if (tick === last.tick) last.spt = spt; // same tick: later event wins
    else segments.push({ tick, sec: last.sec + (tick - last.tick) * last.spt, spt });
  }
  return segments;
}

function tickToSeconds(segments, tick) {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) { // binary search: last segment starting at or before tick
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid].tick <= tick) lo = mid; else hi = mid - 1;
  }
  const s = segments[lo];
  return s.sec + (tick - s.tick) * s.spt;
}

export function parseMidi(arrayBuffer) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  if (bytes.length < 14 || chunkType(bytes, 0) !== 'MThd' || readU32(bytes, 4) < 6) {
    throw new Error('Not a MIDI file');
  }
  const headerLen = readU32(bytes, 4);
  const division = readU16(bytes, 12); // format (8) and ntracks (10) are informational
  const state = { name: null, tempos: [], rawNotes: [] };
  let trackCount = 0;
  let offset = 8 + headerLen;
  while (offset + 8 <= bytes.length) {
    const type = chunkType(bytes, offset);
    const bodyStart = offset + 8;
    const len = Math.min(readU32(bytes, offset + 4), bytes.length - bodyStart);
    if (type === 'MTrk') parseTrack(bytes, bodyStart, bodyStart + len, trackCount++, state);
    offset = bodyStart + len; // unknown chunk types skipped by their length
  }

  let toSeconds;
  if (division & 0x8000) {
    // SMPTE division: seconds come straight from frames; tempo events ignored.
    let fps = 0x100 - ((division >> 8) & 0xff); // abs of signed high byte
    if (fps === 29) fps = 29.97;
    const ticksPerFrame = (division & 0xff) || 1;
    const secondsPerTick = 1 / (fps * ticksPerFrame);
    toSeconds = (tick) => tick * secondsPerTick;
  } else {
    const segments = buildTempoMap(state.tempos, (division & 0x7fff) || 480);
    toSeconds = (tick) => tickToSeconds(segments, tick);
  }

  const notes = [];
  let durationSec = 0;
  for (const rn of state.rawNotes) {
    const time = toSeconds(rn.startTick);
    const duration = rn.open ? 0.25 : toSeconds(rn.endTick) - time;
    notes.push({
      midi: rn.midi, time, duration, velocity: rn.velocity,
      track: rn.track, channel: rn.channel, percussion: rn.channel === 9,
    });
    if (time + duration > durationSec) durationSec = time + duration;
  }
  notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
  return { name: state.name, durationSec, notes, trackCount };
}

export function midiToSong(parsed, { includePercussion = false } = {}) {
  const source = parsed.notes.filter(
    (n) => n.duration > 0 && (includePercussion || !n.percussion),
  );

  // Hand assignment: with >=2 note-bearing tracks, the track with the highest
  // average pitch is the right hand; otherwise split at middle C.
  const trackStats = new Map();
  for (const n of source) {
    let s = trackStats.get(n.track);
    if (!s) trackStats.set(n.track, s = { sum: 0, count: 0 });
    s.sum += n.midi;
    s.count++;
  }
  let rightTrack = null;
  if (trackStats.size >= 2) {
    let bestAvg = -Infinity;
    for (const [track, s] of trackStats) {
      const avg = s.sum / s.count;
      if (avg > bestAvg) { bestAvg = avg; rightTrack = track; }
    }
  }

  const notes = source
    .map((n) => ({
      midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity,
      hand: rightTrack === null ? (n.midi >= 60 ? 1 : 0) : (n.track === rightTrack ? 1 : 0),
    }))
    .sort((a, b) => a.time - b.time || a.midi - b.midi);

  let durationSec = 0;
  if (notes.length) {
    const shift = 0.5 - notes[0].time; // first note lands at exactly 0.5s
    for (const n of notes) {
      n.time += shift;
      if (n.time + n.duration > durationSec) durationSec = n.time + n.duration;
    }
  }

  return { title: parsed.name || 'Imported MIDI', notes, durationSec };
}
