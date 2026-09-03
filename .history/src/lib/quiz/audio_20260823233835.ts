import meSpeak from "mespeak";
// @ts-expect-error -- JSON asset, resolveJsonModule/Vite JSON import
import mespeakConfig from "mespeak/src/mespeak_config.json";
import { LANGUAGE_LOCALES, VOICE_TUNING, type AudioSettings, type Language } from "./types";
import type { Cue } from "./timeline";

/* Web Audio SFX + music bed, plus TTS narration. */

export type SfxName = NonNullable<Cue["sfx"]>;

/**
 * meSpeak ships one JSON voice file per language under mespeak/voices/**.
 * We only know your app's LANGUAGE_LOCALES values at build time via
 * ./types, so this maps the *primary* subtag of each locale (e.g. "en" from
 * "en-US") to the matching voice file meSpeak needs to load.
 *
 * IMPORTANT: verify this list against your actual LANGUAGE_LOCALES — add or
 * remove entries so every language you support has a real file under
 * node_modules/mespeak/voices/. Unmapped/missing languages fall back to
 * English rather than throwing, so a quiz will always render audio, but you
 * should fill in a correct mapping for anything used in production.
 */
const MESPEAK_VOICE_PATH: Record<string, string> = {
  en: "mespeak/voices/en/en.json",
  hi: "mespeak/voices/hi/hi.json",
  es: "mespeak/voices/es/es.json",
  fr: "mespeak/voices/fr/fr.json",
  de: "mespeak/voices/de/de.json",
  it: "mespeak/voices/it/it.json",
  pt: "mespeak/voices/pt/pt.json",
  ru: "mespeak/voices/ru/ru.json",
  ar: "mespeak/voices/ar/ar.json",
  zh: "mespeak/voices/zh/zh.json",
  ja: "mespeak/voices/ja/ja.json",
  ko: "mespeak/voices/ko/ko.json",
};

const loadedVoices = new Set<string>();
let configLoaded = false;

async function ensureVoiceLoaded(locale: string): Promise<string> {
  const lang2 = locale.split("-")[0]!.toLowerCase();
  const path = MESPEAK_VOICE_PATH[lang2] ?? MESPEAK_VOICE_PATH.en!;

  if (!configLoaded) {
    meSpeak.loadConfig(mespeakConfig);
    configLoaded = true;
  }
  if (!loadedVoices.has(path)) {
    // Dynamic import so we only ever ship/parse the voice packs actually
    // used by a given quiz's language, instead of bundling every language.
    const mod = await import(/* @vite-ignore */ path);
    meSpeak.loadVoice(mod.default ?? mod);
    loadedVoices.add(path);
  }
  return lang2;
}

/** Rough tuning translation from your existing VOICE_TUNING (pitch/rate meant
 * for SpeechSynthesisUtterance) into meSpeak's 0-99 pitch and words-per-minute
 * speed scale. Adjust the multipliers to taste once you hear it. */
function toMeSpeakParams(tune: { pitch: number; rate: number }) {
  const pitch = Math.max(0, Math.min(99, Math.round(tune.pitch * 50)));
  const speed = Math.max(80, Math.min(320, Math.round(tune.rate * 175)));
  return { pitch, speed };
}

async function synthesizeWav(text: string, language: Language, settings: AudioSettings): Promise<ArrayBuffer> {
  const locale = LANGUAGE_LOCALES[language];
  await ensureVoiceLoaded(locale);
  const tune = VOICE_TUNING[settings.voice];
  const { pitch, speed } = toMeSpeakParams(tune);
  const bytes: Uint8Array = meSpeak.speak(text, {
    rawdata: "array",
    amplitude: 100,
    pitch,
    speed,
    wordgap: 2,
  });
  // Copy into a plain ArrayBuffer slice so decodeAudioData gets a clean
  // buffer regardless of the source TypedArray's byteOffset.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private voiceGain: GainNode | null = null;
  private musicTimer: number | null = null;
  private musicStep = 0;
  dest: MediaStreamAudioDestinationNode | null = null;

  private activeVoiceSource: AudioBufferSourceNode | null = null;

  get hasContext() {
    return this.ctx !== null;
  }

  /**
   * Kept for API compatibility with export.ts / CsvBatchPanel.tsx, which
   * still call `await audio.captureNarration()` before rendering. Narration
   * no longer depends on tab-audio capture at all — it's synthesized
   * directly into the same AudioContext graph as SFX/music, so this just
   * makes sure the context exists and always reports success. No
   * permission prompt, no browser restriction, works everywhere.
   */
  get hasNarrationCapture() {
    return this.ctx !== null;
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
      // All three buses are real WebAudio nodes now, so all three connect to
      // both the speakers (live preview) and the recording destination
      // (`dest`) the same way — no more special-casing narration.
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

  /** No-op kept for call-site compatibility (see hasNarrationCapture above). */
  async captureNarration(): Promise<boolean> {
    const ctx = this.ensure();
    return ctx !== null;
  }

  /** No-op kept for call-site compatibility. */
  stopNarrationCapture() {
    // nothing to tear down anymore
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
   * Synthesizes `text` to an AudioBuffer and plays it through voiceGain.
   * Because this is a real AudioBufferSourceNode in the same graph as your
   * SFX/music, it is picked up by `dest` (and therefore MediaRecorder)
   * automatically — no tab-capture, no permission dialog, no dependency on
   * which OS/voice engine is installed. This is what actually fixes the
   * "SFX-only export" bug: SpeechSynthesis audio structurally never reached
   * the tab's capturable audio group in Chromium, regardless of voice type,
   * so no amount of capture-permission or voice-selection tuning could have
   * worked. Synthesizing our own buffer sidesteps the problem entirely.
   */
  async speakAndWait(text: string, language: Language, settings: AudioSettings): Promise<void> {
    if (settings.muted || settings.voiceVolume <= 0) return;
    const ctx = this.ensure();
    if (!ctx || !this.voiceGain) return;

    let audioBuffer: AudioBuffer;
    try {
      const wav = await synthesizeWav(text, language, settings);
      audioBuffer = await ctx.decodeAudioData(wav);
    } catch (err) {
      console.warn(`[audio] Failed to synthesize/decode narration: "${text.slice(0, 30)}…"`, err);
      return;
    }

    return new Promise((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(this.voiceGain!);
      src.onended = () => resolve();
      this.activeVoiceSource = src;
      console.log(`[audio] Narration playing (synthesized, ${audioBuffer.duration.toFixed(2)}s): "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}"`);
      src.start();
    });
  }

  /**
   * Fire-and-forget variant for the interactive preview (QuizPlayer), which
   * can seek/scrub and needs to cut off whatever's currently playing rather
   * than queue behind it.
   */
  speak(text: string, language: Language, settings: AudioSettings) {
    this.activeVoiceSource?.stop();
    this.activeVoiceSource = null;
    void this.speakAndWait(text, language, settings);
  }

  stopSpeech() {
    this.activeVoiceSource?.stop();
    this.activeVoiceSource = null;
  }

  /** Legacy no-op kept for compatibility — playback completion is now
   * awaited directly via speakAndWait()'s AudioBufferSourceNode.onended. */
  waitForSpeechEnd(): Promise<void> {
    return Promise.resolve();
  }

  dispose() {
    this.stopMusic();
    this.stopSpeech();
    void this.ctx?.close();
    this.ctx = null;
  }
}