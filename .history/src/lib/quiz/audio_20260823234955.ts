import { LANGUAGE_LOCALES, VOICE_TUNING, type AudioSettings, type Language } from "./types";
import type { Cue } from "./timeline";

/* Web Audio SFX + music bed, plus TTS narration. */

export type SfxName = NonNullable<Cue["sfx"]>;

// ---------------------------------------------------------------------------
// meSpeak loading
//
// IMPORTANT: mespeak's npm package (`import meSpeak from "mespeak"`) pulls in
// a legacy asm.js file (ESpeak.js) that contains raw non-UTF-8 bytes in its
// string literals. That's fine for a plain <script> tag in a browser, but it
// crashes strict bundler parsers (Vite/Rolldown, and eventually esbuild too)
// with "stream did not contain valid UTF-8" — no optimizeDeps setting fixes
// that, since it's a genuine parse failure, not an optimizer quirk.
//
// The fix: never let Vite touch mespeak's source at all. We load the
// browser-ready build via a runtime-injected <script> tag instead, which
// bypasses the bundler's module graph entirely, then talk to it through the
// `window.meSpeak` global it sets up itself.
//
// FOR PRODUCTION: don't depend on a live GitHub branch ref forever. Download
// these three things once and self-host them under /public/mespeak/, then
// point MESPEAK_BASE at "/mespeak" instead:
//   - mespeak.js
//   - mespeak_config.json
//   - voices/<lang>/<lang>.json for every language you support
// ---------------------------------------------------------------------------

const MESPEAK_BASE = "https://cdn.jsdelivr.net/gh/foxdog-studios/meSpeak@master";

/**
 * Maps the primary subtag of each LANGUAGE_LOCALES value (e.g. "en" from
 * "en-US") to its meSpeak voice file. Verify this against your actual
 * LANGUAGE_LOCALES — add/remove entries so every language you support has a
 * real file. Missing languages fall back to English rather than throwing.
 */
const MESPEAK_VOICE_PATH: Record<string, string> = {
  en: "voices/en/en.json",
  hi: "voices/hi/hi.json",
  es: "voices/es/es.json",
  fr: "voices/fr/fr.json",
  de: "voices/de/de.json",
  it: "voices/it/it.json",
  pt: "voices/pt/pt.json",
  ru: "voices/ru/ru.json",
  ar: "voices/ar/ar.json",
  zh: "voices/zh/zh.json",
  ja: "voices/ja/ja.json",
  ko: "voices/ko/ko.json",
};

type MeSpeak = {
  loadConfig: (config: string, cb?: (success: boolean) => void) => void;
  loadVoice: (voice: string, cb?: (success: boolean) => void) => void;
  speak: (text: string, opts: Record<string, unknown>) => Uint8Array;
};

function loadScriptOnce(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-mespeak-src="${src}"]`);
    if (existing) {
      if ((window as unknown as { meSpeak?: MeSpeak }).meSpeak) resolve();
      else existing.addEventListener("load", () => resolve(), { once: true });
      return;
    }
    const el = document.createElement("script");
    el.src = src;
    el.dataset.mespeakSrc = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`[audio] Failed to load mespeak script from ${src}`));
    document.head.appendChild(el);
  });
}

let enginePromise: Promise<MeSpeak> | null = null;
function ensureEngine(): Promise<MeSpeak> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (!enginePromise) {
    enginePromise = loadScriptOnce(`${MESPEAK_BASE}/mespeak.js`).then(
      () =>
        new Promise<MeSpeak>((resolve, reject) => {
          const ms = (window as unknown as { meSpeak?: MeSpeak }).meSpeak;
          if (!ms) {
            reject(new Error("[audio] mespeak.js loaded but window.meSpeak was not set"));
            return;
          }
          let settled = false;
          const done = (ok: boolean) => {
            if (settled) return;
            settled = true;
            ok ? resolve(ms) : reject(new Error("[audio] mespeak.loadConfig failed"));
          };
          // Safety net: fall back to "assume ready" if the callback form
          // isn't honored the way we expect on this build.
          const timer = window.setTimeout(() => done(true), 4000);
          ms.loadConfig(`${MESPEAK_BASE}/mespeak_config.json`, (ok) => {
            window.clearTimeout(timer);
            done(ok);
          });
        }),
    );
  }
  return enginePromise;
}

const loadedVoices = new Set<string>();
async function ensureVoiceLoaded(locale: string): Promise<MeSpeak> {
  const ms = await ensureEngine();
  const lang2 = locale.split("-")[0]!.toLowerCase();
  const path = MESPEAK_VOICE_PATH[lang2] ?? MESPEAK_VOICE_PATH.en!;
  if (loadedVoices.has(path)) return ms;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (ok) {
        loadedVoices.add(path);
        resolve();
      } else {
        reject(new Error(`[audio] Failed to load mespeak voice: ${path}`));
      }
    };
    const timer = window.setTimeout(() => done(true), 4000);
    ms.loadVoice(`${MESPEAK_BASE}/${path}`, (ok) => {
      window.clearTimeout(timer);
      done(ok);
    });
  });
  return ms;
}

/** Rough tuning translation from VOICE_TUNING (pitch/rate meant for
 * SpeechSynthesisUtterance) into meSpeak's 0-99 pitch and words-per-minute
 * speed scale. Adjust the multipliers to taste once you hear it. */
function toMeSpeakParams(tune: { pitch: number; rate: number }) {
  const pitch = Math.max(0, Math.min(99, Math.round(tune.pitch * 50)));
  const speed = Math.max(80, Math.min(320, Math.round(tune.rate * 175)));
  return { pitch, speed };
}

async function synthesizeWav(text: string, language: Language, settings: AudioSettings): Promise<ArrayBuffer> {
  const locale = LANGUAGE_LOCALES[language];
  const ms = await ensureVoiceLoaded(locale);
  const tune = VOICE_TUNING[settings.voice];
  const { pitch, speed } = toMeSpeakParams(tune);
  const bytes = ms.speak(text, { rawdata: "array", amplitude: 100, pitch, speed, wordgap: 2 });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// ---------------------------------------------------------------------------

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

  /** Kept for API compatibility with export.ts / CsvBatchPanel.tsx. Narration
   * no longer depends on tab-audio capture — it's synthesized directly into
   * the same AudioContext graph as SFX/music — so this just ensures the
   * context exists. No permission prompt, works everywhere. */
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
   * Synthesizes `text` to an AudioBuffer and plays it through voiceGain — a
   * real AudioBufferSourceNode in the same graph as your SFX/music, so it's
   * picked up by `dest` (and therefore MediaRecorder) automatically. Resolves
   * once playback genuinely finishes.
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

  /** Fire-and-forget variant for the interactive preview (QuizPlayer), which
   * can seek/scrub and needs to cut off whatever's currently playing. */
  speak(text: string, language: Language, settings: AudioSettings) {
    this.activeVoiceSource?.stop();
    this.activeVoiceSource = null;
    void this.speakAndWait(text, language, settings);
  }

  stopSpeech() {
    this.activeVoiceSource?.stop();
    this.activeVoiceSource = null;
  }

  /** Legacy no-op — completion is now awaited directly via
   * speakAndWait()'s AudioBufferSourceNode.onended. */
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