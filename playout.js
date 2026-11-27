"use strict";

const START_TIMEOUT = 8000;
const FADE_GUARD = 0.12;
const PROCESSOR_DEFAULTS = {
  enabled: false, highpass: 25, low: 0, mid: 0, high: 0, threshold: -18,
  ratio: 3, attack: 10, release: 200, makeup: 0
};

const PROCESSOR_PRESETS = {
  "Clean broadcast": { highpass: 35, threshold: -16, ratio: 2, attack: 18 },
  "FM music": { highpass: 40, low: 1, high: 1, threshold: -20, ratio: 2.5, attack: 12, release: 180 },
  "AM speech": { highpass: 105, low: -3, mid: 3, high: -2, threshold: -22, ratio: 3.5, attack: 6 },
  "Soft compression": { threshold: -22, ratio: 1.5, attack: 25, release: 280 },
  "Speech clarity": { highpass: 90, low: -2, mid: 2, high: 1, threshold: -21, ratio: 2.5 },
  "News and traffic": { highpass: 110, low: -3, mid: 2.5, threshold: -24, ratio: 3, attack: 6, release: 150 },
  "Talk and interviews": { highpass: 75, low: -1.5, mid: 1.5, threshold: -23, ratio: 3, release: 260 },
  "Station IDs and promos": { highpass: 60, low: -1, mid: 1.5, high: 1, threshold: -19, ratio: 3.5, attack: 5, release: 130 },
  "Acoustic and folk": { highpass: 40, low: -0.5, mid: 1, high: 1.5, threshold: -18, ratio: 1.6, attack: 24, release: 260 },
  "Classical": { highpass: 28, threshold: -12, ratio: 1.3, attack: 40, release: 400 },
  "Jazz": { highpass: 32, low: 0.5, high: 0.5, threshold: -16, ratio: 1.5, attack: 32, release: 300 },
  "Adult contemporary": { highpass: 38, low: 0.5, mid: 0.5, high: 0.5, threshold: -19, ratio: 2.2, attack: 16, release: 240 },
  "Pop": { highpass: 42, low: 1, mid: 0.5, high: 1.5, threshold: -18, ratio: 2.5, attack: 12, release: 160 },
  "Rock": { highpass: 45, low: 0.5, mid: 1.5, threshold: -17, ratio: 2.4, attack: 17, release: 170 },
  "Dance and electronic": { highpass: 30, low: 1.5, high: 1, threshold: -19, ratio: 2.8, attack: 20, release: 120 },
  "Hip-hop and R&B": { highpass: 30, low: 1.5, mid: -0.5, high: 0.5, threshold: -18, ratio: 2.3, attack: 25, release: 190 },
  "Warm music": { highpass: 35, low: 1, high: -1.5, threshold: -19, ratio: 1.8, attack: 22, release: 270 },
  "Brighten dull recordings": { highpass: 50, low: -0.5, mid: 0.5, high: 2.5, threshold: -16, ratio: 1.8, attack: 16 },
  "Tame harsh recordings": { highpass: 40, mid: -1, high: -2.5, threshold: -18, ratio: 2, attack: 14 },
  "Reduce rumble": { highpass: 125, low: -3, threshold: -18, ratio: 1.7, attack: 20, release: 240 },
};

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class Deck {
  constructor(engine, name) {
    this.name = name;
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.addEventListener("ended", () => {
      if (this.audio.ended) engine.ended(this);
    });
    this.audio.addEventListener("error", () => {
      if (this.audio.error) engine.failed(this);
    });
    this.gain = engine.context.createGain();
    this.gain.gain.value = 0;
    this.trim = engine.context.createGain();
    this.trimDb = 0;
    const source = engine.context.createMediaElementSource(this.audio);
    this.analysisNode = engine.context.createAnalyser();
    this.analysisNode.fftSize = 2048;
    source.connect(this.analysisNode);
    this.mediaGate = engine.context.createGain();
    source.connect(this.mediaGate).connect(this.trim).connect(this.gain);
    this.gain.connect(engine.mix);
    this.entry = null;
    this.url = null;
  }

  load(entry, store) {
    this.clear();
    this.entry = entry;
    this.ready = store.readAudio(entry.track).then(blob => {
      if (this.entry !== entry) return;
      if (!blob) throw new Error("The stored audio file could not be found.");
      this.url = URL.createObjectURL(blob);
      this.audio.src = this.url;
    });
    this.ready.catch(() => {});
  }

  clear() {
    this.entry = null;
    this.audio.pause();
    this.mediaGate.gain.cancelScheduledValues(0);
    this.mediaGate.gain.value = 1;
    this.audio.removeAttribute("src");
    this.audio.load();
    this.audio.playbackRate = 1;
    this.trimDb = 0;
    this.trim.gain.value = 1;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}

class Playout {
  constructor(store, callbacks) {
    this.store = store;
    this.callbacks = callbacks;
    this.current = null;
    this.outgoing = null;
    this.pending = null;
    this.armed = false;
    this.lastDeck = "B";
    this.programName = "A";
    this.cues = new Map();
  }

  initialize() {
    if (this.context) return;
    const AudioGraph = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioGraph();
    this.mix = this.context.createGain();
    this.stereo = this.context.createGain();
    this.mono = this.context.createGain();
    this.mono.channelCount = 1;
    this.mono.channelCountMode = "explicit";
    this.master = this.context.createGain();
    this.master.channelCount = 2;
    this.master.channelCountMode = "explicit";
    const input = this.context.createGain();
    input.channelCount = 2;
    input.channelCountMode = "explicit";
    this.mix.connect(this.stereo).connect(input);
    this.mix.connect(this.mono).connect(input);
    this.buildProcessor(input);
    const split = this.context.createChannelSplitter(2);
    this.meters = [0, 1].map(channel => {
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 512;
      split.connect(analyser, channel);
      return { analyser, samples: new Float32Array(analyser.fftSize) };
    });
    this.safetyReady = this.buildSafety(split);
    this.decks = [new Deck(this, "A"), new Deck(this, "B")];
    this.configure();
  }

  async buildSafety(split) {
    let limiter;
    try {
      const [, wasm] = await Promise.all([
        this.context.audioWorklet.addModule("limiter.js"),
        fetch("pilot_dsp.wasm").then(response => response.ok ? response.arrayBuffer() : null).catch(() => null)
      ]);
      this.dspWasm = wasm;
      this.scratchAvailable = true;
      limiter = new AudioWorkletNode(this.context, "station-pilot-limiter", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit",
        processorOptions: { wasm }
      });
      limiter.port.onmessage = event => {
        if (typeof event.data === "boolean") this.limiting = event.data;
        else this.limiterBackend = event.data.backend;
      };
    } catch {
      limiter = this.context.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0;
      limiter.release.value = 0.1;
    }
    this.master.connect(limiter);
    limiter.connect(this.context.destination);
    limiter.connect(split);
  }

  buildProcessor(input) {
    const filter = (type, frequency) => {
      const node = this.context.createBiquadFilter();
      node.type = type;
      node.frequency.value = frequency;
      return node;
    };
    this.highpass = filter("highpass", 25);
    this.highpass.Q.value = Math.SQRT1_2;
    this.low = filter("lowshelf", 120);
    this.mid = filter("peaking", 1800);
    this.mid.Q.value = 0.85;
    this.high = filter("highshelf", 6500);
    this.compressor = this.context.createDynamicsCompressor();
    this.compressor.knee.value = 12;
    this.wet = this.context.createGain();
    this.wet.gain.value = 0;
    this.dry = this.context.createGain();
    input.connect(this.dry).connect(this.master);
    input.connect(this.highpass).connect(this.low).connect(this.mid).connect(this.high)
      .connect(this.compressor).connect(this.wet).connect(this.master);
  }

  configure() {
    if (!this.context) return;
    const settings = this.callbacks.settings();
    this.stereo.gain.value = settings.output === "mono" ? 0 : 1;
    this.mono.gain.value = settings.output === "mono" ? 1 : 0;
    this.master.gain.value = settings.gain / 100;
    const fx = settings.processor;
    this.highpass.frequency.value = fx.highpass;
    for (const band of ["low", "mid", "high"]) this[band].gain.value = fx[band];
    this.compressor.threshold.value = fx.threshold;
    this.compressor.ratio.value = fx.ratio;
    this.compressor.attack.value = fx.attack / 1000;
    this.compressor.release.value = fx.release / 1000;
    this.dry.gain.setTargetAtTime(fx.enabled ? 0 : 1, this.context.currentTime, 0.01);
    this.wet.gain.setTargetAtTime(fx.enabled ? Math.pow(10, fx.makeup / 20) : 0, this.context.currentTime, 0.01);
    for (const deck of [this.current, this.secondary, this.outgoing]) if (deck) this.setKeyLock(deck);
  }

  async routeOutput(id) {
    if (!this.context && !id) return;
    this.initialize();
    if (typeof this.context.setSinkId !== "function") {
      if (id) throw new Error("This browser cannot select an audio output.");
      return;
    }
    if (this.context.sinkId !== id) await this.context.setSinkId(id);
  }

  setKeyLock(deck) {
    const lock = this.callbacks.settings().keyLock;
    deck.audio.preservesPitch = lock;
    if ("webkitPreservesPitch" in deck.audio) deck.audio.webkitPreservesPitch = lock;
  }

  pitch(percent) {
    if (this.current) this.current.audio.playbackRate = 1 + percent / 100;
  }

  trim(decibels) {
    if (!this.current || !Number.isFinite(decibels)) return;
    const amount = Math.min(6, Math.max(-24, decibels));
    this.current.trimDb = amount;
    this.current.trim.gain.setTargetAtTime(Math.pow(10, amount / 20), this.context.currentTime, 0.01);
  }

  deckName(role) {
    return role === "program" ? this.programName : this.programName === "A" ? "B" : "A";
  }

  deck(name) {
    return this.decks?.find(deck => deck.name === name);
  }

  loaded(name) {
    const deck = this.deck(name);
    return deck && [this.current, this.secondary, this.outgoing].includes(deck) ? deck : null;
  }

  transportEvent(deck, event, detail = "") {
    if (deck?.entry) this.callbacks.record(deck.entry, event, detail, deck, this.position(deck));
  }

  position(deck) {
    return this.scratch?.node && this.scratch.deck === deck ? this.scratch.position : deck.audio.currentTime;
  }

  cue(name, entry) {
    if (this.loaded(name)) this.stopDeck(name, "Replaced");
    if (this.starting?.name === name) this.starting = null;
    if (this.pending?.deck.name === name) {
      this.pending.deck.clear();
      this.pending = null;
    }
    const replaced = this.cues.get(name);
    if (replaced) this.callbacks.record(replaced, "Cue replaced", "", { name }, 0);
    this.cues.set(name, entry);
    this.callbacks.record(entry, "Cued", "", { name }, 0);
    this.prepare();
    this.callbacks.changed();
  }

  availableDeck() {
    return this.decks?.find(deck => deck.name !== this.lastDeck);
  }

  protect(id) {
    return Array.from(this.cues.values()).some(entry => entry.track.id === id) || this.pending && this.pending.entry.track.id === id
      || this.current && this.current.entry.track.id === id
      || this.outgoing?.entry.track.id === id || this.secondary?.entry.track.id === id;
  }

  prepare() {
    if (!this.decks || this.pending) return;
    for (const deck of this.decks) {
      if (this.loaded(deck.name)) continue;
      const head = this.callbacks.peek(false);
      const entry = this.cues.get(deck.name) || (deck === this.availableDeck() && !head?.stop ? head : null);
      if (entry?.id === deck.entry?.id) continue;
      if (entry) deck.load(entry, this.store);
      else deck.clear();
    }
  }

  async toggle(name) {
    if (this.pending || this.starting) return;
    const deck = name ? this.loaded(name) : this.current;
    if (!deck) {
      if (name && !this.cues.has(name) && (this.current || name !== (this.availableDeck()?.name || "A"))) return;
      return this.take(true, name || (this.cues.has(this.programName) ? this.programName : undefined), Boolean(name && this.current));
    }
    if (this.scratch?.deck === deck) {
      this.endScratch(false);
      this.transportEvent(deck, "Paused");
      return;
    }
    if (deck === this.outgoing) {
      this.outgoing = null;
      this.secondary = deck;
      this.setGain(deck, 1);
      this.setGain(this.current, 1);
    }
    if (deck.audio.paused) {
      try {
        await this.context.resume();
        if (this.loaded(deck.name) === deck) {
          await deck.audio.play();
          this.transportEvent(deck, "Resumed");
        }
      } catch (error) {
        if (this.loaded(deck.name) === deck && error.name !== "AbortError") this.callbacks.report(error.message, true);
      }
    } else {
      deck.audio.pause();
      this.transportEvent(deck, "Paused");
      if (deck === this.current) this.finishMix();
      this.prepare();
    }
    this.callbacks.changed();
  }

  reachStop(entry, name) {
    this.stop();
    this.callbacks.consume(entry);
    this.callbacks.record(entry, "Stop and recue reached", "Automation stopped");
    const next = this.callbacks.peek(false);
    const target = [name, name === "A" ? "B" : "A"].find(deck => !this.cues.has(deck));
    if (next && !next.stop && target) this.cue(target, next);
    this.callbacks.report("Stop and recue reached. Press Play to continue.");
    this.prepare();
    this.callbacks.changed();
  }

  async take(manual, deckName, independent = false) {
    if (this.pending || this.starting || (!manual && !this.armed)) return;
    const standby = this.deckName("standby");
    const head = this.callbacks.peek(false);
    if (!deckName && head?.stop) return this.reachStop(head, this.programName);
    const reserved = [...this.cues].find(([, cue]) => cue.id === head?.id)?.[0];
    const name = deckName || (!this.current && reserved ? reserved
      : this.current || this.cues.size ? standby : this.lastDeck === "A" ? "B" : "A");
    if (reserved && reserved !== name && !this.cues.has(name)) return;
    if (this.secondary?.name === name || this.current?.name === name) return;
    const cue = this.cues.get(name);
    const nextEntry = allowRotation => cue || this.callbacks.peek(allowRotation);
    const next = nextEntry(true);
    if (!next || (!manual && this.cues.size && !next.stop)) return;
    if (next.stop) return this.reachStop(next, this.programName);
    const starting = { name };
    this.starting = starting;
    this.callbacks.changed();
    if (!independent) this.endScratch(false);
    this.armed = true;
    try {
      this.initialize();
      const wake = manual ? this.context.resume() : Promise.resolve();
      await this.routeOutput(this.callbacks.settings().sinkId);
      await Promise.all([withTimeout(wake, 2500, "Press Play to start audio playback."), this.safetyReady]);
    } catch (error) {
      if (this.starting !== starting) return;
      this.starting = null;
      this.armed = false;
      this.callbacks.report(error.name === "NotFoundError"
        ? "The selected audio output is unavailable. Choose another device in Output settings."
        : error.message, true);
      this.callbacks.changed();
      return;
    }
    if (this.starting !== starting) return;
    this.starting = null;
    if (this.pending || !this.armed) return;

    this.finishMix();
    let allowRotation = true;
    while (this.armed) {
      const entry = nextEntry(allowRotation);
      if (!entry) break;
      if (entry.stop) { this.reachStop(entry, this.programName); return; }
      if (entry.source === "Rotation") allowRotation = false;
      const deck = this.decks.find(candidate => candidate.name === name);
      // A prepared linked file may have changed permissions or drives since preloading.
      if (entry.track.source || !deck.entry || deck.entry.id !== entry.id) deck.load(entry, this.store);
      const pending = { deck, entry };
      this.pending = pending;
      this.setGain(deck, 0);
      this.setKeyLock(deck);
      this.callbacks.changed();

      try {
        await withTimeout(deck.ready.then(() => {
          if (this.pending !== pending) return;
          return deck.audio.play();
        }), START_TIMEOUT, "Audio did not start within eight seconds.");
      } catch (error) {
        if (this.pending !== pending) return;
        this.pending = null;
        deck.clear();
        if (error.name === "SourceAccessError") {
          this.callbacks.record(entry, "Source unavailable", error.message, deck);
          this.armed = false;
          this.callbacks.reconnect(entry.track);
          break;
        }
        if (error.name === "NotAllowedError") {
          this.callbacks.record(entry, "Playback blocked", error.message, deck);
          this.armed = false;
          this.callbacks.report("The browser blocked playback. Press Play or Take next to retry.", true);
          break;
        }
        this.callbacks.consume(entry);
        this.callbacks.record(entry, "Failed", error.message, deck);
        this.callbacks.report("Could not play " + entry.track.title + ". " + error.message, true);
        if (cue) { this.cues.delete(name); break; }
        continue;
      }

      if (this.pending !== pending) return;
      this.pending = null;
      const previous = this.current;
      if (independent && previous) {
        this.secondary = deck;
      } else {
        this.current = deck;
        this.programName = deck.name;
        this.lastDeck = deck.name;
      }
      this.cues.delete(deck.name);
      if (Number.isFinite(deck.audio.duration) && deck.audio.duration > 0 && entry.track.duration !== deck.audio.duration)
        this.callbacks.duration(entry.track, deck.audio.duration);
      const remaining = previous ? (previous.audio.duration - previous.audio.currentTime) / previous.audio.playbackRate : 0;
      const duration = Math.min(this.callbacks.settings().fade, remaining, deck.audio.duration / 2);
      if (independent && previous) {
        this.setGain(deck, 1);
      } else if (previous && !previous.audio.paused && duration > FADE_GUARD) {
        this.outgoing = previous;
        this.fadeStart = this.context.currentTime;
        this.fadeDuration = duration;
        this.transportEvent(previous, "Fading out");
      } else {
        if (previous) this.releaseDeck(previous, previous.audio.ended ? "Completed" : "Transitioned out");
        this.setGain(deck, 1);
      }
      this.callbacks.consume(entry);
      this.callbacks.record(entry, "Started", independent && previous ? "Simultaneous playback" : "", deck, 0);
      this.callbacks.report("Playing " + entry.track.title + ".");
      this.prepare();
      this.callbacks.changed();
      this.prepareScratchClip(deck).catch(() => {});
      return;
    }
    if (this.current?.audio.ended) this.stopDeck(this.current.name, "Completed", false);
    this.prepare();
    this.callbacks.changed();
  }

  releaseDeck(deck, event, detail) {
    if (this.scratch?.deck === deck) this.endScratch(false);
    this.transportEvent(deck, event, detail);
    this.discardScratchClip(deck);
    deck.clear();
  }

  finishMix(event = "Transitioned out") {
    if (!this.outgoing) return;
    const deck = this.outgoing;
    this.outgoing = null;
    this.releaseDeck(deck, event);
    if (this.current) this.setGain(this.current, 1);
  }

  setGain(deck, volume) {
    deck.gain.gain.setTargetAtTime(volume, this.context.currentTime, 0.005);
  }

  clearCue(name) {
    const cue = this.cues.get(name);
    if (!cue) return;
    this.cues.delete(name);
    this.callbacks.record(cue, "Cue cleared", "", { name }, 0);
    this.prepare();
    this.callbacks.changed();
  }

  stopDeck(name, event = "Stopped", advance = false, detail) {
    const deck = this.loaded(name);
    if (!deck) return this.clearCue(name);
    if (deck === this.outgoing) {
      this.finishMix(event);
    } else {
      this.releaseDeck(deck, event, detail);
      if (deck === this.secondary) {
        this.secondary = null;
      } else {
        this.finishMix(event === "Completed" ? "Transitioned out" : event);
        this.current = this.secondary || null;
        this.secondary = null;
        if (this.current) {
          this.programName = this.lastDeck = this.current.name;
        } else {
          if (!advance) this.armed = false;
          if (advance && this.callbacks.settings().auto) this.take(false);
        }
      }
    }
    this.prepare();
    this.callbacks.changed();
  }

  stop() {
    this.armed = false;
    this.starting = null;
    if (this.pending) {
      this.pending.deck.clear();
      this.pending = null;
    }
    this.finishMix("Stopped");
    if (this.current) this.releaseDeck(this.current, "Stopped");
    if (this.secondary) this.releaseDeck(this.secondary, "Stopped");
    this.current = this.secondary = null;
    this.prepare();
    this.callbacks.changed();
  }

  ended(deck) {
    if (!this.loaded(deck.name)) return;
    if (deck === this.current && !this.pending && !this.starting && this.armed
        && this.callbacks.settings().auto && this.callbacks.peek(false)?.stop) {
      this.transportEvent(deck, "Completed");
      this.discardScratchClip(deck);
      deck.clear();
      this.current = null;
      this.reachStop(this.callbacks.peek(false), deck.name);
      return;
    }
    this.stopDeck(deck.name, "Completed", true);
  }

  failed(deck) {
    if (!this.loaded(deck.name)) return;
    const message = deck.audio.error?.message || "The audio decoder stopped playback.";
    this.callbacks.report("Playback failed for " + deck.entry.track.title + ". " + message, true);
    this.stopDeck(deck.name, "Failed", true, message);
  }

  seek(position, name = this.programName) {
    const deck = this.loaded(name);
    if (!deck || !Number.isFinite(deck.audio.duration)) return;
    if (this.scratch?.deck === deck) this.endScratch(true);
    deck.audio.currentTime = position;
    this.transportEvent(deck, "Seeked");
  }

  discardScratchClip(deck) {
    const clip = deck.scratchClip;
    deck.scratchClip = null;
    if (!clip?.node) return;
    clip.node.port.postMessage({ stop: true });
    setTimeout(() => { clip.node.disconnect(); clip.node.port.close(); }, 25);
  }

  prepareScratchClip(deck) {
    const entry = deck.entry;
    const position = deck.audio.currentTime;
    const cached = deck.scratchClip;
    if (cached?.entry === entry && (cached.loading ||
        (position >= cached.first + (cached.first ? 2 : 0) && position <= cached.last - (cached.atEnd ? 0 : 2)))) {
      return cached.ready;
    }
    this.discardScratchClip(deck);
    const decoded = this.waveforms[deck.name].source?.decoded;
    if (!this.scratchAvailable || !decoded) return Promise.resolve(null);
    const clip = { entry, loading: true };
    deck.scratchClip = clip;
    clip.ready = decoded.then(buffer => {
      if (!buffer || this.loaded(deck.name) !== deck || deck.entry !== entry || deck.scratchClip !== clip) return null;
      const now = deck.audio.currentTime;
      const first = Math.max(0, Math.floor((now - 12) * buffer.sampleRate));
      const last = Math.min(buffer.length, Math.ceil((now + 12) * buffer.sampleRate));
      clip.first = first / buffer.sampleRate;
      clip.last = (last - 1) / buffer.sampleRate;
      clip.atEnd = last === buffer.length;
      const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) =>
        buffer.getChannelData(c).slice(first, last));
      const node = new AudioWorkletNode(this.context, "station-pilot-scratch", {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { wasm: this.dspWasm }
      });
      clip.node = node;
      node.connect(deck.trim);
      node.port.postMessage({ audio: channels }, channels.map(c => c.buffer));
      return clip;
    }).finally(() => { clip.loading = false; });
    return clip.ready;
  }

  async beginScratch(name = this.programName) {
    const deck = this.loaded(name);
    if (!deck || deck === this.outgoing || this.pending || this.scratch) return;
    const gesture = { deck, offset: 0, position: deck.audio.currentTime, node: null };
    this.scratch = gesture;
    const [clip] = await Promise.all([this.prepareScratchClip(deck), this.context.resume()]);
    if (this.scratch !== gesture || this.loaded(name) !== deck) return;
    if (!clip) {
      this.endScratch(false);
      this.callbacks.report("Scratching needs a decodable track up to 12 minutes and 100 MB.", true);
      return;
    }
    if (deck === this.outgoing) return this.endScratch(false);
    if (deck === this.current) this.finishMix();
    gesture.wasPlaying = !deck.audio.paused;
    gesture.start = gesture.position = deck.audio.currentTime;
    gesture.first = clip.first;
    gesture.last = clip.last;
    gesture.node = clip.node;
    const now = this.context.currentTime;
    const gate = deck.mediaGate.gain;
    gate.cancelScheduledValues(now);
    gate.setTargetAtTime(0, now, 0.0015);
    setTimeout(() => { if (this.scratch === gesture) deck.audio.pause(); }, 8);
    clip.node.port.postMessage({ start: (gesture.start - clip.first) * this.context.sampleRate, time: now });
    this.moveScratch(gesture.offset);
    this.transportEvent(deck, "Scratch started");
    this.callbacks.changed();
  }

  moveScratch(offset, eventTime = performance.now()) {
    const gesture = this.scratch;
    if (!gesture) return;
    gesture.offset = offset;
    if (!gesture.node) return;
    gesture.position = Math.min(gesture.last, Math.max(gesture.first, gesture.start + offset));
    const time = this.context.currentTime - Math.max(0, Math.min(0.08, (performance.now() - eventTime) / 1000));
    gesture.node.port.postMessage({ target: (gesture.position - gesture.first) * this.context.sampleRate, time });
  }

  endScratch(resume = true) {
    const gesture = this.scratch;
    this.scratch = null;
    if (!gesture?.node) return;
    gesture.node.port.postMessage({ stop: true });
    if (this.loaded(gesture.deck.name) === gesture.deck) {
      const deck = gesture.deck;
      deck.audio.pause();
      deck.audio.currentTime = gesture.position;
      const now = this.context.currentTime;
      deck.mediaGate.gain.cancelScheduledValues(now);
      deck.mediaGate.gain.setValueAtTime(0, now);
      deck.mediaGate.gain.linearRampToValueAtTime(1, now + 0.009);
      this.transportEvent(deck, "Scratch ended");
      if (resume && gesture.wasPlaying) deck.audio.play().catch(error => {
        if (this.loaded(deck.name) === deck && error.name !== "AbortError") this.callbacks.report(error.message, true);
      });
    }
    this.callbacks.changed();
  }

  tick() {
    if (!this.current || this.current.audio.paused) return;
    const audio = this.current.audio;
    if (this.outgoing) {
      const fraction = Math.min(1, Math.max(0, (this.context.currentTime - this.fadeStart) / this.fadeDuration));
      this.setGain(this.outgoing, 1 - fraction);
      this.setGain(this.current, fraction);
      if (fraction >= 1) {
        this.finishMix();
        this.prepare();
      }
    }
    const settings = this.callbacks.settings();
    const overlap = Math.min(settings.fade, audio.duration / (2 * audio.playbackRate));
    const next = this.callbacks.peek(false);
    if (settings.auto && !this.pending && !this.outgoing && !this.secondary && overlap >= FADE_GUARD
        && (audio.duration - audio.currentTime) / audio.playbackRate <= overlap
        && (next ? !next.stop && next.source !== "Scheduled" : this.callbacks.peek(true))) {
      if (this.autoAttempt !== this.current.entry.id) {
        this.autoAttempt = this.current.entry.id;
        this.take(false);
      }
    }
  }

  levels() {
    if (!this.meters) return [];
    return this.meters.map(meter => {
      meter.analyser.getFloatTimeDomainData(meter.samples);
      let peak = 0;
      for (const sample of meter.samples) peak = Math.max(peak, Math.abs(sample));
      return { db: 20 * Math.log10(peak), samples: meter.samples };
    });
  }
}
