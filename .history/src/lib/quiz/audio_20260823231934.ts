import { LANGUAGE_LOCALES, VOICE_TUNING, type AudioSettings, type Language } from "./types";
import type { Cue } from "./timeline";

/* Web Audio SFX + music bed, plus speech synthesis narration. */

export type SfxName = NonNullable<Cue["sfx"]>;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private voiceGain: GainNode | null = null; // dedicated bus for captured narration
  private musicTimer: number | null = null;
  private musicStep = 0;
  dest: MediaStreamAudioDestinationNode | null = null;

  // tab-audio capture used to route SpeechSynthesis output into the graph.
  private captureStream: MediaStream | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureAttempted = false;
  private captureReady: Promise<boolean> | null = null;

  get hasContext() {
    return this.ctx !== null;
  }

  get hasNarrationCapture() {
    return this.captureSource !== null;
  }

  ensure() {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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
      // voiceGain is NOT connected to ctx.destination — the captured tab stream
      // already contains the sound the browser is playing to speakers via
      // speechSynthesis, so routing it to ctx.destination too would double it.
      // It only feeds the recording destination.
      this.voiceGain.connect(this.dest);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  apply(settings: AudioSettings) {
    this.ensure();
    if (!this.sfxGain || !this.musicGain || !this.voiceGain) return;
    const m = settings.muted ? 0 : 1;
    this.sfxGain.gain.value = settings.sfxVolume * m;
    this.musicGain.gain.value = (settings.music ? settings.musicVolume * 0.35 : 0) * m;
    this.voiceGain.gain.value = settings.voiceVolume * m;
  }

  /**
   * MUST be called from inside a user-gesture handler (Play / Render click).
   * Captures this tab's own audio output and routes it into the mixer as a
   * real, connectable MediaStreamAudioSourceNode. This is the only piece
   * that gets SpeechSynthesis audio into `dest`/MediaRecorder at all — but
   * see pickVoice() below: it only works reliably for *remote* voices.
   *
   * Idempotent: subsequent calls reuse the existing capture. Resolves `false`
   * (and logs) if the browser lacks support or the user declines the prompt —
   * callers should treat that as "SFX-only export" and warn the user, not throw.
   */
  async captureNarration(): Promise<boolean> {
    const ctx = this.ensure();
    if (!ctx) return false;
    if (this.captureSource) return true; // already wired up
    if (this.captureReady) return this.captureReady; // in-flight

    this.captureReady = (async () => {
      this.captureAttempted = true;
      if (!navigator.mediaDevices?.getDisplayMedia) {
        console.warn("[audio] getDisplayMedia unsupported — narration cannot be recorded in this browser (Chrome/Edge only).");
        return false;
      }
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
          // @ts-expect-error -- Chrome-only extension, not yet in lib.dom types
          preferCurrentTab: true,
          selfBrowserSurface: "include",
        } as DisplayMediaStreamOptions);

        stream.getVideoTracks().forEach((track) => track.stop());
        const audioTracks = stream.getAudioTracks();
        if (!audioTracks.length) {
          console.warn("[audio] Tab capture granted but returned no audio track (user may have unchecked 'Share tab audio').");
          stream.getTracks().forEach((t) => t.stop());
          return false;
        }

        this.captureStream = new MediaStream(audioTracks);
        this.captureSource = ctx.createMediaStreamSource(this.captureStream);
        this.captureSource.connect(this.voiceGain!);
        console.log("[audio] Narration capture connected. Tracks:", audioTracks.length);
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
   * Voices load asynchronously in most browsers — getVoices() can return an
   * empty array for a few hundred ms after page load. Waiting for this once
   * before scheduling any narration prevents speakAndWait() from silently
   * falling back to a default (often local/uncapturable) voice on the very
   * first cue of an export.
   */
  async waitForVoicesLoaded(timeoutMs = 3000): Promise<SpeechSynthesisVoice[]> {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
    const synth = window.speechSynthesis;
    const existing = synth.getVoices();
    if (existing.length) return existing;
    return new Promise((resolve) => {
      const onVoices = () => {
        const voices = synth.getVoices();
        if (voices.length) {
          window.clearTimeout(timer);
          synth.removeEventListener("voiceschanged", onVoices);
          resolve(voices);
        }
      };
      const timer = window.setTimeout(() => {
        synth.removeEventListener("voiceschanged", onVoices);
        resolve(synth.getVoices());
      }, timeoutMs);
      synth.addEventListener("voiceschanged", onVoices);
    });
  }

  /**
   * Picks the best voice for `locale`.
   *
   * ROOT CAUSE OF THE MISSING EXPORT AUDIO: Chrome only routes "remote"
   * (network) voices — voice.localService === false, e.g. "Google US
   * English" — through the tab's own audio pipeline. That pipeline is the
   * only thing getDisplayMedia's tab-capture can see. Voices with
   * localService === true are handed off to the OS's native TTS engine and
   * play directly to the system output, bypassing the tab's audio graph
   * entirely. Preview always sounds fine either way (it just plays to your
   * speakers), which is exactly why the bug only showed up in the exported
   * file. We therefore prefer a remote voice whenever one exists, and flag
   * loudly when we can't find one.
   */
  private pickVoice(locale: string): { voice: SpeechSynthesisVoice | null; capturable: boolean } {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return { voice: null, capturable: false };
    const voices = window.speechSynthesis.getVoices();
    const lang2 = locale.split("-")[0]!;
    const localeMatches = voices.filter((v) => v.lang === locale || v.lang.startsWith(lang2));
    const pool = localeMatches.length ? localeMatches : voices;
    const remote = pool.find((v) => v.localService === false);
    const chosen = remote ?? pool[0] ?? null;
    return { voice: chosen, capturable: !!remote };
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain = 0.5, delay = 0, slideTo?: number) {
    const ctx = this.ensure();
    if (!ctx || !this.sfxGain) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
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
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
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
        [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.28, "triangle", 0.36, i * 0.09));
        break;
      case "confetti":
        this.noise(0.5, 0.18);
        break;
      case "cheer":
        [784, 988, 1175].forEach((f, i) => this.tone(f, 0.5, "sine", 0.24, i * 0.12));
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
   * Fire-and-forget speech for the INTERACTIVE PREVIEW only (QuizPlayer).
   * Cancels any in-flight utterance first, since the user can seek/scrub the
   * timeline and overlapping utterances there would sound broken. Do NOT use
   * this for export — use speakAndWait() instead, which is what actually
   * guarantees narration lands in the recorded file.
   */
  speak(text: string, language: Language, settings: AudioSettings) {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      console.warn("[audio] speechSynthesis unsupported in this browser.");
      return;
    }
    if (settings.muted || settings.voiceVolume <= 0) return;

    const u = new SpeechSynthesisUtterance(text);
    const tune = VOICE_TUNING[settings.voice];
    const locale = LANGUAGE_LOCALES[language];
    u.lang = locale;
    u.pitch = tune.pitch;
    u.rate = tune.rate;
    u.volume = settings.voiceVolume;
    const { voice: match, capturable } = this.pickVoice(locale);
    if (match) u.voice = match;

    if (this.captureAttempted && !capturable) {
      console.warn("[audio] Selected voice is local/OS-only — its audio is not routed through the tab and will be missing from a recorded export.");
    }
    if (this.captureAttempted && !this.captureSource) {
      console.warn("[audio] Speaking, but narration capture is not connected — this utterance will NOT be in the recorded video.");
    }

    console.log(`[audio] TTS start: "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}" (captured: ${!!this.captureSource})`);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  /**
   * EXPORT-SAFE narration. Speaks `text` and resolves only once the
   * utterance has genuinely finished (via its real `end`/`error` event),
   * instead of firing-and-forgetting against an *estimated* duration. This
   * is what fixes truncated/missing narration in the recorded file: the
   * exporter awaits this per cue and holds the recording's timeline at the
   * current beat until the full line has actually been synthesized and
   * captured, however long real synthesis actually takes.
   *
   * Deliberately does NOT call speechSynthesis.cancel() first — it's meant
   * to be awaited one cue at a time by the exporter, so nothing should ever
   * be in flight when it starts, and cancelling here would risk killing a
   * still-finishing previous utterance under real-world timing jitter.
   */
  speakAndWait(text: string, language: Language, settings: AudioSettings): Promise<void> {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return Promise.resolve();
    if (settings.muted || settings.voiceVolume <= 0) return Promise.resolve();

    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const tune = VOICE_TUNING[settings.voice];
      const locale = LANGUAGE_LOCALES[language];
      u.lang = locale;
      u.pitch = tune.pitch;
      u.rate = tune.rate;
      u.volume = settings.voiceVolume;
      const { voice: match, capturable } = this.pickVoice(locale);
      if (match) u.voice = match;

      if (this.captureAttempted && !capturable) {
        console.warn(
          `[audio] "${text.slice(0, 30)}…" is using a local/OS voice with no capturable audio path — it will be missing from the exported file. Pick a network voice (any voice labelled "Google …" in your OS/browser voice settings) for exports.`,
        );
      }
      if (this.captureAttempted && !this.captureSource) {
        console.warn(`[audio] Narration capture is not connected — "${text.slice(0, 30)}…" will not be in the recorded video.`);
      }

      // Safety net: some browsers occasionally drop the `end` event (e.g. if
      // the tab loses focus mid-utterance). Cap the wait at a generous
      // multiple of the estimated speaking time so one stuck utterance can
      // never hang the whole export.
      const estimateSec = Math.max(1.4, Math.min(7, text.split(/\s+/).length * 0.42 + 0.9));
      const timeout = window.setTimeout(() => {
        cleanup();
        console.warn(`[audio] Timed out waiting for narration to finish: "${text.slice(0, 30)}…"`);
        resolve();
      }, (estimateSec + 4) * 1000);

      const cleanup = () => {
        window.clearTimeout(timeout);
        u.removeEventListener("end", onEnd);
        u.removeEventListener("error", onEnd);
      };
      const onEnd = () => {
        cleanup();
        resolve();
      };
      u.addEventListener("end", onEnd);
      u.addEventListener("error", onEnd);

      console.log(
        `[audio] TTS start (awaited): "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}" (captured: ${!!this.captureSource}, capturable voice: ${capturable})`,
      );
      window.speechSynthesis.speak(u);
    });
  }

  /** Legacy helper kept for compatibility; export.ts no longer needs this
   * since speakAndWait() already guarantees per-cue completion. */
  waitForSpeechEnd(timeoutMs = 8000): Promise<void> {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return Promise.resolve();
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
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  dispose() {
    this.stopMusic();
    this.stopSpeech();
    this.stopNarrationCapture();
    void this.ctx?.close();
    this.ctx = null;
  }
}