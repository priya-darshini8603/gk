import { LANGUAGE_LOCALES, VOICE_TUNING, type AudioSettings, type Language } from "./types";
import type { Cue } from "./timeline";

/* Web Audio SFX + music bed, plus speech synthesis narration. */

export type SfxName = NonNullable<Cue["sfx"]>;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicTimer: number | null = null;
  private musicStep = 0;
  dest: MediaStreamAudioDestinationNode | null = null;

  ensure() {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      this.sfxGain = this.ctx.createGain();
      this.musicGain = this.ctx.createGain();
      this.dest = this.ctx.createMediaStreamDestination();
      for (const g of [this.sfxGain, this.musicGain]) {
        g.connect(this.ctx.destination);
        g.connect(this.dest);
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  apply(settings: AudioSettings) {
    this.ensure();
    if (!this.sfxGain || !this.musicGain) return;
    const m = settings.muted ? 0 : 1;
    this.sfxGain.gain.value = settings.sfxVolume * m;
    this.musicGain.gain.value = (settings.music ? settings.musicVolume * 0.35 : 0) * m;
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

  speak(text: string, language: Language, settings: AudioSettings) {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    if (settings.muted || settings.voiceVolume <= 0) return;
    const u = new SpeechSynthesisUtterance(text);
    const tune = VOICE_TUNING[settings.voice];
    const locale = LANGUAGE_LOCALES[language];
    u.lang = locale;
    u.pitch = tune.pitch;
    u.rate = tune.rate;
    u.volume = settings.voiceVolume;
    const voices = window.speechSynthesis.getVoices();
    const match =
      voices.find((v) => v.lang === locale) ??
      voices.find((v) => v.lang.startsWith(locale.split("-")[0]!));
    if (match) u.voice = match;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  stopSpeech() {
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  dispose() {
    this.stopMusic();
    this.stopSpeech();
    void this.ctx?.close();
    this.ctx = null;
  }
}
