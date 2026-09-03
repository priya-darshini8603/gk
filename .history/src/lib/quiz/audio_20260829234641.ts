import {
  LANGUAGE_LOCALES,
  VOICE_TUNING,
  type AudioSettings,
  type Language,
} from "./types";
import type { Cue } from "./timeline";

/* Web Audio SFX + music bed, plus speech synthesis narration. */

export type SfxName = NonNullable<Cue["sfx"]>;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private voiceGain: GainNode | null = null;

  private musicTimer: number | null = null;
  private musicStep = 0;

  dest: MediaStreamAudioDestinationNode | null = null;

  // Tab-audio capture for SpeechSynthesis narration.
  private captureStream: MediaStream | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureAttempted = false;
  private captureReady: Promise<boolean> | null = null;

  // Waits for Chrome/system voices to become available.
  private voicesReady: Promise<void> | null = null;

  /* -----------------------------------------------------------------------
   * PCM CAPTURE WORKLET
   *
   * Used by speakAndCapture() during export. It taps the same tab-audio
   * capture stream used for narration and pulls out raw Float32 samples
   * on the audio rendering thread (not the main thread), so it keeps
   * working correctly even while the main thread is busy or janky.
   * --------------------------------------------------------------------- */
  private pcmWorkletNode: AudioWorkletNode | null = null;
  private pcmWorkletReady: Promise<AudioWorkletNode | null> | null = null;

  constructor() {
    this.prepareVoices();
  }

  /**
   * Chrome may initially return [] from speechSynthesis.getVoices().
   * Wait until the browser has populated the voice list.
   */
  private prepareVoices(): Promise<void> {
    if (
      typeof window === "undefined" ||
      !("speechSynthesis" in window)
    ) {
      return Promise.resolve();
    }

    if (this.voicesReady) {
      return this.voicesReady;
    }

    this.voicesReady = new Promise((resolve) => {
      const synth = window.speechSynthesis;

      const initialVoices = synth.getVoices();

      if (initialVoices.length > 0) {
        resolve();
        return;
      }

      let resolved = false;

      const finish = () => {
        if (resolved) return;
        resolved = true;
        synth.removeEventListener("voiceschanged", finish);
        resolve();
      };

      synth.addEventListener("voiceschanged", finish);

      // Fallback for browsers that don't fire voiceschanged.
      window.setTimeout(finish, 1500);
    });

    return this.voicesReady;
  }

  get hasContext() {
    return this.ctx !== null;
  }

  get hasNarrationCapture() {
    return this.captureSource !== null;
  }

  ensure() {
    if (typeof window === "undefined") {
      return null;
    }

    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (
          window as unknown as {
            webkitAudioContext: typeof AudioContext;
          }
        ).webkitAudioContext;

      if (!Ctor) {
        return null;
      }

      this.ctx = new Ctor();

      this.sfxGain = this.ctx.createGain();
      this.musicGain = this.ctx.createGain();
      this.voiceGain = this.ctx.createGain();
      this.dest = this.ctx.createMediaStreamDestination();

      for (const g of [this.sfxGain, this.musicGain]) {
        g.connect(this.ctx.destination);
        g.connect(this.dest);
      }

      this.voiceGain.connect(this.dest);
    }

    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }

    return this.ctx;
  }

  apply(settings: AudioSettings) {
    this.ensure();

    if (!this.sfxGain || !this.musicGain || !this.voiceGain) {
      return;
    }

    const m = settings.muted ? 0 : 1;

    this.sfxGain.gain.value = settings.sfxVolume * m;
    this.musicGain.gain.value =
      (settings.music ? settings.musicVolume * 0.35 : 0) * m;
    this.voiceGain.gain.value = settings.voiceVolume * m;
  }

  /**
   * Capture this browser tab's audio so SpeechSynthesis narration can be
   * included in the recorded video.
   */
  async captureNarration(): Promise<boolean> {
    const ctx = this.ensure();

    if (!ctx) {
      return false;
    }

    if (this.captureSource) {
      return true;
    }

    if (this.captureReady) {
      return this.captureReady;
    }

    this.captureReady = (async () => {
      this.captureAttempted = true;

      if (!navigator.mediaDevices?.getDisplayMedia) {
        console.warn(
          "[audio] getDisplayMedia unsupported. Narration cannot be recorded."
        );
        return false;
      }

      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
          preferCurrentTab: true,
          selfBrowserSurface: "include",
        } as DisplayMediaStreamOptions);

        stream.getVideoTracks().forEach((track) => track.stop());

        const audioTracks = stream.getAudioTracks();

        if (!audioTracks.length) {
          console.warn(
            "[audio] No tab audio track returned. Enable 'Share tab audio'."
          );
          stream.getTracks().forEach((t) => t.stop());
          return false;
        }

        this.captureStream = new MediaStream(audioTracks);
        this.captureSource = ctx.createMediaStreamSource(this.captureStream);
        this.captureSource.connect(this.voiceGain!);

        return true;
      } catch (err) {
        console.warn("[audio] Narration capture was not granted:", err);
        return false;
      }
    })();

    return this.captureReady;
  }

  stopNarrationCapture() {
    this.captureSource?.disconnect();
    this.captureSource = null;

    this.captureStream?.getTracks().forEach((t) => t.stop());
    this.captureStream = null;
    this.captureReady = null;
  }

  /* -----------------------------------------------------------------------
   * PCM CAPTURE WORKLET (for export)
   * --------------------------------------------------------------------- */

  private async ensurePcmWorklet(): Promise<AudioWorkletNode | null> {
    const ctx = this.ensure();

    if (!ctx || !this.captureSource) {
      return null;
    }

    if (this.pcmWorkletNode) {
      return this.pcmWorkletNode;
    }

    if (this.pcmWorkletReady) {
      return this.pcmWorkletReady;
    }

    this.pcmWorkletReady = (async () => {
      const processorSource = `
        class PcmGrabber extends AudioWorkletProcessor {
          constructor() {
            super();
            this.active = false;
            this.port.onmessage = (event) => {
              if (event.data === "start") this.active = true;
              if (event.data === "stop") this.active = false;
            };
          }
          process(inputs) {
            const input = inputs[0];
            if (this.active && input && input[0] && input[0].length) {
              this.port.postMessage(input[0].slice(0));
            }
            return true;
          }
        }
        registerProcessor("pcm-grabber", PcmGrabber);
      `;

      const blob = new Blob([processorSource], {
        type: "application/javascript",
      });
      const url = URL.createObjectURL(blob);

      try {
        await ctx.audioWorklet.addModule(url);
      } catch (err) {
        console.warn("[audio] Failed to load PCM capture worklet:", err);
        URL.revokeObjectURL(url);
        return null;
      }

      URL.revokeObjectURL(url);

      const node = new AudioWorkletNode(ctx, "pcm-grabber", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
      });

      // Keep the node "pulled" by the graph without audibly doubling
      // anything: route its unused output through a muted gain.
      const silence = ctx.createGain();
      silence.gain.value = 0;
      node.connect(silence);
      silence.connect(ctx.destination);

      this.captureSource!.connect(node);

      this.pcmWorkletNode = node;
      return node;
    })();

    return this.pcmWorkletReady;
  }

  /**
   * Like speak(), but also returns the raw captured PCM samples for the
   * utterance, measured from the actual audio thread rather than
   * estimated from word count or wall-clock timing. Used by the
   * WebCodecs exporter to build a sample-accurate audio track.
   *
   * If tab-audio capture was never granted, this behaves like speak():
   * you still get a duration, but pcm will be null (no narration audio
   * will end up in the export for that beat).
   */
  async speakAndCapture(
    text: string,
    language: Language,
    settings: AudioSettings
  ): Promise<{ duration: number; pcm: Float32Array | null; sampleRate: number }> {
    const ctx = this.ensure();
    const node = await this.ensurePcmWorklet();

    const chunks: Float32Array[] = [];

    if (node) {
      node.port.onmessage = (event: MessageEvent) => {
        chunks.push(event.data as Float32Array);
      };
      node.port.postMessage("start");
    }

    const duration = await this.speak(text, language, settings);

    if (node) {
      node.port.postMessage("stop");
      node.port.onmessage = null;
    }

    if (!node || chunks.length === 0) {
      return { duration, pcm: null, sampleRate: ctx?.sampleRate ?? 48000 };
    }

    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const pcm = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }

    return { duration, pcm, sampleRate: ctx!.sampleRate };
  }

  private tone(
    freq: number,
    dur: number,
    type: OscillatorType,
    gain = 0.5,
    delay = 0,
    slideTo?: number
  ) {
    const ctx = this.ensure();
    if (!ctx || !this.sfxGain) return;

    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) {
      osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    }

    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(g).connect(this.sfxGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  private noise(dur: number, gain = 0.25) {
    const ctx = this.ensure();
    if (!ctx || !this.sfxGain) return;

    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);

    for (let i = 0; i < d.length; i++) {
      d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const g = ctx.createGain();
    g.gain.value = gain;

    src.connect(g).connect(this.sfxGain);
    src.start();
  }

  sfx(name: SfxName) {
    switch (name) {
      case "board":
        this.tone(320, 0.25, "sine", 0.4, 0, 780);
        break;
      case "pop":
        this.tone(660, 0.12, "triangle", 0.35, 0, 980);
        break;
      case "point":
        this.tone(880, 0.09, "sine", 0.3, 0, 1240);
        break;
      case "tick":
        this.tone(520, 0.09, "square", 0.18);
        break;
      case "final":
        this.tone(300, 0.4, "sawtooth", 0.28, 0, 120);
        break;
      case "correct":
        [523, 659, 784, 1046].forEach((f, i) =>
          this.tone(f, 0.28, "triangle", 0.36, i * 0.09)
        );
        break;
      case "confetti":
        this.noise(0.5, 0.18);
        break;
      case "cheer":
        [784, 988, 1175].forEach((f, i) =>
          this.tone(f, 0.5, "sine", 0.24, i * 0.12)
        );
        this.noise(0.7, 0.1);
        break;
    }
  }

  startMusic() {
    const ctx = this.ensure();
    if (!ctx || this.musicTimer != null) return;

    const notes = [523, 587, 659, 784, 659, 587, 523, 440];

    this.musicTimer = window.setInterval(() => {
      if (!this.musicGain || !this.ctx) return;

      const f = notes[this.musicStep % notes.length]!;
      this.musicStep++;

      const t0 = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();

      osc.type = "triangle";
      osc.frequency.value = f;

      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.42);

      osc.connect(g).connect(this.musicGain);
      osc.start(t0);
      osc.stop(t0 + 0.5);
    }, 420);
  }

  stopMusic() {
    if (this.musicTimer != null) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  /**
   * Speak using an Indian English female voice, and resolve with the
   * ACTUAL spoken duration in seconds once the browser fires the
   * utterance's 'end' event.
   *
   * PERF FIX: previously this unconditionally called
   * `window.speechSynthesis.cancel()` followed by a flat 50ms wait before
   * every single utterance, even when nothing was speaking (the normal
   * case for sequential beats). That added a fixed 50ms tax per narrated
   * beat, per video, for no benefit — cancel() is only meaningful when an
   * utterance is actually in flight. Now the cancel+settle wait only runs
   * when there's something to cancel.
   */
  async speak(
    text: string,
    language: Language,
    settings: AudioSettings
  ): Promise<number> {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      console.warn("[audio] speechSynthesis unsupported.");
      return 0;
    }

    if (settings.muted || settings.voiceVolume <= 0) {
      return 0;
    }

    if (this.captureAttempted && !this.captureSource) {
      console.warn(
        "[audio] Narration capture is not connected. Narration may not appear in the recorded video."
      );
    }

    await this.prepareVoices();

    const u = new SpeechSynthesisUtterance(text);
    const tune = VOICE_TUNING[settings.voice];
    const locale = "en-IN";

    u.lang = locale;
    u.pitch = tune.pitch;
    u.rate = tune.rate;
    u.volume = settings.voiceVolume;

    const voices = window.speechSynthesis.getVoices();
    const indianVoices = voices.filter(
      (v) =>
        v.lang.toLowerCase() === "en-in" ||
        v.lang.toLowerCase().startsWith("en-in")
    );

    let indianFemaleVoice = indianVoices.find((v) =>
      /female|heera|neerja|priya|rani|swara|google.*india|india.*female/i.test(
        v.name
      )
    );

    if (!indianFemaleVoice) {
      indianFemaleVoice = indianVoices.find((v) => /google|microsoft/i.test(v.name));
    }
    if (!indianFemaleVoice) {
      indianFemaleVoice = indianVoices[0];
    }

    if (indianFemaleVoice) {
      u.voice = indianFemaleVoice;
    } else {
      u.lang = "en-IN";
    }

    // PERF FIX: only cancel + wait for the engine to settle if something
    // is actually in-flight. Sequential beats (the normal case) skip this
    // entirely instead of eating a flat 50ms every time.
    if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
      window.speechSynthesis.cancel();

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 50);
      });
    }

    const start = performance.now();

    return new Promise<number>((resolve) => {
      let settled = false;

      const fallbackMs = Math.max(4000, text.split(/\s+/).length * 500);

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const spokenSeconds = (performance.now() - start) / 1000;
        resolve(spokenSeconds);
      };

      const timer = window.setTimeout(() => {
        console.warn(
          "[audio] speech 'end' never fired — using fallback timeout.",
          text.slice(0, 40)
        );
        finish();
      }, fallbackMs);

      u.onend = () => finish();
      u.onerror = () => finish();

      window.speechSynthesis.speak(u);
    });
  }

  waitForSpeechEnd(timeoutMs = 8000): Promise<void> {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timer = window.setTimeout(resolve, timeoutMs);

      const check = () => {
        if (!window.speechSynthesis.speaking) {
          clearTimeout(timer);
          resolve();
        } else {
          requestAnimationFrame(check);
        }
      };

      check();
    });
  }

  stopSpeech() {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }

  dispose() {
    this.stopMusic();
    this.stopSpeech();
    this.stopNarrationCapture();

    this.pcmWorkletNode?.disconnect();
    this.pcmWorkletNode = null;
    this.pcmWorkletReady = null;

    void this.ctx?.close();
    this.ctx = null;
  }
}