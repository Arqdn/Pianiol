// pcm-worklet.js — AudioWorklet that forwards raw mono PCM blocks to the main thread.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(4096);
    this._n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this._buf[this._n++] = ch[i];
        if (this._n === this._buf.length) {
          this.port.postMessage(this._buf.slice(0));
          this._n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
