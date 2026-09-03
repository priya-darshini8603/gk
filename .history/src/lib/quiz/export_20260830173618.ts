import { drawFrame } from "./renderer";
import { getState, type Beat, type Timeline } from "./timeline";
import type { AudioSettings, Quiz } from "./types";
import type { AudioEngine } from "./audio";
import { scheduleSfx } from "./sfxSynth";
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

/* ---------------------------------------------------------------------------
 * OFFLINE SFX RENDERING FOR NON-NARRATED (FIXED) BEATS
 *
 * `enter`, `question-in`, `options-in`, `countdown`, and `celebrate` never
 * contain narration — only short SFX. There is no reason to sit through
 * their full duration in real time just so a live recording worklet can
 * "hear" a beep or a countdown tick: an OfflineAudioContext renders the
 * exact same oscillator graph in effectively zero wall-clock time. This is
 * the main export speed-up — it eliminates a real-time wait of roughly
 * `1.8 + 1.1 + 1.1 + countdown + 2.6` seconds on EVERY rendered video.
 * ------------------------------------------------------------------------- */

async function renderBeatAudioOffline(
  beat: Beat,
  sampleRate: number,
  sfxVolume: number
): Promise<Float32Array> {
  const length = Math.max(1, Math.round(beat.dur * sampleRate));

  // "enter" (and any other fixed beat with no SFX) is pure silence —
  // skip spinning up an OfflineAudioContext for nothing.
  const hasSfx =
    beat.kind === "question-in" ||
    beat.kind === "options-in" ||
    beat.kind === "countdown" ||
    beat.kind === "celebrate";

  if (!hasSfx || sfxVolume <= 0) {
    return new Float32Array(length);
  }

  const offlineCtx = new OfflineAudioContext(1, length, sampleRate);
  const dest = offlineCtx.destination;

  switch (beat.kind) {
    case "question-in":
      scheduleSfx(offlineCtx, dest, "board", 0, sfxVolume);
      break;

    case "options-in":
      [0, 0.22, 0.44, 0.66].forEach((d) =>
        scheduleSfx(offlineCtx, dest, "pop", d, sfxVolume)
      );
      break;

    case "countdown": {
      const seconds = Math.max(1, Math.round(beat.dur));
      for (let i = 0; i < seconds; i++) {
        scheduleSfx(
          offlineCtx,
          dest,
          i === seconds - 1 ? "final" : "tick",
          i,
          sfxVolume
        );
      }
      break;
    }

    case "celebrate":
      scheduleSfx(offlineCtx, dest, "cheer", 0, sfxVolume);
      break;
  }

  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0).slice();
}

/** Real seconds a narrated beat's trailing SFX needs to actually play and
 *  get captured before we snapshot the beat's recorded audio. This is the
 *  only real-time wait left in the whole render, and it's small. */
function narratedBeatTailPad(kind: Beat["kind"]): number {
  switch (kind) {
    case "read-question":
      return 0.35; // trailing "board" ping
    case "read-option":
      return 0.2; // trailing "point" ping
    default:
      return 0;
  }
}

/* ---------------------------------------------------------------------------
 * RENDER VIDEO
 *
 * TIMING: narrated beats still play out once, in real time — this is
 * unavoidable because narration duration can only be *measured* by
 * actually invoking speechSynthesis, and its audio can only be captured by
 * actually letting it play through the tab's audio and grabbing it via
 * `audio.markPcmPosition()` / `audio.extractPcmSince()`. Fixed (non-speech)
 * beats no longer wait at all — their SFX is rendered offline above and
 * spliced directly into the final audio at the right offset.
 *
 * FRAMES: once a beat's real duration is known, we generate exactly
 * round(duration * FPS) frames for it by sampling getState() at each
 * frame's exact timestamp and handing VideoEncoder an explicit PTS. This
 * loop is NOT tied to requestAnimationFrame or wall-clock time — it was
 * already fully decoupled from real time, so it needs no changes.
 *
 * Frame generation for a finished beat is queued onto a background chain
 * that runs strictly in beat order, so it can overlap with the *next*
 * beat's real-time narration wait — keeping total export time close to
 * just the sum of narration durations plus their small tail pads, not
 * narration + fixed-beat waits + encode time.
 * ------------------------------------------------------------------------- */

interface AudioSegment {
  offsetSeconds: number;
  samples: Float32Array;
}

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

  const sampleRate = audioCtx.sampleRate;

  // Captures narration (music + SFX + speech) as raw PCM on the audio
  // thread for narrated beats only — immune to main-thread stalls, unlike
  // MediaRecorder+captureStream. Fixed beats never touch this; their audio
  // is rendered offline instead (see renderBeatAudioOffline above).
  await audio.startPcmCapture();

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
  const audioSegments: AudioSegment[] = [];

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

      // Snapshot the capture position right before speech starts, so we
      // can pull out exactly this beat's audio afterward — independent
      // of how much (or how little) real time any other beat took.
      const pcmMark = audio.markPcmPosition();

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
      // play and get captured. This extends the beat's visual duration.
      const minBeatTail = beat.kind === "reveal" ? 0.45 + 0.5 : 0;
      // Other narrated beats (read-question/read-option) fire a quick
      // decorative ping right after speech ends — it doesn't need extra
      // *visual* time, just a brief real wait so the worklet can capture
      // it before we snapshot this beat's audio.
      const tailPad = narratedBeatTailPad(beat.kind);

      if (minBeatTail > actualDur) {
        await wait((minBeatTail - actualDur) * 1000);
        actualDur = minBeatTail;
      } else if (tailPad > 0) {
        await wait(tailPad * 1000);
      }

      beat.dur = actualDur;

      audioSegments.push({
        offsetSeconds: cursor,
        samples: audio.extractPcmSince(pcmMark),
      });

      console.log(
        "[export] Speech beat actual duration:",
        beat.kind,
        actualDur.toFixed(2) + "s",
        spokenSeconds > 0 ? "(measured)" : "(fallback estimate)"
      );
    } else {
      onProgress({ stage: "Animating character...", percent });

      // No narration in this beat, so there's nothing that requires real
      // wall-clock time — its SFX is synthesized offline (instantly) and
      // dropped straight into the final audio buffer below.
      const sfxVolume = audioSettings.muted ? 0 : audioSettings.sfxVolume;
      const offlineSamples = await renderBeatAudioOffline(
        beat,
        sampleRate,
        sfxVolume
      );

      audioSegments.push({ offsetSeconds: cursor, samples: offlineSamples });
    }

    enqueueBeatFrames(cursor, cursor + beat.dur);
    cursor += beat.dur;
  }

  // Wait for any still-in-flight frame generation to finish.
  await frameChain;

  runtimeTimeline.duration = cursor;

  /* -----------------------------------------------------------------------
   * AUDIO: COMPOSE EVERY BEAT'S SEGMENT INTO ONE BUFFER
   * --------------------------------------------------------------------- */

  onProgress({ stage: "Finalizing MP4...", percent: 93 });

  audio.stopPcmCapture();

  const targetSamples = Math.max(1, Math.round(cursor * sampleRate));
  const alignedSamples = new Float32Array(targetSamples);

  for (const segment of audioSegments) {
    const startIdx = Math.round(segment.offsetSeconds * sampleRate);
    if (startIdx >= targetSamples) continue;

    const len = Math.min(segment.samples.length, targetSamples - startIdx);
    if (len > 0) {
      alignedSamples.set(segment.samples.subarray(0, len), startIdx);
    }
  }

  for (let offset = 0; offset < targetSamples; offset += AUDIO_CHUNK_FRAMES) {
    if (opts.signal?.cancelled) break;

    const len = Math.min(AUDIO_CHUNK_FRAMES, targetSamples - offset);
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