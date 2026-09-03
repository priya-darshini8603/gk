import { drawFrame } from "./renderer";
import { getState, type Beat, type Timeline } from "./timeline";
import type { AudioSettings, Quiz } from "./types";
import type { AudioEngine } from "./audio";
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
const KEYFRAME_INTERVAL_FRAMES = FPS * 2; // one keyframe every ~2s
const AUDIO_CHUNK_FRAMES = 1024;

/* ---------------------------------------------------------------------------
 * SMALL HELPERS
 * ------------------------------------------------------------------------- */

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Back off if the encoder's internal queue is getting deep. Purely a
 *  memory/wall-clock-time concern — never affects which frames come out. */
async function waitForEncoderRoom(
  encoder: { encodeQueueSize: number },
  high = 30,
  low = 15
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
  height: number
): Promise<VideoEncoderConfig> {
  const candidates = [
    "avc1.640034", // High @ 5.2 — generous headroom for 1080p+
    "avc1.640028", // High @ 4.0
    "avc1.4d0034",
    "avc1.42003e",
    "avc1.42001f", // Baseline @ 3.1 — broadest hardware support fallback
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
      // try the next candidate
    }
  }

  throw new Error(
    "This browser's WebCodecs implementation can't encode H.264 video. Please use a recent desktop Chrome or Edge."
  );
}

async function resolveAudioConfig(
  sampleRate: number
): Promise<AudioEncoderConfig> {
  const config: AudioEncoderConfig = {
    codec: "mp4a.40.2", // AAC-LC
    sampleRate,
    numberOfChannels: 1,
    bitrate: 128_000,
  };

  const support = await AudioEncoder.isConfigSupported(config);

  if (!support.supported) {
    throw new Error(
      "This browser's WebCodecs implementation can't encode AAC audio. Please use a recent desktop Chrome or Edge."
    );
  }

  return support.config ?? config;
}

/**
 * SFX for fixed-duration (non-speech) beats, scheduled on the Web Audio
 * clock up front instead of polled from a requestAnimationFrame loop.
 * This mirrors the interactive preview's buildCues() timing and, since it
 * runs on the audio thread's own clock, stays sample-accurate no matter
 * how busy the main thread is.
 */
function scheduleFixedBeatSfx(beat: Beat, audio: AudioEngine) {
  switch (beat.kind) {
    case "question-in":
      audio.sfx("board", 0);
      break;

    case "options-in":
      [0, 0.22, 0.44, 0.66].forEach((d) => audio.sfx("pop", d));
      break;

    case "countdown": {
      const seconds = Math.max(1, Math.round(beat.dur));
      for (let i = 0; i < seconds; i++) {
        audio.sfx(i === seconds - 1 ? "final" : "tick", i);
      }
      break;
    }

    case "celebrate":
      audio.sfx("cheer", 0);
      break;

    default:
      break;
  }
}

/* ---------------------------------------------------------------------------
 * RENDER VIDEO
 *
 * Two concerns are deliberately kept independent:
 *
 *  1. TIMING: beats still play out once, in real time, in order — this is
 *     unavoidable because narration duration can only be *measured* by
 *     actually invoking speechSynthesis. Fixed (non-speech) beats simply
 *     wait out their planned duration so any scheduled SFX and narration
 *     playback stay correctly paced.
 *
 *  2. FRAMES: once a beat's real duration is known, we generate exactly
 *     round(duration * FPS) frames for it by sampling getState() at each
 *     frame's exact timestamp and handing VideoEncoder an explicit PTS.
 *     This loop is NOT tied to requestAnimationFrame or wall-clock time —
 *     if the CPU is slow, generating those frames just takes longer, it
 *     can never skip or duplicate one.
 *
 * Frame generation for a finished beat is queued onto a background chain
 * that runs strictly in beat order, so it can overlap with the *next*
 * beat's real-time narration wait — keeping total export time close to
 * just the sum of narration durations, not narration + encode time.
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
  const { quiz, timeline, width, height, audio, audioSettings, onProgress } =
    opts;

  if (
    typeof VideoEncoder === "undefined" ||
    typeof AudioEncoder === "undefined" ||
    typeof VideoFrame === "undefined" ||
    typeof AudioData === "undefined"
  ) {
    throw new Error(
      "This browser doesn't support the WebCodecs API needed for export. Please use a recent desktop Chrome or Edge."
    );
  }

  /* -----------------------------------------------------------------------
   * PREPARE
   * --------------------------------------------------------------------- */

  onProgress({ stage: "Preparing animation...", percent: 2 });

  // This canvas is only ever drawn to synchronously, right before each
  // frame is encoded — never on a rAF/interval loop — so it never races
  // with anything and never represents a "skipped" moment in time.
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
   * NARRATION + AUDIO CAPTURE
   * --------------------------------------------------------------------- */

  onProgress({ stage: "Adding voice...", percent: 3 });

  const narrationOk = await audio.captureNarration();
  console.log("[export] Narration capture:", narrationOk);

  const audioCtx = audio.ensure();
  if (!audioCtx) {
    throw new Error("This browser doesn't support the Web Audio API.");
  }
  audio.apply(audioSettings);

  // Captures music + SFX + narration as raw PCM on the audio thread —
  // immune to main-thread stalls, unlike MediaRecorder+captureStream.
  await audio.startPcmCapture();

  /* -----------------------------------------------------------------------
   * ENCODERS + MUXER
   * --------------------------------------------------------------------- */

  const videoConfig = await resolveVideoConfig(width, height);
  const audioConfig = await resolveAudioConfig(audioCtx.sampleRate);

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

  /** Deterministically render + encode every frame in [fromSeconds, toSeconds). */
  const encodeBeatFrames = async (fromSeconds: number, toSeconds: number) => {
    const firstFrame = Math.round(fromSeconds * FPS);
    const lastFrameExclusive = Math.round(toSeconds * FPS);

    for (let frame = firstFrame; frame < lastFrameExclusive; frame++) {
      if (opts.signal?.cancelled) return;

      const t = frame / FPS;

      drawFrame(
        ctx,
        quiz,
        getState(runtimeTimeline, quiz, t),
        width,
        height,
        runKey
      );

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

  // Frame generation runs in strict beat order but is queued (not
  // awaited) from the main loop below, so it overlaps with the *next*
  // beat's real-time narration wait instead of adding to total time.
  let frameChain: Promise<void> = Promise.resolve();
  const enqueueBeatFrames = (fromSeconds: number, toSeconds: number) => {
    frameChain = frameChain.then(() => encodeBeatFrames(fromSeconds, toSeconds));
  };

  /* -----------------------------------------------------------------------
   * PROCESS EVERY BEAT EXACTLY ONCE, IN ORDER
   * --------------------------------------------------------------------- */

  onProgress({ stage: "Animating character...", percent: 6 });

  const total = timeline.beats.length;
  let cursor = 0;

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

      // Cues timed relative to the beat's start (matches the interactive
      // preview's buildCues()) rather than "whenever narration happened
      // to finish" — scheduled on the audio clock, so timing survives a
      // slow main thread untouched.
      if (beat.kind === "reveal") {
        audio.sfx("correct", 0.25);
        audio.sfx("confetti", 0.45);
      }

      const spokenSeconds = await audio.speak(
        beat.say,
        quiz.language,
        audioSettings
      );

      if (beat.kind === "read-question") audio.sfx("board", 0);
      if (beat.kind === "read-option") audio.sfx("point", 0);

      let actualDur = Math.max(
        0.25,
        spokenSeconds > 0 ? spokenSeconds : estimatedFallbackDur
      );

      // Make sure a beat never ends before its own scheduled SFX tail
      // (e.g. reveal's confetti at +0.45s, ~0.5s long) has had time to
      // play and get captured.
      const minBeatTail = beat.kind === "reveal" ? 0.45 + 0.5 : 0;
      if (minBeatTail > actualDur) {
        await wait((minBeatTail - actualDur) * 1000);
        actualDur = minBeatTail;
      }

      beat.dur = actualDur;

      console.log(
        "[export] Speech beat actual duration:",
        beat.kind,
        actualDur.toFixed(2) + "s",
        spokenSeconds > 0 ? "(measured)" : "(fallback estimate)"
      );
    } else {
      onProgress({ stage: "Animating character...", percent });

      scheduleFixedBeatSfx(beat, audio);

      // Real wall-clock wait so the scheduled SFX (and any concurrent
      // narration/frame-encode work from previous beats) actually play
      // and get captured — inherent to using live TTS, not a rAF hack.
      await wait(beat.dur * 1000);
    }

    enqueueBeatFrames(cursor, cursor + beat.dur);
    cursor += beat.dur;
  }

  // Wait for any still-in-flight frame generation to finish.
  await frameChain;

  runtimeTimeline.duration = cursor;

  /* -----------------------------------------------------------------------
   * AUDIO: ENCODE CAPTURED PCM, ALIGNED TO THE FINAL VIDEO DURATION
   * --------------------------------------------------------------------- */

  onProgress({ stage: "Finalizing MP4...", percent: 93 });

  const { samples, sampleRate } = audio.stopPcmCapture();

  const targetSamples = Math.max(1, Math.round(cursor *