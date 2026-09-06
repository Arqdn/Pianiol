// midi-input.js — play along on a real MIDI keyboard (Web MIDI API; Chrome, Edge, Android Chrome).

export function midiInputSupported() {
  return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
}

// Resolves { devices, disconnect() }. Throws if the browser refuses access.
export async function connectMidiInput({ onNoteOn, onNoteOff, onDevices } = {}) {
  const access = await navigator.requestMIDIAccess({ sysex: false });
  const handle = e => {
    const d = e.data;
    if (!d || d.length < 3) return;
    const status = d[0] & 0xf0;
    const note = d[1];
    const vel = d[2];
    if (status === 0x90 && vel > 0) onNoteOn && onNoteOn(note, vel / 127);
    else if (status === 0x80 || (status === 0x90 && vel === 0)) onNoteOff && onNoteOff(note);
  };
  const attach = () => {
    const names = [];
    for (const input of access.inputs.values()) {
      input.onmidimessage = handle;
      names.push(input.name || 'MIDI device');
    }
    onDevices && onDevices(names);
    return names;
  };
  const devices = attach();
  access.onstatechange = () => attach();
  return {
    devices,
    disconnect() {
      access.onstatechange = null;
      for (const input of access.inputs.values()) input.onmidimessage = null;
    },
  };
}
