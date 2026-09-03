import { KokoroTTS } from "kokoro-js";

/**
 * Change this to switch which Hugging Face repo the model loads from, or
 * point it at a path under your own /public folder (e.g. "/models/kokoro")
 * if you've self-hosted the weights and want zero network dependency even
 * on first run. See kokoro-js / @huggingface/transformers docs for
 * `env.localModelPath` / `env.allowRemoteModels` if you go that route.
 */
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/**
 * Closest available voice to the app's live-preview Indian-English female
 * voice — Kokoro has no en-IN pack, so this is a British-English female as
 * the nearest fit. Swap freely; run `listOfflineVoices()` to see all
 * options (af_*, am_*, bf_*, bm_*, and other-language prefixes).
 */
const DEFAULT_VOICE = "bf_emma";

export interface OfflineTtsResult {
  /** Mono 32-bit float PCM samples. */
  pcm: Float32Array;
  sampleRate: number;
}

export class OfflineTtsError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "OfflineTtsError";
  }
}

let ttsPromise: Promise<KokoroTTS> | null = null;

/**
 * Lazily loads the WASM TTS model once and reuses it for every narration
 * line in the export. Runs entirely client-side (WASM via ONNX Runtime
 * Web) — no per-line network calls, no API key, no server involved.
 */
function loadModel(): Promise<KokoroTTS> {
  if (!ttsPromise) {
    ttsPromise = KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: "q8", // quantized: good quality, much smaller download than fp32
    }).catch((err) => {
      // Don't cache a failed load forever — allow retry on next call.
      ttsPromise = null;
      throw new OfflineTtsError(
        "Failed to load the offline narration model (WASM/ONNX Runtime may be unsupported " +
          "in this browser, or the model failed to download).",
        err
      );
    });
  }

  return ttsPromise;
}

/**
 * Synthesizes `text` fully offline and returns the raw audio samples
 * directly — no playback, no capture, no speakers involved at any point.
 * Kokoro's pipeline is a deterministic forward pass (no sampling loop), so
 * the same text + voice always produces the same audio, independent of
 * machine speed.
 */
export async function synthesizeOffline(
  text: string,
  voice: string = DEFAULT_VOICE
): Promise<OfflineTtsResult> {
  if (!text.trim()) {
    return { pcm: new Float32Array(0), sampleRate: 24000 };
  }

  let tts: KokoroTTS;
  try {
    tts = await loadModel();
  } catch (err) {
    if (err instanceof OfflineTtsError) throw err;
    throw new OfflineTtsError("Failed to load the offline narration model.", err);
  }

  try {
    const audio = await tts.generate(text, { voice });

    const pcm =
      audio.audio instanceof Float32Array ? audio.audio : new Float32Array(audio.audio);

    return { pcm, sampleRate: audio.sampling_rate };
  } catch (err) {
    throw new OfflineTtsError(
      `Offline narration synthesis failed for the line: "${text.slice(0, 60)}${
        text.length > 60 ? "…" : ""
      }"`,
      err
    );
  }
}

export async function listOfflineVoices(): Promise<string[]> {
  const tts = await loadModel();
  const voices = tts.list_voices?.();
  if (!voices) return [];
  return Array.isArray(voices) ? voices : Object.keys(voices);
}