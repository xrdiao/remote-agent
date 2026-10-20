// Area-average resampling carries fractional samples across render quanta (44.1/48 kHz -> 16 kHz).
class VoicePCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.remaining = this.ratio;
    this.sum = 0;
    this.frame = new Int16Array(1600);
    this.offset = 0;
    this.finished = false;
    this.port.onmessage = () => {
      this.finished = true;
      if (this.offset) this.port.postMessage(this.frame.slice(0, this.offset).buffer);
      this.port.postMessage('flushed');
    };
  }
  process(inputs) {
    if (this.finished) return false;
    const input = inputs[0][0];
    if (!input) return true;
    for (const sample of input) {
      let weight = 1;
      while (weight > 1e-8) {
        const take = Math.min(weight, this.remaining);
        this.sum += sample * take;
        this.remaining -= take; weight -= take;
        if (this.remaining < 1e-8) {
          const value = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.frame[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767));
          this.remaining = this.ratio; this.sum = 0;
          if (this.offset === this.frame.length) {
            this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
            this.frame = new Int16Array(1600); this.offset = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('voice-pcm', VoicePCM);
