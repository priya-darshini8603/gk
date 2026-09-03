import { LANGUAGE_LOCALES, VOICE_TUNING, type AudioSettings, type Language } from "./types";
import type { Cue } from "./timeline";

/* Web Audio SFX + music bed + BUFFER-BASED narration (routed into the same mixer). */

export type SfxName = NonNullable<Cue["sfx"]>;

declare global {
  interface Window {
    meSpeak?: {
      loadConfig: (url: string) => void;
      loadVoice: (url: string, cb?: (success: boolean) => void) => void;
      isConfigLoaded: () => boolean;
      isVoiceLoaded: (voiceId: string) => boolean;
      speak: (text: string, opts: Record<string, unknown>) => Uint8Array | null;
    };
  }
}

// Maps our app's Language enum -> meSpeak voice ids.
// NOTE: verify/replace the non-English entries against meSpeak's actual voice
// bundle before shipping — eSpeak's Indic-language coverage is limited and
// these are best-effort fallbacks.
const MESPEAK_VOICE: Record<Language, string> = {
  English: "en/en-us",
  Hindi: "hi",
  Tamil: "en/en-us", // fallback — replace if/when a ta voice file is available
  Kannada: "en/en-us", // fallback
  Telugu: "en/en-us", // fallback
  Malayalam: "en/en-us", // fallback
};

const MESPEAK_BASE = "https://cdnjs.cloudflare.com/ajax/libs/mespeak/2.0.2";

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private voiceGain: GainNode | null = null; // NEW: narration bus, mixed same as sfx/music
  private musicTimer: number | null = null;
  private musicStep = 0;
  dest: MediaStreamAudioDestinationNode | null = null;

  // --- TTS state -----------------------------------------------------------
  private meSpeakReady: Promise<void> | null = null;
  private loadedVoices = new Set<string>();
  private bufferCache = new Map<string, AudioBuffer>();
  private activeVoiceSources = new Set<AudioBufferSourceNode>();

  ensure() {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      this.sfxGain = this.ctx.createGain();
      this.musicGain = this.ctx.createGain();
      this.voiceGain = this.ctx.createGain(); // NEW
      this.dest = this.ctx.createMediaStreamDestination();
      // Every audible source (sfx, music, voice) fans into BOTH the speakers
      // (ctx.destination, for live preview) and the MediaStreamDestination
      // (this.dest, which is what gets captured by MediaRecorder). This is
      // the "masterGain -> destination" fan-out from the required architecture.
      for (const g of [this.sfxGain, this.musicGain, this.voiceGain]) {
        g.connect(this.ctx.destination);
        g.connect(this.dest);
      }
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

  // ---------------------------------------------------------------------
  // TTS: replaces the old speechSynthesis-based speak(). This produces a
  // real AudioBuffer that gets routed through voiceGain -> (speakers + dest),
  // instead of playing to the OS output device where it can't be captured.
  // ---------------------------------------------------------------------

  private loadMeSpeak(): Promise<void> {
    if (this.meSpeakReady) return this.meSpeakReady;
    this.meSpeakReady = new Promise((resolve, reject) => {
      if (typeof window === "undefined") return reject(new Error("no window"));
      if (window.meSpeak) {
        if (!window.meSpeak.isConfigLoaded()) {
          window.meSpeak.loadConfig(`${MESPEAK_BASE}/mespeak_config.json`);
        }
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = `${MESPEAK_BASE}/mespeak.full.js`;
      script.onload = () => {
        window.meSpeak?.loadConfig(`${MESPEAK_BASE}/mespeak_config.json`);
        resolve();
      };
      script.onerror = () => reject(new Error("Failed to load meSpeak"));
      document.head.appendChild(script);
    });
    return this.meSpeakReady;
  }

  private async loadVoice(voiceId: string): Promise<void> {
    if (this.loadedVoices.has(voiceId)) return;
    await this.loadMeSpeak();
    const meSpeak = window.meSpeak!;
    if (meSpeak.isVoiceLoaded(voiceId)) {
      this.loadedVoices.add(voiceId);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      meSpeak.loadVoice(`${MESPEAK_BASE}/voices/${voiceId}.json`, (success) => {
        if (success) {
          this.loadedVoices.add(voiceId);
          resolve();
        } else {
          reject(new Error(`Failed to load voice: ${voiceId}`));
        }
      });
    });
  }

  private cacheKey(text: string, language: Language, settings: AudioSettings) {
    return `${language}::${settings.voice}::${text}`;
  }

  /**
   * Generates (or returns cached) narration audio as a decoded AudioBuffer.
   * Does NOT play it — call playSpeech() for that, once this has resolved.
   */
  async synthesize(text: string, language: Language, settings: AudioSettings): Promise<AudioBuffer | null> {
    const ctx = this.ensure();
    if (!ctx) return null;

    const key = this.cacheKey(text, language, settings);
    const cached = this.bufferCache.get(key);
    if (cached) return cached;

    try {
      await this.loadMeSpeak();
      const voiceId = MESPEAK_VOICE[language] ?? "en/en-us";
      await this.loadVoice(voiceId);

      const tune = VOICE_TUNING[settings.voice];
      const raw = window.meSpeak!.speak(text, {
        rawdata: "array",
        speed: Math.round(175 * tune.rate), // words/min
        pitch: Math.max(0, Math.min(99, Math.round(50 * tune.pitch))),
        voice: voiceId,
      });

      console.log(`[TTS] generated: ${raw ? "YES" : "NO"} (${text.slice(0, 40)}...)`);
      if (!raw) return null;

      const arrayBuffer = new Uint8Array(raw).buffer;
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      console.log(`[TTS] decoded: YES, duration ${audioBuffer.duration.toFixed(2)}s`);

      this.bufferCache.set(key, audioBuffer);
      return audioBuffer;
    } catch (err) {
      console.error("[TTS] synthesis failed for:", text, err);
      return null;
    }
  }

  /**
   * Pre-generates AudioBuffers for every "say" cue in a timeline. MUST be
   * awaited before recording/playback starts — decoding is async, and
   * playback must be gapless once the render/preview clock is running.
   */
  async prepareNarration(cues: Pick<Cue, "text">[], language: Language, settings: AudioSettings): Promise<void> {
    const texts = Array.from(new Set(cues.map((c) => c.text).filter((t): t is string => !!t)));
    for (const text of texts) {
      await this.synthesize(text, language, settings);
    }
  }

  /**
   * Plays a PRE-GENERATED narration buffer through voiceGain (same mixer as
   * SFX/music), so it reaches both the speakers and dest.stream (recorded).
   * Buffer must already be cached via synthesize()/prepareNarration().
   */
  playSpeech(text: string, language: Language, settings: AudioSettings) {
    const ctx = this.ensure();
    if (!ctx || !this.voiceGain) return;
    if (settings.muted || settings.voiceVolume <= 0) return;

    const key = this.cacheKey(text, language, settings);
    const buffer = this.bufferCache.get(key);
    if (!buffer) {
      console.warn("[TTS] no buffer ready for cue (was prepareNarration awaited?):", text);
      return;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.voiceGain);
    this.activeVoiceSources.add(source);
    source.onended = () => this.activeVoiceSources.delete(source);
    source.start();
    console.log(`[TTS] connected to mixer: YES, playing "${text.slice(0, 30)}..."`);
  }

  stopSpeech() {
    for (const source of this.activeVoiceSources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    this.activeVoiceSources.clear();
  }

  dispose() {
    this.stopMusic();
    this.stopSpeech();
    void this.ctx?.close();
    this.ctx = null;
  }
}