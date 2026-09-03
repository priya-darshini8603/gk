import {
  LANGUAGE_LOCALES,
  VOICE_TUNING,
  type AudioSettings,
  type Language,
} from "./types";

import type { Cue } from "./timeline";

export type SfxName = NonNullable<Cue["sfx"]>;

export class AudioEngine {
  private ctx: AudioContext | null = null;

  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private voiceGain: GainNode | null = null;

  private musicTimer: number | null = null;
  private musicStep = 0;

  dest: MediaStreamAudioDestinationNode | null = null;

  private captureStream: MediaStream | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureAttempted = false;
  private captureReady: Promise<boolean> | null = null;

  private voicesReady: Promise<void> | null = null;

  constructor() {
    this.prepareVoices();
  }

  /* =========================================================
   * VOICES
   * ======================================================= */

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

    this.voicesReady = new Promise<void>(
      (resolve) => {
        const synth =
          window.speechSynthesis;

        const voices =
          synth.getVoices();

        if (voices.length > 0) {
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
      },
    );

    return this.voicesReady;
  }

  get hasContext() {
    return this.ctx !== null;
  }

  get hasNarrationCapture() {
    return this.captureSource !== null;
  }

  /* =========================================================
   * AUDIO CONTEXT
   * ======================================================= */

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

      this.ctx =
        new Ctor();

      this.sfxGain =
        this.ctx.createGain();

      this.musicGain =
        this.ctx.createGain();

      this.voiceGain =
        this.ctx.createGain();

      this.dest =
        this.ctx.createMediaStreamDestination();

      /*
       * SFX + music:
       * speakers + recording
       */
      this.sfxGain.connect(
        this.ctx.destination,
      );

      this.sfxGain.connect(
        this.dest,
      );

      this.musicGain.connect(
        this.ctx.destination,
      );

      this.musicGain.connect(
        this.dest,
      );

      /*
       * Voice:
       * recording destination
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

  /* =========================================================
   * SETTINGS
   * ======================================================= */

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
      settings.muted
        ? 0
        : 1;

    this.sfxGain.gain.value =
      settings.sfxVolume *
      multiplier;

    this.musicGain.gain.value =
      (
        settings.music
          ? settings.musicVolume *
            0.35
          : 0
      ) *
      multiplier;

    this.voiceGain.gain.value =
      settings.voiceVolume *
      multiplier;
  }

  /* =========================================================
   * NARRATION CAPTURE
   * ======================================================= */

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
                preferCurrentTab:
                  true,
                selfBrowserSurface:
                  "include",
              } as DisplayMediaStreamOptions,
            );

          stream
            .getVideoTracks()
            .forEach(
              (track) =>
                track.stop(),
            );

          const audioTracks =
            stream.getAudioTracks();

          if (
            audioTracks.length === 0
          ) {
            console.warn(
              "[audio] No tab audio track.",
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
            "[audio] Narration capture failed:",
            error,
          );

          return false;
        }
      })();

    return this.captureReady;
  }

  stopNarrationCapture() {
    this.captureSource?.disconnect();

    this.captureSource =
      null;

    this.captureStream
      ?.getTracks()
      .forEach(
        (track) =>
          track.stop(),
      );

    this.captureStream =
      null;

    this.captureReady =
      null;
  }

  /* =========================================================
   * TONE
   * ======================================================= */

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

    const start =
      ctx.currentTime +
      delay;

    const oscillator =
      ctx.createOscillator();

    const gainNode =
      ctx.createGain();

    oscillator.type =
      type;

    oscillator.frequency.setValueAtTime(
      freq,
      start,
    );

    if (slideTo) {
      oscillator.frequency.exponentialRampToValueAtTime(
        slideTo,
        start + dur,
      );
    }

    gainNode.gain.setValueAtTime(
      0.0001,
      start,
    );

    gainNode.gain.exponentialRampToValueAtTime(
      gain,
      start + 0.012,
    );

    gainNode.gain.exponentialRampToValueAtTime(
      0.0001,
      start + dur,
    );

    oscillator
      .connect(gainNode)
      .connect(
        this.sfxGain,
      );

    oscillator.start(
      start,
    );

    oscillator.stop(
      start +
        dur +
        0.05,
    );
  }

  /* =========================================================
   * NOISE
   * ======================================================= */

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
        Math.floor(
          ctx.sampleRate *
            dur,
        ),
        ctx.sampleRate,
      );

    const data =
      buffer.getChannelData(
        0,
      );

    for (
      let i = 0;
      i < data.length;
      i++
    ) {
      data[i] =
        (Math.random() * 2 -
          1) *
        (1 -
          i /
            data.length);
    }

    const source =
      ctx.createBufferSource();

    source.buffer =
      buffer;

    const gainNode =
      ctx.createGain();

    gainNode.gain.value =
      gain;

    source
      .connect(gainNode)
      .connect(
        this.sfxGain,
      );

    source.start();
  }

  /* =========================================================
   * SFX
   * ======================================================= */

  sfx(
    name: SfxName,
  ) {
    switch (name) {
      case "board":
        this.tone(
          320,
          0.25,
          "sine",
          0.40,
          0,
          780,
        );
        break;

      case "pop":
        this.tone(
          660,
          0.12,
          "triangle",
          0.38,
          0,
          980,
        );
        break;

      case "point":
        this.tone(
          880,
          0.11,
          "sine",
          0.38,
          0,
          1240,
        );
        break;

      /*
       * COUNTDOWN TICK
       *
       * Louder than before.
       */
      case "tick":
        this.tone(
          900,
          0.12,
          "square",
          0.42,
        );
        break;

      /*
       * COUNTDOWN FINISH
       */
      case "final":
        this.tone(
          880,
          0.18,
          "triangle",
          0.45,
          0,
          1320,
        );

        this.tone(
          1320,
          0.28,
          "sine",
          0.35,
          0.12,
          1760,
        );

        break;

      case "correct":
        [
          523,
          659,
          784,
          1046,
        ].forEach(
          (
            frequency,
            index,
          ) => {
            this.tone(
              frequency,
              0.28,
              "triangle",
              0.36,
              index *
                0.09,
            );
          },
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
          (
            frequency,
            index,
          ) => {
            this.tone(
              frequency,
              0.5,
              "sine",
              0.24,
              index *
                0.12,
            );
          },
        );

        this.noise(
          0.7,
          0.1,
        );

        break;
    }
  }

  /* =========================================================
   * MUSIC
   * ======================================================= */

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

          const start =
            this.ctx.currentTime;

          const oscillator =
            this.ctx.createOscillator();

          const gain =
            this.ctx.createGain();

          oscillator.type =
            "triangle";

          oscillator.frequency.value =
            frequency;

          gain.gain.setValueAtTime(
            0.0001,
            start,
          );

          gain.gain.exponentialRampToValueAtTime(
            0.18,
            start + 0.05,
          );

          gain.gain.exponentialRampToValueAtTime(
            0.0001,
            start + 0.42,
          );

          oscillator
            .connect(gain)
            .connect(
              this.musicGain,
            );

          oscillator.start(
            start,
          );

          oscillator.stop(
            start + 0.5,
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

      this.musicTimer =
        null;
    }
  }

  /* =========================================================
   * SPEECH
   *
   * IMPORTANT:
   * Promise resolves ONLY after onend.
   * ======================================================= */

  async speak(
    text: string,
    language: Language,
    settings: AudioSettings,
  ): Promise<void> {
    if (
      typeof window ===
        "undefined" ||
      !(
        "speechSynthesis" in
        window
      )
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
     * Stop any previous utterance.
     */
    synth.cancel();

    await new Promise<void>(
      (resolve) => {
        window.setTimeout(
          resolve,
          60,
        );
      },
    );

    const utterance =
      new SpeechSynthesisUtterance(
        text,
      );

    const tuning =
      VOICE_TUNING[
        settings.voice
      ];

    const configuredLocale =
      LANGUAGE_LOCALES[
        language
      ];

    utterance.lang =
      configuredLocale
        ?.toLowerCase()
        .startsWith("en")
        ? "en-IN"
        : configuredLocale;

    utterance.pitch =
      tuning.pitch;

    utterance.rate =
      tuning.rate;

    utterance.volume =
      settings.voiceVolume;

    const voices =
      synth.getVoices();

    const indianVoices =
      voices.filter(
        (voice) =>
          voice.lang
            .toLowerCase()
            .startsWith(
              "en-in",
            ),
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
        "[audio] Voice:",
        selectedVoice.name,
        selectedVoice.lang,
      );
    }

    console.log(
      "[audio] Speech START:",
      text,
    );

    await new Promise<void>(
      (resolve) => {
        let completed =
          false;

        let safetyTimer:
          number | null =
          null;

        const finish = () => {
          if (completed) {
            return;
          }

          completed =
            true;

          if (
            safetyTimer !==
            null
          ) {
            clearTimeout(
              safetyTimer,
            );
          }

          console.log(
            "[audio] Speech END:",
            text,
          );

          resolve();
        };

        utterance.onend =
          finish;

        utterance.onerror =
          (event) => {
            console.warn(
              "[audio] Speech error:",
              event.error,
            );

            finish();
          };

        /*
         * Safety timeout only.
         *
         * Normal completion always happens
         * through onend.
         */
        safetyTimer =
          window.setTimeout(
            finish,
            Math.max(
              15000,
              text.length *
                220,
            ),
          );

        synth.speak(
          utterance,
        );
      },
    );
  }

  /* =========================================================
   * WAIT FOR SPEECH
   * ======================================================= */

  waitForSpeechEnd(
    timeoutMs = 10000,
  ): Promise<void> {
    if (
      typeof window ===
        "undefined" ||
      !(
        "speechSynthesis" in
        window
      )
    ) {
      return Promise.resolve();
    }

    return new Promise<void>(
      (resolve) => {
        const start =
          performance.now();

        const check =
          () => {
            if (
              !window
                .speechSynthesis
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

  /* =========================================================
   * STOP
   * ======================================================= */

  stopSpeech() {
    if (
      typeof window !==
        "undefined" &&
      "speechSynthesis" in
        window
    ) {
      window.speechSynthesis.cancel();
    }
  }

  /* =========================================================
   * DISPOSE
   * ======================================================= */

  dispose() {
    this.stopMusic();

    this.stopSpeech();

    this.stopNarrationCapture();

    void this.ctx?.close();

    this.ctx =
      null;
  }
}