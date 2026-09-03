import { LANGUAGE_LOCALES, type AudioSettings, type Language, type VoiceKind } from "./types";

export type Cue =
  | "board-pop"
  | "option-pop"
  | "point"
  | "tick"
  | "final-tick"
  | "correct"
  | "confetti"
  | "celebrate"
  | "whoosh";

const VOICE_PITCH: Record<VoiceKind, number> = {
  "Cute Child": 1.6,
  "Friendly Female": 1.2,
  "Friendly Male": 0.8,
  Teacher: 1,
};

/** Web-Audio engine: SFX + music + a capturable "babble" voice track. */
export class QuizAudio {
  ctx: AudioContext;
  master: GainNode;
  voiceGain: GainNode;
  musicGain: GainNode;
  sfxGain: GainNode;
  dest?: MediaStreamAudioDestinationNode;
  private musicTimer: number | null = null;
  private musicStep = 0;
  private settings: AudioSettings;
  private speakNodes: OscillatorNode[] = [];
  private useSpeechSynthesis: boolean;

  constructor(settings: AudioSettings, opts: { capture?: boolean; speech?: boolean } = {}) {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();
    this.settings = settings;
    this.useSpeechSynthesis = opts.speech !== false && typeof window.speechSynthesis !== "undefined";
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);
    if (opts.capture) {
      this.dest = this.ctx.createMediaStreamDestination();
      this.master.connect(this.dest);
    }
    this.voiceGain = this.ctx.createGain();
    this.musicGain = this.ctx.createGain();
    this.sfxGain = this.ctx.createGain();
    for (const g of [this.voiceGain, this.musicGain, this.sfxGain]) g.connect(this.master);
    this.applySettings(settings);
  }

  applySettings(s: AudioSettings) {
    this.settings = s;
    this.voiceGain.gain.value = s.voiceVolume;
    this.musicGain.gain.value = s.musicOn ? s.musicVolume * 0.35 : 0;
    this.sfxGain.gain.value = s.sfxVolume;
  }

  resume() {
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  private blip(
    freq: number,
    dur: number,
    type: OscillatorType,
    gainNode: GainNode,
    volume = 0.3,
    slideTo?: number,
  ) {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(volume, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(gainNode);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  cue(kind: Cue) {
    this.resume();
    switch (kind) {
      case "board-pop":
        this.blip(320, 0.35, "triangle", this.sfxGain, 0.4, 720);
        break;
      case "option-pop":
        this.blip(520, 0.18, "sine", this.sfxGain, 0.32, 880);
        break;
      case "point":
        this.blip(880, 0.1, "square", this.sfxGain, 0.14);
        break;
      case "tick":
        this.blip(660, 0.12, "square", this.sfxGain, 0.2);
        break;
      case "final-tick":
        this.blip(300, 0.4, "sawtooth", this.sfxGain, 0.28, 150);
        break;
      case "correct":
        [523, 659, 784, 1046].forEach((f, i) =>
          window.setTimeout(() => this.blip(f, 0.35, "triangle", this.sfxGain, 0.32), i * 90),
        );
        break;
      case "confetti":
        this.blip(1200, 0.5, "sine", this.sfxGain, 0.18, 300);
        break;
      case "celebrate":
        [784, 880, 988, 1175, 1318].forEach((f, i) =>
          window.setTimeout(() => this.blip(f, 0.3, "square", this.sfxGain, 0.16), i * 110),
        );
        break;
      case "whoosh":
        this.blip(160, 0.4, "sine", this.sfxGain, 0.2, 620);
        break;
    }
  }

  /** Narration. Uses real TTS when available, always plays a capturable babble track. */
  speak(text: string, language: Language, durationHint: number) {
    this.resume();
    this.stopSpeaking();
    const pitch = VOICE_PITCH[this.settings.voice];

    if (this.useSpeechSynthesis) {
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = LANGUAGE_LOCALES[language];
        u.pitch = Math.min(2, pitch);
        u.rate = this.settings.voice === "Teacher" ? 0.92 : 1;
        u.volume = this.settings.voiceVolume;
        const match = window.speechSynthesis
          .getVoices()
          .find((v) => v.lang?.toLowerCase().startsWith(LANGUAGE_LOCALES[language].slice(0, 2)));
        if (match) u.voice = match;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } catch {
        /* ignore */
      }
    } else {
      // capturable synthetic voice babble (used for MP4 render)
      const words = text.split(/\s+/).filter(Boolean);
      const per = Math.max(0.16, durationHint / Math.max(1, words.length));
      words.forEach((w, i) => {
        const t = this.ctx.currentTime + i * per;
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = "triangle";
        const base = 210 * pitch + (w.length % 5) * 22;
        osc.frequency.setValueAtTime(base, t);
        osc.frequency.linearRampToValueAtTime(base * 1.12, t + per * 0.4);
        osc.frequency.linearRampToValueAtTime(base * 0.92, t + per * 0.75);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.22, t + 0.03);
        g.gain.linearRampToValueAtTime(0.0001, t + per * 0.72);
        osc.connect(g).connect(this.voiceGain);
        osc.start(t);
        osc.stop(t + per);
        this.speakNodes.push(osc);
      });
    }
  }

  stopSpeaking() {
    if (this.useSpeechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    }
    for (const n of this.speakNodes) {
      try {
        n.stop();
      } catch {
        /* ignore */
      }
    }
    this.speakNodes = [];
  }

  startMusic() {
    if (this.musicTimer != null) return;
    const notes = [392, 494, 587, 659, 587, 494, 440, 523];
    this.musicTimer = window.setInterval(() => {
      if (!this.settings.musicOn) return;
      const f = notes[this.musicStep % notes.length]!;
      this.blip(f, 0.4, "sine", this.musicGain, 0.5);
      if (this.musicStep % 4 === 0) this.blip(f / 2, 0.5, "triangle", this.musicGain, 0.35);
      this.musicStep++;
    }, 320);
  }

  stopMusic() {
    if (this.musicTimer != null) {
      window.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  dispose() {
    this.stopMusic();
    this.stopSpeaking();
    void this.ctx.close();
  }
}