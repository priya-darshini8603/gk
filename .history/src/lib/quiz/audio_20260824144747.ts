import {
  LANGUAGE_LOCALES,
  VOICE_TUNING,
  type AudioSettings,
  type Language,
} from "./types";

import type { Cue } from "./timeline";

/* ---------------------------------------------------------------------------
 * Web Audio SFX + music bed + SpeechSynthesis narration.
 *
 * IMPORTANT:
 * speak() returns a Promise and resolves ONLY when the browser reports that
 * the utterance has actually finished.
 * ------------------------------------------------------------------------- */

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

  constructor() {
    this.prepareVoices();
  }

  /* -----------------------------------------------------------------------
   * VOICES
   * --------------------------------------------------------------------- */

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

      const initialVoices =
        synth.getVoices();

      if (initialVoices.length > 0) {
        console.log(
          "[audio] Voices already available:",
          initialVoices.map(
            (v) =>
              `${v.name} (${v.lang})`,
          ),
        );

        resolve();
        return;
      }

      let resolved = false;

      const finish = () => {
        if (resolved) {
          return;
        }

        resolved = true;

        synth.removeEventListener(
          "voiceschanged",
          finish,
        );

        const voices =
          synth.getVoices();

        console.log(
          "[audio] Voices loaded:",
          voices.map(
            (v) =>
              `${v.name} (${v.lang})`,
          ),
        );

        resolve();
      };

      synth.addEventListener(
        "voiceschanged",
        finish,
      );

      window.setTimeout(
        finish,
        1500,
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

  /* -----------------------------------------------------------------------
   * AUDIO CONTEXT
   * --------------------------------------------------------------------- */

  ensure() {
    if (
      typeof window === "undefined"
    ) {
      return null;
    }

    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (
          window as unknown as {
            webkitAudioContext:
              typeof AudioContext;
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

      /*
       * SFX and music go to:
       *
       * 1. speakers
       * 2. recording destination
       */
      for (const g of [
        this.sfxGain,
        this.musicGain,
      ]) {
        g.connect(
          this.ctx.destination,
        );

        g.connect(this.dest);
      }

      /*
       * Speech capture goes to recording.
       */
      this.voiceGain.connect(
        this.dest,
      );
    }

    if (
      this.ctx.state ===
      "suspended"
    ) {
      void this.ctx.resume();
    }

    return this.ctx;
  }

  /* -----------------------------------------------------------------------
   * AUDIO SETTINGS
   * --------------------------------------------------------------------- */

  apply(
    settings: AudioSettings,
  ) {
    this.ensure();

    if (
      !this.sfxGain ||
      !this.musicGain ||
      !this.voiceGain
    ) {
      return;
    }

    const multiplier =
      settings.muted ? 0 : 1;

    this.sfxGain.gain.value =
      settings.sfxVolume *
      multiplier;

    this.musicGain.gain.value =
      (
        settings.music
          ? settings.musicVolume *
            0.35
          : 0
      ) * multiplier;

    this.voiceGain.gain.value =
      settings.voiceVolume *
      multiplier;
  }

  /* -----------------------------------------------------------------------
   * NARRATION CAPTURE
   * --------------------------------------------------------------------- */

  async captureNarration(): Promise<boolean> {
    const ctx =
      this.ensure();

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
        this.captureAttempted =
          true;

        if (
          !navigator.mediaDevices
            ?.getDisplayMedia
        ) {
          console.warn(
            "[audio] getDisplayMedia unsupported.",
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
              } as DisplayMediaStreamOptions,
            );

          /*
           * Only audio is required.
           */
          stream
            .getVideoTracks()
            .forEach(
              (track) =>
                track.stop(),
            );

          const audioTracks =
            stream.getAudioTracks();

          if (
            !audioTracks.length
          ) {
            console.warn(
              "[audio] No tab audio track returned. Enable Share tab audio.",
            );

            stream
              .getTracks()
              .forEach(
                (track) =>
                  track.stop(),
              );

            return false;
          }

          this.captureStream =
            new MediaStream(
              audioTracks,
            );

          this.captureSource =
            ctx.createMediaStreamSource(
              this.captureStream,
            );

          this.captureSource.connect(
            this.voiceGain!,
          );

          console.log(
            "[audio] Narration capture connected.",
          );

          return true;
        } catch (error) {
          console.warn(
            "[audio] Narration capture was not granted:",
            error,
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
      .forEach(
        (track) =>
          track.stop(),
      );

    this.captureStream = null;
    this.captureReady = null;
  }

  /* -----------------------------------------------------------------------
   * SFX HELPERS
   * --------------------------------------------------------------------- */

  private tone(
    freq: number,
    dur: number,
    type: OscillatorType,
    gain = 0.5,
    delay = 0,
    slideTo?: number,
  ) {
    const ctx =
      this.ensure();

    if (
      !ctx ||
      !this.sfxGain
    ) {
      return;
    }

    const t0 =
      ctx.currentTime +
      delay;

    const osc =
      ctx.createOscillator();

    const g =
      ctx.createGain();

    osc.type = type;

    osc.frequency.setValueAtTime(
      freq,
      t0,
    );

    if (slideTo) {
      osc.frequency.exponentialRampToValueAtTime(
        slideTo,
        t0 + dur,
      );
    }

    g.gain.setValueAtTime(
      0.0001,
      t0,
    );

    g.gain.exponentialRampToValueAtTime(
      gain,
      t0 + 0.012,
    );

    g.gain.exponentialRampToValueAtTime(
      0.0001,
      t0 + dur,
    );

    osc
      .connect(g)
      .connect(
        this.sfxGain,
      );

    osc.start(t0);

    osc.stop(
      t0 + dur + 0.05,
    );
  }

  private noise(
    dur: number,
    gain = 0.25,
  ) {
    const ctx =
      this.ensure();

    if (
      !ctx ||
      !this.sfxGain
    ) {
      return;
    }

    const buffer =
      ctx.createBuffer(
        1,
        ctx.sampleRate * dur,
        ctx.sampleRate,
      );

    const data =
      buffer.getChannelData(0);

    for (
      let i = 0;
      i < data.length;
      i++
    ) {
      data[i] =
        (Math.random() * 2 - 1) *
        (1 - i / data.length);
    }

    const source =
      ctx.createBufferSource();

    source.buffer = buffer;

    const g =
      ctx.createGain();

    g.gain.value = gain;

    source
      .connect(g)
      .connect(
        this.sfxGain,
      );

    source.start();
  }

  /* -----------------------------------------------------------------------
   * SFX
   * --------------------------------------------------------------------- */

  sfx(
    name: SfxName,
  ) {
    switch (name) {
      case "board":
        this.tone(
          320,
          0.25,
          "sine",
          0.4,
          0,
          780,
        );
        break;

      case "pop":
        this.tone(
          660,
          0.12,
          "triangle",
          0.35,
          0,
          980,
        );
        break;

      case "point":
        this.tone(
          880,
          0.09,
          "sine",
          0.3,
          0,
          1240,
        );
        break;

      case "tick":
        this.tone(
          520,
          0.09,
          "square",
          0.18,
        );
        break;

      case "final":
        this.tone(
          300,
          0.4,
          "sawtooth",
          0.28,
          0,
          120,
        );
        break;

      case "correct":
        [
          523,
          659,
          784,
          1046,
        ].forEach(
          (frequency, index) =>
            this.tone(
              frequency,
              0.28,
              "triangle",
              0.36,
              index * 0.09,
            ),
        );
        break;

      case "confetti":
        this.noise(
          0.5,
          0.18,
        );
        break;

      case "cheer":
        [
          784,
          988,
          1175,
        ].forEach(
          (frequency, index) =>
            this.tone(
              frequency,
              0.5,
              "sine",
              0.24,
              index * 0.12,
            ),
        );

        this.noise(
          0.7,
          0.1,
        );

        break;
    }
  }

  /* -----------------------------------------------------------------------
   * MUSIC
   * --------------------------------------------------------------------- */

  startMusic() {
    const ctx =
      this.ensure();

    if (
      !ctx ||
      this.musicTimer !== null
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
      window.setInterval(
        () => {
          if (
            !this.musicGain ||
            !this.ctx
          ) {
            return;
          }

          const frequency =
            notes[
              this.musicStep %
                notes.length
            ]!;

          this.musicStep++;

          const t0 =
            this.ctx.currentTime;

          const osc =
            this.ctx.createOscillator();

          const gain =
            this.ctx.createGain();

          osc.type =
            "triangle";

          osc.frequency.value =
            frequency;

          gain.gain.setValueAtTime(
            0.0001,
            t0,
          );

          gain.gain.exponentialRampToValueAtTime(
            0.18,
            t0 + 0.05,
          );

          gain.gain.exponentialRampToValueAtTime(
            0.0001,
            t0 + 0.42,
          );

          osc
            .connect(gain)
            .connect(
              this.musicGain,
            );

          osc.start(t0);

          osc.stop(
            t0 + 0.5,
          );
        },
        420,
      );
  }

  stopMusic() {
    if (
      this.musicTimer !== null
    ) {
      clearInterval(
        this.musicTimer,
      );

      this.musicTimer = null;
    }
  }

  /* -----------------------------------------------------------------------
   * SPEECH
   *
   * CRITICAL:
   * This Promise resolves ONLY when SpeechSynthesis.onend fires.
   * Therefore the caller can safely:
   *
   * await audio.speak(...)
   * audio.sfx(...)
   *
   * without cutting the narration.
   * --------------------------------------------------------------------- */

  async speak(
    text: string,
    language: Language,
    settings: AudioSettings,
  ): Promise<void> {
    if (
      typeof window === "undefined" ||
      !("speechSynthesis" in window)
    ) {
      return;
    }

    if (
      settings.muted ||
      settings.voiceVolume <= 0
    ) {
      return;
    }

    await this.prepareVoices();

    const synth =
      window.speechSynthesis;

    /*
     * Stop previous speech.
     *
     * We process speech sequentially,
     * so this should normally be idle.
     */
    synth.cancel();

    /*
     * Chrome can ignore a new utterance
     * immediately after cancel().
     */
    await new Promise<void>(
      (resolve) =>
        window.setTimeout(
          resolve,
          60,
        ),
    );

    const utterance =
      new SpeechSynthesisUtterance(
        text,
      );

    /*
     * Keep the existing language setting,
     * but force Indian English when the
     * selected language is English.
     */
    const configuredLocale =
      LANGUAGE_LOCALES[
        language
      ];

    const locale =
      configuredLocale?.toLowerCase().startsWith(
        "en",
      )
        ? "en-IN"
        : configuredLocale;

    utterance.lang =
      locale;

    const tuning =
      VOICE_TUNING[
        settings.voice
      ];

    utterance.pitch =
      tuning.pitch;

    utterance.rate =
      tuning.rate;

    utterance.volume =
      settings.voiceVolume;

    const voices =
      synth.getVoices();

    /*
     * ----------------------------------------------------
     * Indian English voice selection
     * ----------------------------------------------------
     */

    const indianVoices =
      voices.filter((voice) =>
        voice.lang
          .toLowerCase()
          .startsWith("en-in"),
      );

    let selectedVoice =
      indianVoices.find(
        (voice) =>
          /female|heera|neerja|priya|rani|swara|india/i.test(
            voice.name,
          ),
      );

    if (!selectedVoice) {
      selectedVoice =
        indianVoices.find(
          (voice) =>
            /google|microsoft/i.test(
              voice.name,
            ),
        );
    }

    if (!selectedVoice) {
      selectedVoice =
        indianVoices[0];
    }

    if (selectedVoice) {
      utterance.voice =
        selectedVoice;

      console.log(
        "[audio] 🇮🇳 Indian English voice:",
        selectedVoice.name,
        selectedVoice.lang,
      );
    } else {
      console.warn(
        "[audio] No en-IN voice available.",
      );
    }

    console.log(
      "[audio] TTS start:",
      text,
    );

    /*
     * ----------------------------------------------------
     * WAIT FOR REAL SPEECH COMPLETION
     * ----------------------------------------------------
     */

    await new Promise<void>(
      (resolve) => {
        let finished = false;

        const finish = () => {
          if (finished) {
            return;
          }

          finished = true;

          console.log(
            "[audio] TTS finished:",
            text,
          );

          resolve();
        };

        utterance.onend =
          finish;

        utterance.onerror =
          (event) => {
            console.warn(
              "[audio] TTS error:",
              event.error,
            );

            /*
             * Do not hang the renderer
             * if Chrome gives an error.
             */
            finish();
          };

        /*
         * Generous safety timeout.
         *
         * This is NOT used as the normal
         * synchronization mechanism.
         */
        const safetyTimeout =
          Math.max(
            15000,
            text.length * 180,
          );

        window.setTimeout(
          finish,
          safetyTimeout,
        );

        synth.speak(
          utterance,
        );
      },
    );
  }

  /* -----------------------------------------------------------------------
   * WAIT FOR SPEECH
   * --------------------------------------------------------------------- */

  waitForSpeechEnd(
    timeoutMs = 10000,
  ): Promise<void> {
    if (
      typeof window === "undefined" ||
      !("speechSynthesis" in window)
    ) {
      return Promise.resolve();
    }

    return new Promise<void>(
      (resolve) => {
        const start =
          performance.now();

        const check = () => {
          if (
            !window.speechSynthesis
              .speaking
          ) {
            resolve();
            return;
          }

          if (
            performance.now() -
              start >=
            timeoutMs
          ) {
            resolve();
            return;
          }

          window.setTimeout(
            check,
            50,
          );
        };

        check();
      },
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

  /* -----------------------------------------------------------------------
   * DISPOSE
   * --------------------------------------------------------------------- */

  dispose() {
    this.stopMusic();

    this.stopSpeech();

    this.stopNarrationCapture();

    void this.ctx?.close();

    this.ctx = null;
  }
}