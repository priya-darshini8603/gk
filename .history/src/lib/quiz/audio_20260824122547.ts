import { LANGUAGE_LOCALES, VOICE_TUNING, type AudioSettings, type Language } from "./types";
import type { Cue } from "./timeline";

/* Web Audio SFX + music bed, plus speech synthesis narration. */

export type SfxName = NonNullable<Cue["sfx"]>;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private voiceGain: GainNode | null = null; // NEW: dedicated bus for captured narration
  private musicTimer: number | null = null;
  private musicStep = 0;
  dest: MediaStreamAudioDestinationNode | null = null;

  // NEW: tab-audio capture used to route SpeechSynthesis output into the graph.
  private captureStream: MediaStream | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureAttempted = false;
  private captureReady: Promise<boolean> | null = null;

  // NEW: lets callers (and index.tsx's useEffect) check without touching internals.
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
   * Captures this tab's own audio output (which is where SpeechSynthesisUtterance
   * actually plays) and routes it into the mixer as a real, connectable
   * MediaStreamAudioSourceNode. This is the only piece that was structurally
   * missing: SpeechSynthesis has no AudioNode of its own, so without this
   * capture step there is no way to get narration into `dest`/MediaRecorder
   * at all, no matter how the rest of the graph is wired.
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
        // video:true is required by the spec for getDisplayMedia even though we
        // only want audio; preferCurrentTab keeps the picker to "this tab" so it
        // reliably includes SpeechSynthesis output. We drop the video track
        // immediately — canvas.captureStream() remains the actual video source.
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
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
   * Speaks `text`. This still uses SpeechSynthesisUtterance (no AI API), but
   * now that captureNarration() has wired a MediaStreamAudioSourceNode into
   * voiceGain -> dest, whatever this utterance plays to the tab's output is
   * also flowing into the recording destination. If capture was never granted,
   * this still plays audibly (live preview keeps working) but won't be in the
   * recorded file — logged clearly so it's never a silent failure.
   */
  speak(text: string, language: Language, settings: AudioSettings) {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      console.warn("[audio] speechSynthesis unsupported in this browser.");
      return;
    }
    if (settings.muted || settings.voiceVolume <= 0) return;

    if (this.captureAttempted && !this.captureSource) {
      console.warn("[audio] Speaking, but narration capture is not connected — this utterance will NOT be in the recorded video.");
    }

    const u = new SpeechSynthesisUtterance(text);
    const tune = VOICE_TUNING[settings.voice];
    const locale = LANGUAGE_LOCALES[language];
    u.lang = locale;
    u.pitch = tune.pitch;
    u.rate = tune.rate;
    u.volume = settings.voiceVolume;
    
    console.log(`[audio] TTS start: "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}" (captured: ${!!this.captureSource})`);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  /** Await the currently-queued utterance(s) finishing — used by the renderer for tighter sync. */
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