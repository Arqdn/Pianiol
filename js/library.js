// Pianiol song library.
// Song format: { id, title, artist, aliases, bpm, beatsPerBar,
//   notes: [[startBeat, durationBeats, pitch, hand], ...] }
// pitch is scientific notation with sharps only (e.g. "F#4"); hand 1 = melody, 0 = accompaniment.

import { SONGS_DATA } from './songs-data.js';

export const SONGS = SONGS_DATA;

const NOTE_RE = /^([A-G])(#?)(-?\d)$/;
const SEMIS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function pitchToMidi(p) {
  const m = NOTE_RE.exec(String(p).trim());
  if (!m) return null;
  const midi = (parseInt(m[3], 10) + 1) * 12 + SEMIS[m[1]] + (m[2] ? 1 : 0);
  return midi >= 0 && midi <= 127 ? midi : null;
}

export function midiToName(midi) {
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

// Convert a library song into the runtime format the engine consumes.
export function songToNotes(song) {
  const spb = 60 / (song.bpm || 100);
  const notes = [];
  for (const n of song.notes) {
    const [start, dur, pitch, hand] = n;
    const midi = pitchToMidi(pitch);
    if (midi == null || !(dur > 0)) continue;
    notes.push({
      midi,
      time: start * spb + 0.5,
      duration: Math.max(0.08, dur * spb * 0.92),
      velocity: hand === 0 ? 0.55 : 0.85,
      hand: hand === 0 ? 0 : 1,
    });
  }
  notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
  const durationSec = notes.length
    ? Math.max(...notes.map(n => n.time + n.duration))
    : 0;
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    bpm: song.bpm,
    notes,
    durationSec,
  };
}

export function getSongById(id) {
  return SONGS.find(s => s.id === id) || null;
}
