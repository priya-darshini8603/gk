import {
  LANGUAGE_LOCALES,
  VOICE_TUNING,
  type AudioSettings,
  type Language,
} from "./types";
import type { Cue } from "./timeline";

/* Web Audio SFX + music bed, plus speech synthesis narration. */

export type SfxName = NonNullable<Cue["sfx"]>;

/** Peak sample amplitude (0..1) below which captured audio is treated as
 * silence rather than real signal. Chosen well above float rounding noise
 * but well below even a quiet spoken voice. */
const SILENCE_PEAK_THRESHOLD = 0.002;

export interface SpeakAndCaptureResult {
  /** Actual spoken duration in seconds, from the browser's 'end' event. */
  duration: number;
  /** Raw captured mono PCM samples, or null if nothing was captured at all. */
  pcm: Float32Array | null;
  sampleRate: number;
  /**
   * True when the browser reported real speech playback (duration > 0,
   * and narration was not intentionally muted) but the tab-audio capture
   * pipeline produced either zero samples or samples with no audible
   * signal. This is the exact signature of SpeechSynthesis audio not
   * being routed through the tab's capturable audio mix (common with
   * local/offline OS voices on some platforms). Callers MUST treat this
   * as a hard failure, not fall back to silence.
   */
  silentCapture: boolean;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private voiceGain: GainNode | null = null;

  private musicTimer: number | null = null;
  private musicStep = 0;

  dest: MediaStreamAudioDestinationNode | null = null;

  // Tab-audio capture for SpeechSynthesis narration. NOTE: this is
  // getDisplayMedia (screen/tab share), never getUserMedia — we never touch
  // the microphone.
  private captureStream: MediaStream | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureAttempted = false;
  private captureReady: Promise<boolean> | null = null;

  // Waits for Chrome/system voices to become available.
  private voicesReady: Promise<void> | null = null;

  /* -----------------------------------------------------------------------
   * PCM CAPTURE WORKLET
   *
   * Taps the same tab-audio capture stream used for narration and pulls
   * out raw Float32 samples on the audio rendering thread (not the main
   * thread), so it keeps working correctly even while the main thread is
   * busy. This is the mechanism speakAndCapture() uses to get narration
   * audio into the exporter's Web Audio graph.
   * --------------------------------------------------------------------- */
  private pcmWorkletNode: AudioWorkletNode | null = null;
  private pcmWorkletReady: Promise<AudioWorkletNode | null> | null = null;

  constructor() {
    this.prepareVoices();
  }

  private prepareVoices(): Promise<void> {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
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
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;

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

      // Narration is routed into the same destination as SFX/music so that
      // `dest` always represents the complete, mixed audio output of this
      // engine — narration + SFX together, in one place.
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
   * Capture this browser TAB's audio (getDisplayMedia, screen/tab share —
   * never the microphone) so SpeechSynthesis narration has a chance of
   * being pulled back into the Web Audio graph. This does not require or
   * depend on physical speakers: it taps the browser's internal audio mix
   * directly, regardless of system volume or whether speakers are
   * connected.
   *
   * IMPORTANT CAVEAT (see verifyNarrationRoute / speakAndCapture): this
   * capture channel can exist and report success while still not actually
   * containing narration audio, if the active TTS voice renders through
   * the OS's native audio pipeline instead of the tab's own mixer. This
   * method only proves the capture *channel* exists — it does not prove
   * narration is audible on it.
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
          "[audio] getDisplayMedia unsupported. Narration cannot be captured for export."
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
            "[audio] No tab audio track returned. 'Share tab audio' was likely not checked."
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

  /**
   * Verifies the narration capture pipeline is actually wired up: a live
   * capture source exists, and `dest` (the same Web Audio destination that
   * mixes narration + SFX together) reports at least one audio track.
   *
   * This catches the "capture was never granted / never connected at all"
   * case immediately. It does NOT prove the captured audio is audible —
   * SpeechSynthesis can still silently fail to route into a capturable
   * stream even when the channel itself is correctly wired. For that,
   * see the `silentCapture` flag returned by speakAndCapture(), which is
   * checked per narration line during export.
   */
  verifyNarrationRoute(): { ok: boolean; reason?: string } {
    if (!this.hasNarrationCapture) {
      return {
        ok: false,
        reason:
          "Tab-audio capture was not granted (or is unsupported in this browser), so narration has no path into the exporter.",
      };
    }

    const tracks = this.dest?.stream.getAudioTracks() ?? [];

    if (tracks.length === 0) {
      return {
        ok: false,
        reason:
          "The narration/SFX audio destination has no audio tracks — the capture graph is not connected.",
      };
    }

    return { ok: true };
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

      const blob = new Blob([processorSource], { type: "application/javascript" });
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
   * Speaks `text` and simultaneously captures whatever tab-audio capture
   * actually receives during that window, then verifies the result is
   * real audio — not just "some bytes came through."
   *
   * `silentCapture: true` means: the utterance was spoken (duration > 0),
   * narration was not intentionally muted, but the captured samples never
   * exceeded the silence threshold. This is the exact failure mode of
   * SpeechSynthesis audio not reaching the tab's capturable mix. Callers
   * MUST treat this as a hard export failure, not a reason to proceed
   * with silence.
   */
  async speakAndCapture(
    text: string,
    language: Language,
    settings: AudioSettings
  ): Promise<SpeakAndCaptureResult> {
    const intentionallyMuted = settings.muted || settings.voiceVolume <= 0;

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
      return {
        duration,
        pcm: null,
        sampleRate: ctx?.sampleRate ?? 48000,
        silentCapture: !intentionallyMuted && duration > 0,
      };
    }

    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const pcm = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }

    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i] < 0 ? -pcm[i] : pcm[i];
      if (v > peak) peak = v;
    }

    const silentCapture =
      !intentionallyMuted && duration > 0 && peak < SILENCE_PEAK_THRESHOLD;

    return { duration, pcm, sampleRate: ctx!.sampleRate, silentCapture };
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
        "[audio] Narration capture is not connected. Narration will not appear in export."
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

    window.speechSynthesis.cancel();

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 50);
    });

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