import {
  LANGUAGE_LOCALES,
  VOICE_TUNING,
  type AudioSettings,
  type Language,
} from "./types";
import type { Cue } from "./timeline";
import { scheduleSfx, type SfxName } from "./sfxSynth";

export type { SfxName };

/* Web Audio SFX + music bed, plus speech synthesis narration. */

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

  // --- Raw PCM export capture (AudioWorklet-based) -----------------------
  private static readonly CAPTURE_WORKLET_SOURCE = `
    class GkQuizCaptureProcessor extends AudioWorkletProcessor {
      process(inputs) {
        const input = inputs[0];
        if (input && input[0] && input[0].length) {
          // Copy — the underlying buffer gets reused by the audio thread.
          const copy = input[0].slice();
          this.port.postMessage(copy, [copy.buffer]);
        }
        return true;
      }
    }
    registerProcessor("gk-quiz-capture", GkQuizCaptureProcessor);
  `;

  private workletModuleReady = false;
  private captureNode: AudioWorkletNode | null = null;
  private captureSilentSink: GainNode | null = null;
  private pcmChunks: Float32Array[] = [];

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
        console.log(
          "[audio] Voices already available:",
          initialVoices.map(
            (v) => `${v.name} (${v.lang})`
          )
        );

        resolve();
        return;
      }

      let resolved = false;

      const finish = () => {
        if (resolved) return;

        resolved = true;

        synth.removeEventListener(
          "voiceschanged",
          finish
        );

        const voices = synth.getVoices();

        console.log(
          "[audio] Voices loaded:",
          voices.map(
            (v) => `${v.name} (${v.lang})`
          )
        );

        resolve();
      };

      synth.addEventListener(
        "voiceschanged",
        finish
      );

      // Fallback for browsers that don't fire voiceschanged.
      window.setTimeout(
        finish,
        1500
      );
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

      this.sfxGain =
        this.ctx.createGain();

      this.musicGain =
        this.ctx.createGain();

      this.voiceGain =
        this.ctx.createGain();

      this.dest =
        this.ctx.createMediaStreamDestination();

      // SFX and music go to speakers and recording.
      for (const g of [
        this.sfxGain,
        this.musicGain,
      ]) {
        g.connect(
          this.ctx.destination
        );

        g.connect(this.dest);
      }

      /*
       * SpeechSynthesis is captured from the tab.
       * voiceGain therefore only feeds recording.
       */
      this.voiceGain.connect(
        this.dest
      );
    }

    if (
      this.ctx.state === "suspended"
    ) {
      void this.ctx.resume();
    }

    return this.ctx;
  }

  apply(settings: AudioSettings) {
    this.ensure();

    if (
      !this.sfxGain ||
      !this.musicGain ||
      !this.voiceGain
    ) {
      return;
    }

    const m =
      settings.muted ? 0 : 1;

    this.sfxGain.gain.value =
      settings.sfxVolume * m;

    this.musicGain.gain.value =
      (
        settings.music
          ? settings.musicVolume * 0.35
          : 0
      ) * m;

    this.voiceGain.gain.value =
      settings.voiceVolume * m;
  }

  /**
   * Capture this browser tab's audio so SpeechSynthesis
   * narration can be included in the recorded video.
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

    this.captureReady =
      (async () => {
        this.captureAttempted = true;

        if (
          !navigator.mediaDevices
            ?.getDisplayMedia
        ) {
          console.warn(
            "[audio] getDisplayMedia unsupported. Narration cannot be recorded."
          );

          return false;
        }

        try {
          const stream =
            await navigator.mediaDevices.getDisplayMedia(
              {
                video: true,
                audio: true,
                preferCurrentTab: true,
                selfBrowserSurface:
                  "include",
              } as DisplayMediaStreamOptions
            );

          // We only need audio.
          stream
            .getVideoTracks()
            .forEach((track) =>
              track.stop()
            );

          const audioTracks =
            stream.getAudioTracks();

          if (!audioTracks.length) {
            console.warn(
              "[audio] No tab audio track returned. Enable 'Share tab audio'."
            );

            stream
              .getTracks()
              .forEach((t) =>
                t.stop()
              );

            return false;
          }

          this.captureStream =
            new MediaStream(
              audioTracks
            );

          this.captureSource =
            ctx.createMediaStreamSource(
              this.captureStream
            );

          this.captureSource.connect(
            this.voiceGain!
          );

          console.log(
            "[audio] Narration capture connected. Tracks:",
            audioTracks.length
          );

          return true;
        } catch (err) {
          console.warn(
            "[audio] Narration capture was not granted:",
            err
          );

          return false;
        }
      })();

    return this.captureReady;
  }

  stopNarrationCapture() {
    this.captureSource?.disconnect();

    this.captureSource = null;

    this.captureStream
      ?.getTracks()
      .forEach((t) =>
        t.stop()
      );

    this.captureStream = null;
    this.captureReady = null;
  }

  /* -----------------------------------------------------------------------
   * RAW PCM CAPTURE FOR EXPORT
   *
   * Runs on the dedicated audio-rendering thread (AudioWorkletNode), not
   * the main thread — so it keeps recording sample-accurate audio even
   * while the main thread is busy drawing/encoding video frames.
   *
   * export.ts no longer reads back one giant continuous recording of the
   * whole render (that was the piece forcing every beat, even silent
   * fixed beats, to be waited out in real time). Instead it takes a
   * `markPcmPosition()` snapshot right before each narrated beat's speech
   * starts, and `extractPcmSince()` right after — grabbing exactly that
   * beat's real audio and nothing else. Non-narrated beats never touch
   * this capture at all; their SFX is rendered offline in export.ts.
   * --------------------------------------------------------------------- */

  /** Begin capturing the full mixed graph (sfx + music + narration) as mono PCM. */
  async startPcmCapture(): Promise<void> {
    const ctx = this.ensure();

    if (!ctx || !this.sfxGain || !this.musicGain || !this.voiceGain) {
      throw new Error("Audio engine failed to initialize for export.");
    }

    if (!this.workletModuleReady) {
      const blob = new Blob(
        [AudioEngine.CAPTURE_WORKLET_SOURCE],
        { type: "application/javascript" }
      );

      const url = URL.createObjectURL(blob);

      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }

      this.workletModuleReady = true;
    }

    this.pcmChunks = [];

    this.captureNode = new AudioWorkletNode(ctx, "gk-quiz-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });

    this.captureNode.port.onmessage = (
      event: MessageEvent<Float32Array>
    ) => {
      this.pcmChunks.push(event.data);
    };

    // A silent sink keeps this node inside the graph that actually gets
    // pulled from ctx.destination every render quantum — a node with no
    // path to the destination may not be processed at all.
    this.captureSilentSink = ctx.createGain();
    this.captureSilentSink.gain.value = 0;

    this.sfxGain.connect(this.captureNode);
    this.musicGain.connect(this.captureNode);
    this.voiceGain.connect(this.captureNode);
    this.captureNode.connect(this.captureSilentSink);
    this.captureSilentSink.connect(ctx.destination);
  }

  /**
   * Returns a marker for "how many chunks have been captured so far".
   * Pair with `extractPcmSince()` to pull out just the audio that arrived
   * between two points in time (e.g. around one narrated beat).
   */
  markPcmPosition(): number {
    return this.pcmChunks.length;
  }

  /** Concatenate every chunk captured since `markIndex` into one buffer. */
  extractPcmSince(markIndex: number): Float32Array {
    const chunksSince = this.pcmChunks.slice(markIndex);

    let total = 0;
    for (const c of chunksSince) total += c.length;

    const out = new Float32Array(total);
    let offset = 0;

    for (const c of chunksSince) {
      out.set(c, offset);
      offset += c.length;
    }

    return out;
  }

  /** Stop capture and tear down the recording graph. */
  stopPcmCapture(): void {
    try {
      this.sfxGain?.disconnect(this.captureNode!);
    } catch { /* already disconnected */ }
    try {
      this.musicGain?.disconnect(this.captureNode!);
    } catch { /* already disconnected */ }
    try {
      this.voiceGain?.disconnect(this.captureNode!);
    } catch { /* already disconnected */ }

    this.captureNode?.disconnect();
    this.captureSilentSink?.disconnect();

    this.pcmChunks = [];
    this.captureNode = null;
    this.captureSilentSink = null;
  }

  get sampleRate(): number | null {
    return this.ctx?.sampleRate ?? null;
  }

  /**
   * Play a sound effect, optionally scheduled `delay` seconds in the
   * future on the Web Audio clock. Scheduling ahead of time (rather than
   * triggering it from a JS timer/rAF loop) makes the timing sample-
   * accurate regardless of main-thread load.
   */
  sfx(name: SfxName, delay = 0) {
    const ctx = this.ensure();

    if (!ctx || !this.sfxGain) {
      return;
    }

    scheduleSfx(ctx, this.sfxGain, name, ctx.currentTime + delay);
  }

  startMusic() {
    const ctx = this.ensure();

    if (!ctx || this.musicTimer != null) {
      return;
    }

    const notes = [523, 587, 659, 784, 659, 587, 523, 440];

    this.musicTimer = window.setInterval(() => {
      if (!this.musicGain || !this.ctx) {
        return;
      }

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
   * This return value is the single source of truth for how long a
   * narration beat took — callers (export.ts) use it directly instead of
   * guessing from word count ahead of time.
   *
   * Voice priority:
   * 1. en-IN female voice
   * 2. known Indian English female voice names
   * 3. any en-IN voice
   *
   * The language is forced to en-IN.
   */
  async speak(
    text: string,
    language: Language,
    settings: AudioSettings
  ): Promise<number> {
    if (
      typeof window === "undefined" ||
      !("speechSynthesis" in window)
    ) {
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
      indianFemaleVoice = indianVoices.find((v) =>
        /google|microsoft/i.test(v.name)
      );
    }

    if (!indianFemaleVoice) {
      indianFemaleVoice = indianVoices[0];
    }

    if (indianFemaleVoice) {
      u.voice = indianFemaleVoice;
    } else {
      u.lang = "en-IN";
    }

    window.speechSynthesis.cancel();

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 50);
    });

    const start = performance.now();

    return new Promise<number>((resolve) => {
      let settled = false;

      const fallbackMs = Math.max(
        4000,
        text.split(/\s+/).length * 500
      );

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
    if (
      typeof window === "undefined" ||
      !("speechSynthesis" in window)
    ) {
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
    void this.ctx?.close();
    this.ctx = null;
  }
}