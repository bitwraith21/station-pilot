function rustDsp(options) {
  try {
    if (!options?.processorOptions?.wasm) return null;
    const module = new WebAssembly.Module(options.processorOptions.wasm);
    const dsp = new WebAssembly.Instance(module).exports;
    dsp.init(sampleRate);
    return dsp;
  } catch { return null; }
}

class ProgramPeakLimiter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.dsp = rustDsp(options);
    this.port.postMessage({ backend: this.dsp ? "rust" : "javascript" });
    this.delay = [new Float32Array(Math.ceil(sampleRate * 0.005)), new Float32Array(Math.ceil(sampleRate * 0.005))];
    this.index = 0;
    this.gain = 1;
    this.ceiling = Math.pow(10, -3 / 20);
    this.release = Math.exp(-1 / (sampleRate * 0.09));
    this.frames = 0;
  }

  process(inputs, outputs) {
    const source = inputs[0];
    const [left, right] = outputs[0];
    if (this.dsp) {
      const frames = left.length;
      const pointer = this.dsp.audio_io(frames);
      const inputLeft = new Float32Array(this.dsp.memory.buffer, pointer, frames);
      const inputRight = new Float32Array(this.dsp.memory.buffer, pointer + frames * 4, frames);
      if (source[0]) inputLeft.set(source[0]); else inputLeft.fill(0);
      if (source[1]) inputRight.set(source[1]); else inputRight.set(inputLeft);
      const limiting = Boolean(this.dsp.render_limiter(frames));
      left.set(inputLeft);
      right.set(inputRight);
      this.notify(frames, limiting);
      return true;
    }
    const [delayLeft, delayRight] = this.delay;
    for (let sample = 0; sample < left.length; sample++) {
      const nextLeft = source[0]?.[sample] || 0;
      const nextRight = source[1]?.[sample] ?? nextLeft;
      const pendingLeft = delayLeft[this.index];
      const pendingRight = delayRight[this.index];
      const peak = Math.max(Math.abs(nextLeft), Math.abs(nextRight), Math.abs(pendingLeft), Math.abs(pendingRight));
      const limit = peak > this.ceiling ? this.ceiling / peak : 1;
      this.gain = Math.min(limit, 1 - (1 - this.gain) * this.release);
      left[sample] = pendingLeft * this.gain;
      right[sample] = pendingRight * this.gain;
      delayLeft[this.index] = nextLeft;
      delayRight[this.index] = nextRight;
      this.index = (this.index + 1) % delayLeft.length;
    }
    this.notify(left.length, this.gain < 0.985);
    return true;
  }

  notify(frames, limiting) {
    this.frames += frames;
    if (this.frames >= sampleRate / 12) {
      this.frames = 0;
      this.port.postMessage(limiting);
    }
  }
}
registerProcessor("station-pilot-limiter", ProgramPeakLimiter);

class PlatterScratch extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.dsp = rustDsp(options);
    this.points = [];
    this.envelope = 0;
    this.smoothing = 1 - Math.exp(-1 / (sampleRate * 0.002));
    this.stopped = true;
    this.port.onmessage = ({ data }) => {
      if (data.audio) {
        const length = data.audio[0].length;
        if (this.dsp) {
          this.dsp.scratch_load(length, 0);
          for (let c = 0; c < 2; c++) {
            new Float32Array(this.dsp.memory.buffer, this.dsp.scratch_channel(c), length).set(data.audio[c] || data.audio[0]);
          }
        } else this.audio = data.audio;
      }
      if (Number.isFinite(data.start)) {
        this.points = [{ at: data.time, position: data.start }];
        this.position = data.start;
        this.speed = this.envelope = 0;
        this.stopped = false;
        this.dsp?.scratch_start(data.start);
      }
      if (!this.stopped && Number.isFinite(data.target)) {
        const last = this.points[this.points.length - 1];
        if (data.time > last.at) this.points.push({ at: data.time, position: data.target });
        else if (data.time === last.at) last.position = data.target;
      }
      if (data.stop) {
        this.stopped = true;
        this.dsp?.scratch_stop();
        this.tail = Math.ceil(sampleRate * 0.021);
      }
    };
  }

  // A short input buffer bridges the time between mouse reports, including reversals.
  targetAt(time) {
    while (this.points.length > 1 && this.points[1].at <= time) this.points.shift();
    const [a, b] = this.points;
    if (!b || time <= a.at) return a.position;
    return a.position + (b.position - a.position) * (time - a.at) / (b.at - a.at);
  }

  process(_, outputs) {
    if (this.stopped && !(this.tail > 0)) return true;
    const [left, right] = outputs[0];
    const frames = left.length;
    const target = this.stopped ? 0 : this.targetAt(currentTime + frames / sampleRate - 0.025);
    if (this.stopped) this.tail -= frames;
    if (this.dsp) {
      if (!this.stopped) this.dsp.scratch_target(target);
      const pointer = this.dsp.audio_io(frames);
      this.dsp.render_scratch(frames);
      left.set(new Float32Array(this.dsp.memory.buffer, pointer, frames));
      right.set(new Float32Array(this.dsp.memory.buffer, pointer + frames * 4, frames));
      return true;
    }
    if (!this.audio) return true;
    const last = this.audio[0].length - 1;
    const desired = this.stopped ? 0 : Math.max(-12, Math.min(12, (target - this.position) / frames));
    for (let i = 0; i < frames; i++) {
      this.speed += (desired - this.speed) * this.smoothing;
      const old = this.position;
      this.position = Math.max(0, Math.min(last, old + this.speed));
      const gain = this.stopped ? 0 : Math.min(1, Math.abs(this.speed) * 16);
      this.envelope += (gain - this.envelope) * this.smoothing;
      const taps = Math.max(1, Math.ceil(Math.abs(this.speed)));
      for (let c = 0; c < 2; c++) {
        const audio = this.audio[c] || this.audio[0];
        let sum = 0;
        for (let tap = 1; tap <= taps; tap++) {
          const p = old + (this.position - old) * tap / taps;
          const n = Math.floor(p), t = p - n;
          const a = audio[Math.max(0, n-1)], b = audio[n], next = audio[Math.min(last, n+1)], d = audio[Math.min(last, n+2)];
          sum += b + 0.5*t*(next-a + t*(2*a-5*b+4*next-d + t*(3*(b-next)+d-a)));
        }
        outputs[0][c][i] = sum / taps * this.envelope;
      }
    }
    return true;
  }
}
registerProcessor("station-pilot-scratch", PlatterScratch);
