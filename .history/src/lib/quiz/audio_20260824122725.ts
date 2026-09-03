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

  // Tab-audio capture used to route SpeechSynthesis output into the graph.
  private captureStream: MediaStream | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureAttempted = false;
  private captureReady: Promise<boolean> | null = null;

  // Prevents the first narration from using a default/male voice
  // before Chrome has finished loading its voice list.
  private voicesReady: Promise<void> | null = null;

  constructor() {
    this.prepareVoices();
  }

  /**
   * Wait until Chrome/browser has populated SpeechSynthesis voices.
   * This is important because getVoices() can initially return [].
   */
  private prepareVoices(): Promise<void> {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return Promise.resolve();
    }

    if (this.voicesReady) {
      return this.voicesReady;
    }

    this.voicesReady = new Promise((resolve) => {
      const synth = window.speechSynthesis;

      // Force the browser to initialize the voice list.
      const initialVoices = synth.getVoices();

      if (initialVoices.length > 0) {
        console.log(
          "[audio] Voices already available:",
          initialVoices.map((v) => `${v.name} (${v.lang})`)
        );
        resolve();
        return;
      }

      let resolved = false;

      const finish = () => {
        if (resolved) return;
        resolved = true;

        synth.removeEventListener("voiceschanged", finish);

        const voices = synth.getVoices();

        console.log(
          "[audio] Voices loaded:",
          voices.map((v) => `${v.name} (${v.lang})`)
        );

        resolve();
      };

      synth.addEventListener("voiceschanged", finish);

      // Some browsers don't reliably fire voiceschanged.
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
    if (typeof window === "undefined") return null;

    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (
          window as unknown as {
            webkitAudioContext: typeof AudioContext;
          }
        ).webkitAudioContext;

      if (!Ctor) return null;

      this.ctx = new Ctor();

      this.sfxGain = this.ctx.createGain();
      this.musicGain = this.ctx.createGain();
      this.voiceGain = this.ctx.createGain();

      this.dest = this.ctx.createMediaStreamDestination();

      for (const g of [this.sfxGain, this.musicGain]) {
        g.connect(this.ctx.destination);
        g.connect(this.dest);
      }

      // voiceGain is NOT connected to ctx.destination.
      // The captured tab stream already contains the sound
      // SpeechSynthesis is playing to the speakers.
      //
      // It only feeds the recording destination.
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
   * MUST be called from inside a user-gesture handler
   * such as Play / Render click.
   *
   * Captures this tab's own audio output, including SpeechSynthesis,
   * and routes it into the recording destination.
   */
  async captureNarration(): Promise<boolean> {
    const ctx = this.ensure();

    if (!ctx) return false;

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
          "[audio] getDisplayMedia unsupported — narration cannot be recorded in this browser (Chrome/Edge only)."
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

        // We only need the audio track.
        stream.getVideoTracks().forEach((track) => track.stop());

        const audioTracks = stream.getAudioTracks();

        if (!audioTracks.length) {
          console.warn(
            "[audio] Tab capture granted but returned no audio track. Make sure 'Share tab audio' is enabled."
          );

          stream.getTracks().forEach((t) => t.stop());

          return false;
        }

        this.captureStream = new MediaStream(audioTracks);

        this.captureSource =
          ctx.createMediaStreamSource(this.captureStream);

        this.captureSource.connect(this.voiceGain!);

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

    this.captureStream?.getTracks().forEach((t) => t.stop());

    this.captureStream = null;
    this.captureReady = null;
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
      osc.frequency.exponentialRampToValueAtTime(
        slideTo,
        t0 + dur
      );
    }

    g.gain.setValueAtTime(0.0001, t0);

    g.gain.exponentialRampToValueAtTime(
      gain,
      t0 + 0.012
    );

    g.gain.exponentialRampToValueAtTime(
      0.0001,
      t0 + dur
    );

    osc.connect(g).connect(this.sfxGain);

    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  private noise(dur: number, gain = 0.25) {
    const ctx = this.ensure();

    if (!ctx || !this.sfxGain) return;

    const buf = ctx.createBuffer(
      1,
      ctx.sampleRate * dur,
      ctx.sampleRate
    );

    const d = buf.getChannelData(0);

    for (let i = 0; i < d.length; i++) {
      d[i] =
        (Math.random() * 2 - 1) *
        (1 - i / d.length);
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
        this.tone(
          320,
          0.25,
          "sine",
          0.4,
          0,
          780
        );
        break;

      case "pop":
        this.tone(
          660,
          0.12,
          "triangle",
          0.35,
          0,
          980
        );
        break;

      case "point":
        this.tone(
          880,
          0.09,
          "sine",
          0.3,
          0,
          1240
        );
        break;

      case "tick":
        this.tone(
          520,
          0.09,
          "square",
          0.18
        );
        break;

      case "final":
        this.tone(
          300,
          0.4,
          "sawtooth",
          0.28,
          0,
          120
        );
        break;

      case "correct":
        [523, 659, 784, 1046].forEach(
          (f, i) =>
            this.tone(
              f,
              0.28,
              "triangle",
              0.36,
              i * 0.09
            )
        );
        break;

      case "confetti":
        this.noise(0.5, 0.18);
        break;

      case "cheer":
        [784, 988, 1175].forEach(
          (f, i) =>
            this.tone(
              f,
              0.5,
              "sine",
              0.24,
              i * 0.12
            )
        );

        this.noise(0.7, 0.1);
        break;
    }
  }

  startMusic() {
    const ctx = this.ensure();

    if (!ctx || this.musicTimer != null) return;

    const notes = [
      523,
      587,
      659,
      784,
      659,
      587,
      523,
      440,
    ];

    this.musicTimer = window.setInterval(() => {
      if (!this.musicGain || !this.ctx) return;

      const f =
        notes[this.musicStep % notes.length]!;

      this.musicStep++;

      const t0 = this.ctx.currentTime;

      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();

      osc.type = "triangle";
      osc.frequency.value = f;

      g.gain.setValueAtTime(
        0.0001,
        t0
      );

      g.gain.exponentialRampToValueAtTime(
        0.18,
        t0 + 0.05
      );

      g.gain.exponentialRampToValueAtTime(
        0.0001,
        t0 + 0.42
      );

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
   * Speaks text using SpeechSynthesis.
   *
   * IMPORTANT:
   * This waits for the browser's voice list before selecting
   * the voice, preventing the first narration from accidentally
   * using the browser's default voice.
   */
  async speak(
    text: string,
    language: Language,
    settings: AudioSettings
  ) {
    if (
      typeof window === "undefined" ||
      !("speechSynthesis" in window)
    ) {
      console.warn(
        "[audio] speechSynthesis unsupported in this browser."
      );

      return;
    }

    if (
      settings.muted ||
      settings.voiceVolume <= 0
    ) {
      return;
    }

    if (
      this.captureAttempted &&
      !this.captureSource
    ) {
      console.warn(
        "[audio] Speaking, but narration capture is not connected — this utterance will NOT be in the recorded video."
      );
    }

    // IMPORTANT:
    // Wait for Chrome to load its voice list BEFORE
    // creating/speaking the first utterance.
    await this.prepareVoices();

    const u =
      new SpeechSynthesisUtterance(text);

    const tune =
      VOICE_TUNING[settings.voice];

    const locale =
      LANGUAGE_LOCALES[language];

    u.lang = locale;
    u.pitch = tune.pitch;
    u.rate = tune.rate;
    u.volume = settings.voiceVolume;

    const voices =
      window.speechSynthesis.getVoices();

    /*
     * FEMALE VOICE PRIORITY
     *
     * First try well-known female voices.
     * Then try any voice whose name contains
     * female-related identifiers.
     */
    const languagePrefix =
      locale.split("-")[0]!;

    const femaleVoice =
      voices.find(
        (v) =>
          /Microsoft Zira|Microsoft Jenny|Microsoft Aria|Microsoft Sonia|Samantha|Karen|Google US English Female|Google UK English Female|Heera|Neerja/i.test(
            v.name
          ) &&
          v.lang.startsWith(languagePrefix)
      ) ??
      voices.find(
        (v) =>
          /Zira|Jenny|Aria|Sonia|Samantha|Karen|Heera|Neerja|Female/i.test(
            v.name
          ) &&
          v.lang.startsWith(languagePrefix)
      );

    if (femaleVoice) {
      u.voice = femaleVoice;

      console.log(
        "[audio] FEMALE voice selected:",
        femaleVoice.name,
        femaleVoice.lang
      );
    } else {
      /*
       * IMPORTANT:
       * Do not silently choose a random voice here.
       *
       * If there is no detectable female voice,
       * we use the best language-matching voice.
       *
       * To guarantee female voice, install/enable a
       * female voice in Windows/Chrome.
       */
      const languageVoice =
        voices.find(
          (v) => v.lang === locale
        ) ??
        voices.find(
          (v) =>
            v.lang.startsWith(
              languagePrefix
            )
        );

      if (languageVoice) {
        u.voice = languageVoice;

        console.warn(
          "[audio] No known female voice found. Using language voice:",
          languageVoice.name,
          languageVoice.lang
        );
      } else {
        console.warn(
          "[audio] No matching voice found for:",
          locale
        );
      }
    }

    console.log(
      `[audio] TTS start: "${text.slice(
        0,
        40
      )}${text.length > 40 ? "…" : ""}"`,
      "(voice:",
      u.voice?.name ?? "browser default",
      ")",
      "(captured:",
      !!this.captureSource,
      ")"
    );

    window.speechSynthesis.cancel();

    // Small delay prevents Chrome from occasionally
    // ignoring the voice on the first utterance.
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 50);
    });

    window.speechSynthesis.speak(u);
  }

  /**
   * Await the currently queued utterance(s) finishing.
   */
  waitForSpeechEnd(
    timeoutMs = 8000
  ): Promise<void> {
    if (
      typeof window === "undefined" ||
      !("speechSynthesis" in window)
    ) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timer =
        window.setTimeout(
          resolve,
          timeoutMs
        );

      const check = () => {
        if (
          !window.speechSynthesis
            .speaking
        ) {
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
    if (
      typeof window !== "undefined" &&
      "speechSynthesis" in window
    ) {
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