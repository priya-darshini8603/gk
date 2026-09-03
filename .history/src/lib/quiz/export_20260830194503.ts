import { drawFrame } from "./renderer";
import { getState, type Beat, type Timeline } from "./timeline";
import type { AudioSettings, Quiz } from "./types";
import type { AudioEngine, SfxName } from "./audio";
import {
  synthSfxTrack,
  synthMusicNote,
  mixInto,
  MUSIC_NOTES,
  MUSIC_STEP_SECONDS,
} from "./audio";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";

export type RenderStage =
  | "Preparing animation..."
  | "Animating character..."
  | "Adding voice..."
  | "Finalizing MP4..."
  | "Done";

export interface RenderProgress {
  stage: RenderStage;
  percent: number;
}

/* ---------------------------------------------------------------------------
 * CONSTANTS
 * ------------------------------------------------------------------------- */

const FPS = 30;
const FRAME_DURATION_US = Math.round(1_000_000 / FPS);
const KEYFRAME_INTERVAL_FRAMES = FPS * 2;
const AUDIO_CHUNK_FRAMES = 1024;

/* ---------------------------------------------------------------------------
 * SMALL HELPERS
 * ------------------------------------------------------------------------- */

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForEncoderRoom(
  encoder: { encodeQueueSize: number },
  high = 30,
  low = 15,
) {
  if (encoder.encodeQueueSize <= high) return;

  await new Promise<void>((resolve) => {
    const check = () => {
      if (encoder.encodeQueueSize <= low) resolve();
      else setTimeout(check, 10);
    };
    check();
  });
}

async function resolveVideoConfig(
  width: number,
  height: number,
): Promise<VideoEncoderConfig> {
  const candidates = [
    "avc1.640034",
    "avc1.640028",
    "avc1.4d0034",
    "avc1.42003e",
    "avc1.42001f",
  ];

  for (const codec of candidates) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate: 8_000_000,
      framerate: FPS,
    };

    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return support.config ?? config;
    } catch {
      // try next candidate
    }
  }

  throw new Error(
    "This browser's WebCodecs implementation can't encode H.264 video. Please use a recent desktop Chrome or Edge.",
  );
}

async function resolveAudioConfig(sampleRate: number): Promise<AudioEncoderConfig> {
  const config: AudioEncoderConfig = {
    codec: "mp4a.40.2",
    sampleRate,
    numberOfChannels: 1,
    bitrate: 128_000,
  };

  const support = await AudioEncoder.isConfigSupported(config);

  if (!support.supported) {
    throw new Error(
      "This browser's WebCodecs implementation can't encode AAC audio. Please use a recent desktop Chrome or Edge.",
    );
  }

  return support.config ?? config;
}

/** Which SFX a non-speech beat fires, and at what offset (seconds) from its own start. */
function fixedBeatSfxEvents(beat: Beat): { name: SfxName; at: number }[] {
  switch (beat.kind) {
    case "question-in":
      return [{ name: "board", at: 0 }];

    case "options-in":
      return [0, 0.22, 0.44, 0.66].map((at) => ({ name: "pop" as SfxName, at }));

    case "countdown": {
      const seconds = Math.max(1, Math.round(beat.dur));
      return Array.from({ length: seconds }, (_, i) => ({
        name: (i === seconds - 1 ? "final" : "tick") as SfxName,
        at: i,
      }));
    }

    case "celebrate":
      return [{ name: "cheer", at: 0 }];

    default:
      return [];
  }
}

/**
 * Synthesize a non-speech beat's full audio (SFX + any background music
 * ticking through it) directly into a Float32Array — no real-time wait.
 * `musicStartSample` is this beat's absolute position on the continuous
 * music clock, used so notes stay evenly spaced across beat boundaries.
 */
function synthesizeBeatAudio(
  beat: Beat,
  sampleRate: number,
  audioSettings: AudioSettings,
  musicStartSample: number,
): Float32Array {
  const len = Math.max(1, Math.round(beat.dur * sampleRate));
  const seg = new Float32Array(len);

  const muted = audioSettings.muted;
  const sfxGain = muted ? 0 : audioSettings.sfxVolume;
  const musicGain = muted || !audioSettings.music ? 0 : audioSettings.musicVolume * 0.35;

  if (sfxGain > 0) {
    for (const ev of fixedBeatSfxEvents(beat)) {
      const tone = synthSfxTrack(ev.name, sampleRate, sfxGain);
      mixInto(seg, tone, Math.round(ev.at * sampleRate));
    }
  }

  if (musicGain > 0) {
    const stepSamples = MUSIC_STEP_SECONDS * sampleRate;
    // Notes land at (k+1)*step on the global clock, matching the live
    // setInterval(..., 420) behavior (first tick fires after the delay).
    const firstK = Math.max(0, Math.floor(musicStartSample / stepSamples) - 1);
    for (let k = firstK; ; k++) {
      const noteSample = Math.round((k + 1) * stepSamples);
      if (noteSample >= musicStartSample + len) break;
      if (noteSample < musicStartSample) continue;
      const freq = MUSIC_NOTES[k % MUSIC_NOTES.length]!;
      const note = synthMusicNote(sampleRate, freq, musicGain);
      mixInto(seg, note, noteSample - musicStartSample);
    }
  }

  return seg;
}

/* ---------------------------------------------------------------------------
 * RENDER VIDEO
 *
 * Speech beats are unavoidably real-time: SpeechSynthesis only exposes a
 * played-back stream (captured via tab audio), never a buffer, so we still
 * wait out actual narration and capture it live, beat by beat.
 *
 * Non-speech beats (pop-ins, countdown, celebration...) have no such
 * constraint — their SFX/music are just short deterministic waveforms, so
 * they're synthesized directly into the PCM track with synthesizeBeatAudio()
 * and cost zero wall-clock time. This is usually 40-50% of a quiz video's
 * total duration, so skipping it is the single biggest export speedup
 * available without switching narration to a non-browser TTS engine.
 *
 * Frame generation is unchanged: exactly round(duration * FPS) frames per
 * beat, sampled at each frame's exact timestamp, queued on a background
 * chain that runs in beat order and overlaps with the next beat's work.
 * ------------------------------------------------------------------------- */

export async function renderVideo(opts: {
  quiz: Quiz;
  timeline: Timeline;
  width: number;
  height: number;
  audio: AudioEngine;
  audioSettings: AudioSettings;
  onProgress: (progress: RenderProgress) => void;
  signal?: { cancelled: boolean };
}): Promise<{ blob: Blob; extension: string }> {
  const { quiz, timeline, width, height, audio, audioSettings, onProgress } = opts;

  if (
    typeof VideoEncoder === "undefined" ||
    typeof AudioEncoder === "undefined" ||
    typeof VideoFrame === "undefined" ||
    typeof AudioData === "undefined"
  ) {
    throw new Error(
      "This browser doesn't support the WebCodecs API needed for export. Please use a recent desktop Chrome or Edge.",
    );
  }

  /* -----------------------------------------------------------------------
   * PREPARE
   * --------------------------------------------------------------------- */

  onProgress({ stage: "Preparing animation...", percent: 2 });

  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : document.createElement("canvas");

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;

  if (!ctx) {
    throw new Error("Canvas is not available in this browser.");
  }

  /* -----------------------------------------------------------------------
   * AUDIO SETUP (context only — capture happens per speech-beat below)
   * --------------------------------------------------------------------- */

  onProgress({ stage: "Adding voice...", percent: 3 });

  const narrationOk = await audio.captureNarration();
  console.log("[export] Narration capture:", narrationOk);

  const audioCtx = audio.ensure();
  if (!audioCtx) {
    throw new Error("This browser doesn't support the Web Audio API.");
  }
  audio.apply(audioSettings);

  const sampleRate = audioCtx.sampleRate;

  /* -----------------------------------------------------------------------
   * ENCODERS + MUXER
   * --------------------------------------------------------------------- */

  const videoConfig = await resolveVideoConfig(width, height);
  const audioConfig = await resolveAudioConfig(sampleRate);

  const muxerTarget = new ArrayBufferTarget();

  const muxer = new Muxer({
    target: muxerTarget,
    video: { codec: "avc", width, height },
    audio: {
      codec: "aac",
      numberOfChannels: audioConfig.numberOfChannels,
      sampleRate: audioConfig.sampleRate,
    },
    fastStart: "in-memory",
  });

  let videoEncoderError: Error | null = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      videoEncoderError = e;
      console.error("[export] video encoder error:", e);
    },
  });
  videoEncoder.configure(videoConfig);

  let audioEncoderError: Error | null = null;
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => {
      audioEncoderError = e;
      console.error("[export] audio encoder error:", e);
    },
  });
  audioEncoder.configure(audioConfig);

  /* -----------------------------------------------------------------------
   * RUNTIME TIMELINE
   * --------------------------------------------------------------------- */

  const runtimeBeats: Beat[] = timeline.beats.map((b) => ({ ...b }));
  const runtimeTimeline: Timeline = {
    beats: runtimeBeats,
    duration: 0,
    seed: timeline.seed,
  };

  const runKey = Math.random();

  const encodeBeatFrames = async (fromSeconds: number, toSeconds: number) => {
    const firstFrame = Math.round(fromSeconds * FPS);
    const lastFrameExclusive = Math.round(toSeconds * FPS);

    for (let frame = firstFrame; frame < lastFrameExclusive; frame++) {
      if (opts.signal?.cancelled) return;

      const t = frame / FPS;

      drawFrame(ctx, quiz, getState(runtimeTimeline, quiz, t), width, height, runKey);

      const timestamp = frame * FRAME_DURATION_US;

      const videoFrame = new VideoFrame(canvas as CanvasImageSource, {
        timestamp,
        duration: FRAME_DURATION_US,
      });

      videoEncoder.encode(videoFrame, {
        keyFrame: frame % KEYFRAME_INTERVAL_FRAMES === 0,
      });

      videoFrame.close();

      await waitForEncoderRoom(videoEncoder);
    }
  };

  let frameChain: Promise<void> = Promise.resolve();
  const enqueueBeatFrames = (fromSeconds: number, toSeconds: number) => {
    frameChain = frameChain.then(() => encodeBeatFrames(fromSeconds, toSeconds));
  };

  /* -----------------------------------------------------------------------
   * PROCESS EVERY BEAT EXACTLY ONCE, IN ORDER
   *
   * Speech beats: real-time wait + live capture (unavoidable).
   * Non-speech beats: instant offline synthesis, zero wait.
   * --------------------------------------------------------------------- */

  onProgress({ stage: "Animating character...", percent: 6 });

  const total = timeline.beats.length;
  let cursor = 0;
  let musicPhaseSamples = 0;
  const audioChunks: Float32Array[] = [];

  for (let index = 0; index < total; index++) {
    const plannedBeat = timeline.beats[index];
    const beat = runtimeBeats[index];

    if (!plannedBeat || !beat) continue;
    if (opts.signal?.cancelled) break;

    beat.start = cursor;

    const percent = 6 + Math.round((index / total) * 88);

    if (beat.say) {
      onProgress({ stage: "Adding voice...", percent });

      const estimatedFallbackDur = beat.dur;

      await audio.startPcmCapture();

      if (beat.kind === "reveal") {
        audio.sfx("correct", 0.25);
        audio.sfx("confetti", 0.45);
      }

      const spokenSeconds = await audio.speak(beat.say, quiz.language, audioSettings);

      if (beat.kind === "read-question") audio.sfx("board", 0);
      if (beat.kind === "read-option") audio.sfx("point", 0);

      let actualDur = Math.max(0.25, spokenSeconds > 0 ? spokenSeconds : estimatedFallbackDur);

      const minBeatTail = beat.kind === "reveal" ? 0.45 + 0.5 : 0;
      if (minBeatTail > actualDur) {
        await wait((minBeatTail - actualDur) * 1000);
        actualDur = minBeatTail;
      }

      // Let the AudioWorklet flush its last postMessage batch before reading it.
      await wait(30);

      const { samples } = audio.stopPcmCapture();

      beat.dur = actualDur;

      const neededSamples = Math.max(1, Math.round(actualDur * sampleRate));
      const chunk = new Float32Array(neededSamples);
      chunk.set(samples.subarray(0, Math.min(samples.length, neededSamples)));
      audioChunks.push(chunk);
      musicPhaseSamples += neededSamples;

      console.log(
        "[export] Speech beat actual duration:",
        beat.kind,
        actualDur.toFixed(2) + "s",
        spokenSeconds > 0 ? "(measured)" : "(fallback estimate)",
      );
    } else {
      onProgress({ stage: "Animating character...", percent });

      const seg = synthesizeBeatAudio(beat, sampleRate, audioSettings, musicPhaseSamples);
      audioChunks.push(seg);
      musicPhaseSamples += seg.length;
      // No real-time wait here — this is the speedup.
    }

    enqueueBeatFrames(cursor, cursor + beat.dur);
    cursor += beat.dur;
  }

  await frameChain;

  runtimeTimeline.duration = cursor;

  /* -----------------------------------------------------------------------
   * AUDIO: ENCODE THE ASSEMBLED PCM TRACK
   * --------------------------------------------------------------------- */

  onProgress({ stage: "Finalizing MP4...", percent: 93 });

  const totalSamples = audioChunks.reduce((s, c) => s + c.length, 0);
  const alignedSamples = new Float32Array(totalSamples);
  let writeOffset = 0;
  for (const chunk of audioChunks) {
    alignedSamples.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }

  for (let offset = 0; offset < totalSamples; offset += AUDIO_CHUNK_FRAMES) {
    if (opts.signal?.cancelled) break;

    const len = Math.min(AUDIO_CHUNK_FRAMES, totalSamples - offset);
    const data = alignedSamples.slice(offset, offset + len);

    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfFrames: len,
      numberOfChannels: 1,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data,
    });

    audioEncoder.encode(audioData);
    audioData.close();

    await waitForEncoderRoom(audioEncoder);
  }

  /* -----------------------------------------------------------------------
   * FINALIZE
   * --------------------------------------------------------------------- */

  await videoEncoder.flush();
  await audioEncoder.flush();

  if (videoEncoderError) throw videoEncoderError;
  if (audioEncoderError) throw audioEncoderError;

  muxer.finalize();

  const blob = new Blob([muxerTarget.buffer], { type: "video/mp4" });

  onProgress({ stage: "Done", percent: 100 });

  return { blob, extension: "mp4" };
}

/* ---------------------------------------------------------------------------
 * DOWNLOAD
 * ------------------------------------------------------------------------- */

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");

  a.href = url;
  a.download = filename;

  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 4000);
}