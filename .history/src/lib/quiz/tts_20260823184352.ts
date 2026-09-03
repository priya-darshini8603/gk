import meSpeak from "mespeak";
import mespeakConfig from "mespeak/mespeak_config.json";
import enUsVoice from "mespeak/voices/en/en-us.json";

export interface TtsSegment {
  text: string;
  startSec: number;
}
export interface SynthesizedClip extends TtsSegment {
  blob: Blob;
  mime: string;
  durationSec: number;
}

/**
 * "English" ships inside the npm 'mespeak' package itself, so it's a
 * static import — bundler-resolved at build time. A runtime-computed
 * import() path does NOT work in the browser (that was the previous bug).
 *
 * The other five languages are NOT guaranteed to exist in the npm package.
 * After `npm install mespeak`, run:
 *   ls node_modules/mespeak/voices
 * Whatever you find for Hindi/Tamil/Kannada/Telugu/Malayalam, copy it to
 * `public/mespeak/voices/<name>.json` and it's picked up at runtime below
 * — no rebuild, no bundler involvement, so it can never hit the bare-
 * specifier bug again.
 */
const BUNDLED_VOICES: Partial<Record<string, unknown>> = {
  English: enUsVoice,
};
const REMOTE_VOICE_URL: Partial<Record<string, string>> = {
  Hindi: "/mespeak/voices/hi.json",
  Tamil: "/mespeak/voices/ta.json",
  Kannada: "/mespeak/voices/kn.json",
  Telugu: "/mespeak/voices/te.json",
  Malayalam: "/mespeak/voices/ml.json",
};
const FALLBACK_LANGUAGE = "English";

let configLoaded = false;
function ensureConfig() {
  if (configLoaded) return;
  meSpeak.loadConfig(mespeakConfig);
  configLoaded = meSpeak.isConfigLoaded();
  if (!configLoaded) {
    console.warn("meSpeak.isConfigLoaded() returned false right after loadConfig — synthesis may still fail.");
  }
}

const resolvedVoiceId = new Map<string, string>();
const loadingVoice = new Map<string, Promise<string>>();

/** Object form of loadVoice is documented as synchronous; id comes from getDefaultVoice(). */
function loadBundledVoice(data: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const ok = meSpeak.loadVoice(data);
    if (ok === false) {
      reject(new Error("meSpeak rejected the bundled voice."));
      return;
    }
    resolve(meSpeak.getDefaultVoice());
  });
}

/** URL form is async; callback(success, idOrErrorReason) per meSpeak's README. */
function loadRemoteVoice(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    meSpeak.loadVoice(url, (success: boolean, idOrReason: string) => {
      if (success) resolve(idOrReason);
      else reject(new Error(`Could not load voice file "${url}" (${idOrReason}).`));
    });
  });
}

async function ensureVoice(language: string): Promise<string> {
  ensureConfig();
  if (resolvedVoiceId.has(language)) return resolvedVoiceId.get(language)!;
  if (loadingVoice.has(language)) return loadingVoice.get(language)!;

  const promise = (async () => {
    try {
      if (BUNDLED_VOICES[language]) {
        const id = await loadBundledVoice(BUNDLED_VOICES[language]);
        resolvedVoiceId.set(language, id);
        return id;
      }
      const url = REMOTE_VOICE_URL[language];
      if (!url) throw new Error(`No TTS voice configured for language "${language}".`);
      const id = await loadRemoteVoice(url);
      resolvedVoiceId.set(language, id);
      return id;
    } catch (error) {
      if (language === FALLBACK_LANGUAGE) throw error;
      console.warn(
        `${error instanceof Error ? error.message : "Voice load failed"} — falling back to ${FALLBACK_LANGUAGE} narration.`,
      );
      return ensureVoice(FALLBACK_LANGUAGE);
    }
  })();

  loadingVoice.set(language, promise);
  return promise;
}

export async function getAudioBlobDuration(blob: Blob): Promise<number> {
  const arrayBuffer = await blob.arrayBuffer();
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctor();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    return audioBuffer.duration;
  } finally {
    void ctx.close();
  }
}

function speakToBytes(text: string, voiceId: string): Uint8Array {
  meSpeak.setDefaultVoice(voiceId);
  const bytes = meSpeak.speak(text, { rawdata: "array", speed: 160, pitch: 50, amplitude: 100 }) as unknown as
    | number[]
    | undefined;
  if (!bytes || bytes.length === 0) {
    throw new Error(
      `meSpeak produced no audio for "${text.slice(0, 40)}${text.length > 40 ? "..." : ""}" (voice id: ${voiceId}). Check the browser console for meSpeak's own error output.`,
    );
  }
  return new Uint8Array(bytes);
}

/** Synthesizes every narration line as a real, fully-offline audio Blob. */
export async function synthesizeNarration(
  segments: TtsSegment[],
  language: string,
  onProgress?: (done: number, total: number) => void,
): Promise<SynthesizedClip[]> {
  if (segments.length === 0) return [];
  const voiceId = await ensureVoice(language);
  const clips: SynthesizedClip[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const bytes = speakToBytes(seg.text, voiceId);
    const blob = new Blob([bytes], { type: "audio/wav" });
    const durationSec = await getAudioBlobDuration(blob);
    clips.push({ ...seg, blob, mime: "audio/wav", durationSec });
    onProgress?.(i + 1, segments.length);
  }
  return clips;
}