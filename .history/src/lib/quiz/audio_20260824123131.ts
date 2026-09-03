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

  // Ensures Chrome has loaded its voices before narration starts.
  private voicesReady: Promise<void> | null = null;

  constructor() {
    this.prepareVoices();
  }

  /**
   * Wait for browser voices to become available.
   * Chrome can return an empty array from getVoices()
   * during the first call.
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

      // Force voice initialization.
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

      this.dest =
        this.ctx.createMediaStreamDestination();

      // SFX and music go both to speakers and recording.
      for (const g of [
        this.sfxGain,
        this.musicGain,
      ]) {
        g.connect(this.ctx.destination);
        g.connect(this.dest);
      }

      /*
       * SpeechSynthesis is captured from the tab.
       * Therefore voiceGain only goes to the recording
       * destination to avoid doubling the live audio.
       */
      this.voiceGain.connect(this.dest);
    }

    if (this.ctx.state === "suspended") {
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

    const m = settings.muted ? 0 : 1;

    this.sfxGain.gain.value =
      settings.sfxVolume * m;

    this.musicGain.gain.value =
      (settings.music
        ? settings.musicVolume * 0.35
        : 0) * m;

    this.voiceGain.gain.value =
      settings.voiceVolume * m;
  }

  /**
   * Captures the current browser tab's audio.
   *
   * IMPORTANT:
   * Call this from a Play/Render button click because
   * getDisplayMedia requires a user gesture.
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
          "[audio] getDisplayMedia unsupported. Narration cannot be recorded in this browser."
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
              selfBrowserSurface: "include",
            } as DisplayMediaStreamOptions
          );

        // We only need the audio track.
        stream
          .getVideoTracks()
          .forEach((track) => track.stop());

        const audioTracks =
          stream.getAudioTracks();

        if (!audioTracks.length) {
          console.warn(
            "[audio] No tab audio track returned. Make sure 'Share tab audio' is enabled."
          );

          stream
            .getTracks()
            .forEach((t) => t.stop());

          return false;
        }

        this.captureStream =
          new MediaStream(audioTracks);

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
      .forEach((t) => t.stop());

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

    if (!ctx || !this.sfxGain) {
      return;
    }

    const t0 =
      ctx.currentTime + delay;

    const osc =
      ctx.createOscillator();

    const g =
      ctx.createGain();

    osc.type = type;

    osc.frequency.setValueAtTime(
      freq,
      t0
    );

    if (slideTo) {
      osc.frequency.exponentialRampToValueAtTime(
        slideTo,
        t0 + dur
      );
    }

    g.gain.setValueAtTime(
      0.0001,
      t0
    );

    g.gain.exponentialRampToValueAtTime(
      gain,
      t0 + 0.012
    );

    g.gain.exponentialRampToValueAtTime(
      0.0001,
      t0 + dur
    );

    osc
      .connect(g)
      .connect(this.sfxGain);

    osc.start(t0);

    osc.stop(
      t0 + dur + 0.05
    );
  }

  private noise(
    dur: number,
    gain = 0.25
  ) {
    const ctx = this.ensure();

    if (!ctx || !this.sfxGain) {
      return;
    }

    const buf =
      ctx.createBuffer(
        1,
        ctx.sampleRate * dur,
        ctx.sampleRate
      );

    const d =
      buf.getChannelData(0);

    for (
      let i = 0;
      i < d.length;
      i++
    ) {
      d[i] =
        (Math.random() * 2 - 1) *
        (1 - i / d.length);
    }

    const src =
      ctx.createBufferSource();

    src.buffer = buf;

    const g =
      ctx.createGain();

    g.gain.value = gain;

    src
      .connect(g)
      .connect(this.sfxGain);

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
        [
          523,
          659,
          784,
          1046,
        ].forEach((f, i) => {
          this.tone(
            f,
            0.28,
            "triangle",
            0.36,
            i * 0.09
          );
        });
        break;

      case "confetti":
        this.noise(
          0.5,
          0.18
        );
        break;

      case "cheer":
        [
          784,
          988,
          1175,
        ].forEach((f, i) => {
          this.tone(
            f,
            0.5,
            "sine",
            0.24,
            i * 0.12
          );
        });

        this.noise(
          0.7,
          0.1
        );
        break;
    }
  }

  startMusic() {
    const ctx = this.ensure();

    if (
      !ctx ||
      this.musicTimer != null
    ) {
      return;
    }

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

    this.musicTimer =
      window.setInterval(() => {
        if (
          !this.musicGain ||
          !this.ctx
        ) {
          return;
        }

        const f =
          notes[
            this.musicStep %
              notes.length
          ]!;

        this.musicStep++;

        const t0 =
          this.ctx.currentTime;

        const osc =
          this.ctx.createOscillator();

        const g =
          this.ctx.createGain();

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

        osc
          .connect(g)
          .connect(this.musicGain);

        osc.start(t0);

        osc.stop(
          t0 + 0.5
        );
      }, 420);
  }

  stopMusic() {
    if (
      this.musicTimer != null
    ) {
      clearInterval(
        this.musicTimer
      );

      this.musicTimer = null;
    }
  }

  /**
   * Speak using Microsoft Zira.
   *
   * Zira is explicitly selected.
   * No generic female voice is selected.
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
        "[audio] Narration capture is not connected. This narration may not appear in the recorded video."
      );
    }

    /*
     * IMPORTANT:
     * Wait until Chrome has loaded all voices.
     * This prevents the FIRST narration from using
     * Chrome's default voice.
     */
    await this.prepareVoices();

    const u =
      new SpeechSynthesisUtterance(
        text
      );

    const tune =
      VOICE_TUNING[
        settings.voice
      ];

    const locale =
      LANGUAGE_LOCALES[
        language
      ];

    u.lang = locale;

    u.pitch = tune.pitch;
    u.rate = tune.rate;
    u.volume =
      settings.voiceVolume;

    const voices =
      window.speechSynthesis.getVoices();

    const languagePrefix =
      locale.split("-")[0]!;

    /*
     * ==================================================
     * MICROSOFT ZIRA — EXPLICIT SELECTION
     * ==================================================
     */

    const ziraVoice =
      voices.find(
        (v) =>
          /Microsoft Zira/i.test(
            v.name
          ) &&
          v.lang.startsWith(
            languagePrefix
          )
      ) ??
      voices.find(
        (v) =>
          /Microsoft Zira/i.test(
            v.name
          )
      );

    if (ziraVoice) {
      u.voice = ziraVoice;

      console.log(
        "[audio] ✅ MICROSOFT ZIRA SELECTED:",
        ziraVoice.name,
        ziraVoice.lang
      );
    } else {
      /*
       * DO NOT silently switch to a male voice.
       *
       * If Zira isn't installed, report the problem.
       */
      console.error(
        "[audio] ❌ MICROSOFT ZIRA NOT FOUND."
      );

      console.error(
        "[audio] Available voices:",
        voices.map(
          (v) =>
            `${v.name} (${v.lang})`
        )
      );

      /*
       * We still use the browser's language-matching
       * voice so the application doesn't completely
       * stop working.
       *
       * If you want ZERO fallback, remove this block.
       */
      const languageVoice =
        voices.find(
          (v) =>
            v.lang === locale
        ) ??
        voices.find(
          (v) =>
            v.lang.startsWith(
              languagePrefix
            )
        );

      if (languageVoice) {
        u.voice =
          languageVoice;

        console.warn(
          "[audio] ⚠️ Zira unavailable. Fallback voice:",
          languageVoice.name,
          languageVoice.lang
        );
      }
    }

    console.log(
      `[audio] TTS start: "${text.slice(
        0,
        40
      )}${
        text.length > 40
          ? "…"
          : ""
      }"`
    );

    console.log(
      "[audio] Final voice:",
      u.voice?.name ??
        "browser default"
    );

    /*
     * Stop any previous narration.
     */
    window.speechSynthesis.cancel();

    /*
     * Small delay helps Chrome consistently apply
     * the explicitly selected voice.
     */
    await new Promise<void>(
      (resolve) => {
        window.setTimeout(
          resolve,
          50
        );
      }
    );

    window.speechSynthesis.speak(
      u
    );
  }

  /**
   * Wait for current speech to finish.
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

    return new Promise(
      (resolve) => {
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
            requestAnimationFrame(
              check
            );
          }
        };

        check();
      }
    );
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