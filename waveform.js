"use strict";

// The display spans eight seconds of source audio, centered on the transport position.
const WAVE_BINS_PER_SECOND = 160;
const WAVE_WINDOW = 8;

class ProgramWaveform {
  constructor(engine, canvas, colors) {
    this.engine = engine;
    this.canvas = canvas;
    this.colors = colors;
    this.context = canvas.getContext("2d");
    this.analysis = Promise.resolve();
    this.liveSamples = new Float32Array(2048);
  }

  select(track) {
    if (this.track === track) return;
    this.track = track;
    this.source = null;
    this.lastPosition = null;
    if (!track) return;
    const source = { peaks: null, history: new Map(), revision: 0 };
    this.source = source;
    // Rapid cue changes share one decoder. Skip superseded requests before reading any audio.
    source.decoded = this.analysis.then(async () => {
      if (this.source !== source || track.size > 100 * 1024 * 1024 || track.duration > 720) return null;
      const file = await this.engine.store.readAudio(track);
      if (!file || this.source !== source || file.size > 100 * 1024 * 1024) return null;
      const duration = track.duration || await probe(file);
      if (this.source !== source || duration > 720) return null;
      this.engine.initialize();
      const bytes = await file.arrayBuffer();
      if (this.source !== source) return null;
      return this.engine.context.decodeAudioData(bytes);
    }).catch(() => null);
    this.analysis = source.decoded.then(async buffer => {
      if (!buffer || this.source !== source) return;
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
      const peaks = new Float32Array(Math.ceil(buffer.duration * WAVE_BINS_PER_SECOND));
      const step = buffer.sampleRate / WAVE_BINS_PER_SECOND;
      for (let bin = 0; bin < peaks.length; bin++) {
        const end = Math.min(buffer.length, Math.floor((bin + 1) * step));
        let peak = 0;
        for (const channel of channels) {
          for (let i = Math.floor(bin * step); i < end; i++) peak = Math.max(peak, Math.abs(channel[i]));
        }
        peaks[bin] = peak;
        if (bin % 640 === 639) {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (this.source !== source) return;
        }
      }
      source.peaks = peaks;
      source.history.clear();
      source.revision++;
    }).catch(() => {});
  }

  capture(deck, position) {
    const source = this.source;
    if (!source || source.peaks || !deck || deck.audio.paused || deck.audio.seeking || position === source.lastSample) return;
    source.lastSample = position;
    deck.analysisNode.getFloatTimeDomainData(this.liveSamples);
    const secondsPerSample = deck.audio.playbackRate / this.engine.context.sampleRate;
    const samplesPerBin = Math.max(1, Math.round(1 / (secondsPerSample * WAVE_BINS_PER_SECOND)));
    for (let i = this.liveSamples.length; i > 0; i -= samplesPerBin) {
      const bin = Math.floor((position - (this.liveSamples.length - i) * secondsPerSample) * WAVE_BINS_PER_SECOND);
      if (bin < 0) break;
      let peak = source.history.get(bin) || 0;
      for (let j = Math.max(0, i - samplesPerBin); j < i; j++) peak = Math.max(peak, Math.abs(this.liveSamples[j]));
      source.history.set(bin, peak);
    }
    while (source.history.size > WAVE_WINDOW * WAVE_BINS_PER_SECOND * 2) {
      source.history.delete(source.history.keys().next().value);
    }
    source.revision++;
  }

  draw(deck, position) {
    this.capture(deck, position);
    const canvas = this.canvas;
    const ctx = this.context;
    const density = Math.min(2, window.devicePixelRatio || 1);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const pixelWidth = Math.round(width * density);
    const pixelHeight = Math.round(height * density);
    const resized = canvas.width !== pixelWidth || canvas.height !== pixelHeight;
    if (resized) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const source = this.source;
    if (!resized && this.lastPosition === position && this.lastRevision === source?.revision) return;
    this.lastPosition = position;
    this.lastRevision = source?.revision;
    ctx.setTransform(density, 0, 0, density, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const mid = height / 2;
    const center = width / 2;
    const start = position - WAVE_WINDOW / 2;
    const pixelsPerSecond = width / WAVE_WINDOW;
    ctx.fillStyle = "#202d2a";
    ctx.fillRect(0, mid, width, 1);
    for (let sec = Math.max(0, Math.ceil(start)); sec <= start + WAVE_WINDOW; sec++) {
      ctx.fillRect(Math.round((sec - start) * pixelsPerSecond), 0, 1, height);
    }
    if (!source) return;
    for (let x = 0; x < width; x += 2) {
      const begin = Math.floor((start + x / pixelsPerSecond) * WAVE_BINS_PER_SECOND);
      const end = Math.ceil((start + (x + 2) / pixelsPerSecond) * WAVE_BINS_PER_SECOND);
      let peak = 0;
      for (let i = Math.max(0, begin); i < end; i++) {
        peak = Math.max(peak, (source.peaks ? source.peaks[i] : source.history.get(i)) || 0);
      }
      if (!peak) continue;
      const amplitude = Math.min(1, Math.sqrt(peak)) * (mid - 6);
      ctx.fillStyle = this.colors[Number(x >= center)];
      ctx.fillRect(x, mid - amplitude, 2, Math.max(1, amplitude * 2));
    }
    ctx.fillStyle = "#f2f6ea";
    ctx.fillRect(Math.floor(center), 0, 1.5, height);
    ctx.beginPath();
    ctx.moveTo(center - 4, 0);
    ctx.lineTo(center + 4, 0);
    ctx.lineTo(center, 5);
    ctx.fill();
  }
}
