// src/lib/quiz/export.ts
//
// Deterministic, frame-accurate MP4 exporter built on WebCodecs + mp4-muxer.
// Replaces the previous MediaRecorder + canvas.captureStream() pipeline.
//
// ---------------------------------------------------------------------------
// WHY THE OLD PIPELINE DROPPED / DUPLICATED / MISSED FRAMES
// ---------------------------------------------------------------------------
// canvas.captureStream(fps) samples whatever bitmap happens to be on the
// canvas at fixed WALL-CLOCK intervals, driven by the browser's own
// scheduler. If the main thread is busy (heavy drawFrame() calls, GC
// pauses, background tabs, a slow laptop, etc.) the canvas isn't updated in
// time for a sample, so captureStream re-emits the previous bitmap
// (stutter / "missing" animation), or MediaRecorder's internal buffering
// drops frames outright under load. Because sampling is tied to REAL time,
// a slow machine produces a video whose *content* is wrong — not just slow
// to produce. No amount of requestAnimationFrame tuning fixes that; the
// sampling model itself is broken.
//
// ---------------------------------------------------------------------------
// THE FIX
// ---------------------------------------------------------------------------
// We never ask anything to "grab whatever is on screen right now". Instead,
// for every beat in the timeline:
//
//   1. Determine the beat's REAL duration.
//        - Fixed beats (enter, question-in, options-in, countdown,
//          celebrate) already have an exact planned duration up front —
//          nothing to measure.
//        - Speech beats depend on SpeechSynthesis, which only reports its
//          real duration via the utterance's 'end' event, so we still have
//          to actually play them once. This is a genuine limitation of the
//          Web Speech API (no offline "how long will this take" query
//          exists) — not something a muxer can fix. Note that the Web
//          Audio graph producing this audio runs on its own
//          audio-rendering thread, independent of our JS main thread, so
//          it is NOT affected by drawFrame() being slow.
//
//   2. Once a beat's duration is known, generate the EXACT number of video
//      frames for it — round(duration * fps) — entirely offline: for
//      i in [0, frameCount) compute t = beatStart + i / fps, call
//      getState(tl, quiz, t), draw it, wrap the canvas bitmap in a
//      VideoFrame stamped with the mathematically correct timestamp, and
//      hand it to a WebCodecs VideoEncoder. How long drawFrame() itself
//      takes has ZERO effect on the resulting timestamps or frame count —
//      a slow laptop only makes export take longer, it can no longer
//      corrupt the output.
//
//   3. Audio is captured continuously and independently via
//      MediaStreamTrackProcessor + AudioEncoder, reading straight from the
//      same mixed destination node the app already builds (SFX + music +
//      captured narration), so it stays in sync with the beat timestamps
//      we're stamping onto frames.
//
//   4. Encoded video/audio chunks are muxed into a real .mp4 with
//      mp4-muxer (a pure-JS ISO-BMFF muxer built for WebCodecs output).
//
// ---------------------------------------------------------------------------
// BUGFIX: "extra video with only sfx after the video is done"
// ---------------------------------------------------------------------------
// Video frame timestamps above are computed MATHEMATICALLY
// (t = cursor + i/fps) — they never depend on real elapsed time. Audio,
// however, comes from MediaStreamTrackProcessor, which timestamps samples
// on the REAL wall clock.
//
// processBeat spends real time on two things per beat: the beat's
// "unavoidable" real-time component (a sleep, or waiting for speech to
// finish) — which IS reflected in `cursor` — and a "catch-up + flush"
// phase that draws/encodes any frames the catch-up loop didn't finish in
// time. That flush phase costs genuine wall-clock time that is NEVER
// added to `cursor`. Nothing paused the live Web Audio graph during that
// flush, so if background music was left running (started elsewhere, e.g.
// a live preview sharing this same AudioEngine instance), it kept ticking
// in real time through every one of those gaps and got captured.
//
// Net effect: the video track's length is exactly the sum of the beats'
// nominal durations, but the audio track's length is the real wall-clock
// duration of the whole export — which is always >= the nominal duration.
// The gap between them (silence if there's no music, but audible
// music/SFX if there is) showed up as a trailing chunk of audio after the
// video's last frame: "extra video with only sfx."
//
// Fix, two parts:
//   (a) Explicitly stop any perpetual audio source (background music)
//       the instant export starts. A wall-clock-driven, never-ending
//       generator is exactly the kind of "real time creeping in" bug this
//       file was written to eliminate on the video side — it just crept
//       back in on the audio side via a live, non-beat-bound sound. Bounded
//       one-shot SFX (dings, pops, the reveal chime) are NOT the problem;
//       they end on their own.
//   (b) Add a short, FIXED trailing "hold": after the last beat, extend
//       BOTH the video (by holding the final rendered frame) and the
//       audio-capture window (by sleeping the same amount) by the same
//       constant. This guarantees any one-shot SFX from the final beat
//       (cheer/confetti/correct) has time to finish playing and be
//       captured, and guarantees the two tracks end together — there is
//       no way for this hold itself to reintroduce an audio-only tail,
//       because both tracks are extended by the identical amount.
//
// ---------------------------------------------------------------------------
// REQUIREMENTS
// ---------------------------------------------------------------------------
//   npm install mp4-muxer
//
// This relies on WebCodecs (VideoEncoder / AudioEncoder) and Insertable
// Streams (MediaStreamTrackProcessor), both currently Chromium-only
// (Chrome / Edge 94+). Call checkWebCodecsSupport() before offering export
// so unsupported browsers get a clear message instead of a silent failure.
//
// If your TypeScript version's lib.dom.d.ts doesn't yet include the full
// WebCodecs surface, add the `@types/dom-webcodecs` dev dependency and
// list it under `compilerOptions.types` in tsconfig.json. This file also
// declares MediaStreamTrackProcessor itself (Insertable Streams), which
// is not yet part of any stable TS DOM lib.

import { Muxer, ArrayBufferTarget } from "mp4-muxer";

import { drawFrame } from "./renderer";
import { getState, type Beat, type Timeline } from "./timeline";
import type { AudioSettings, Quiz } from "./types";
import type { AudioEngine } from "./audio";

/* ---------------------------------------------------------------------------
 * Ambient types for Insertable Streams (Chrome-only, not yet in lib.dom)
 * ------------------------------------------------------------------------- */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  class MediaStreamTrackProcessor {
    constructor(init: { track: MediaStreamTrack });
    readonly readable: ReadableStream<AudioData>;
  }
}

/* ---------------------------------------------------------------------------
 * Public types (kept identical in spirit to the old export.ts so nothing
 * else in the app — e.g. CsvBatchPanel — needs to change).
 * ------------------------------------------------------------------------- */

export type RenderStage =
  | "Preparing animation..."
  | "Rendering beats..."
  | "Encoding video..."
  | "Finalizing MP4..."
  | "Done";

export interface RenderProgress {
  stage: RenderStage;
  percent: number;
}

/* ---------------------------------------------------------------------------
 * Support check
 * ------------------------------------------------------------------------- */

export function checkWebCodecsSupport(): { supported: boolean; reason?: string } {
  if (typeof window === "undefined") {
    return { supported: false, reason: "Not running in a browser." };
  }

  if (!("VideoEncoder" in window) || !("AudioEncoder" in window)) {
    return {
      supported: false,
      reason:
        "This browser doesn't support WebCodecs (VideoEncoder/AudioEncoder). Please use a recent Chrome or Edge to export videos.",
    };
  }

  if (!("MediaStreamTrackProcessor" in window)) {
    return {
      supported: false,
      reason:
        "This browser doesn't support MediaStreamTrackProcessor (Insertable Streams). Please use a recent Chrome or Edge to export videos.",
    };
  }

  return { supported: true };
}

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------- */

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function isPlanarFormat(format: AudioSampleFormat): boolean {
  return format.endsWith("-planar");
}

/**
 * MediaStreamTrackProcessor hands us AudioData whose `timestamp` is on the
 * capture device's own clock, not zero-based from export start. We need
 * timestamps that are zero-based and line up with the video track's
 * beat-derived timestamps, so we copy the raw samples out and re-wrap them
 * in a fresh AudioData at the corrected timestamp. This is a data copy, not
 * a re-encode, so it's cheap and lossless.
 */
function rebaseAudioData(frame: AudioData, newTimestampUs: number): AudioData {
  const format = frame.format as AudioSampleFormat;
  const planar = isPlanarFormat(format);
  const planeCount = planar ? frame.numberOfChannels : 1;

  const planes: ArrayBuffer[] = [];
  for (let p = 0; p < planeCount; p++) {
    const size = frame.allocationSize({ planeIndex: p, format });
    const buf = new ArrayBuffer(size);
    frame.copyTo(buf, { planeIndex: p, format });
    planes.push(buf);
  }

  // For planar formats, AudioData expects all planes concatenated in
  // channel order in a single `data` buffer — exactly what we just built.
  const totalLength = planes.reduce((sum, p) => sum + p.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const p of planes) {
    combined.set(new Uint8Array(p), offset);
    offset += p.byteLength;
  }

  return new AudioData({
    format,
    sampleRate: frame.sampleRate,
    numberOfFrames: frame.numberOfFrames,
    numberOfChannels: frame.numberOfChannels,
    timestamp: newTimestampUs,
    data: combined,
  });
}

async function pickVideoCodec(
  width: number,
  height: number,
  fps: number,
): Promise<{ codec: string; muxCodec: "avc" }> {
  const candidates: { codec: string; muxCodec: "avc" }[] = [
    { codec: "avc1.640034", muxCodec: "avc" }, // High @ L5.2
    { codec: "avc1.4d4029", muxCodec: "avc" }, // Main @ L4.1
    { codec: "avc1.42e01f", muxCodec: "avc" }, // Baseline @ L3.1 — safest fallback
  ];

  for (const candidate of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec: candidate.codec,
        width,
        height,
        bitrate: 8_000_000,
        framerate: fps,
        hardwareAcceleration: "prefer-hardware",
      });

      if (support.supported) {
        return candidate;
      }
    } catch {
      // try the next candidate
    }
  }

  throw new Error(
    `No supported H.264 encoder configuration found for ${width}x${height}@${fps}fps in this browser.`,
  );
}

/**
 * Draw + encode exactly one frame at time `t`. The one place that ever
 * calls VideoEncoder.encode() — everything else just decides WHEN to call
 * this, never WHAT to encode.
 *
 * Also used (unchanged) to render the trailing "hold" frames after the
 * last beat: getState() falls back to the timeline's last beat when `t`
 * is past the end of every beat's [start, start+dur) window, and clamps
 * its internal progress fraction to 1 — so calling this with t values
 * past the last beat's end naturally holds that beat's final pose/caption
 * instead of needing special-cased "freeze frame" logic here.
 *
 * `frameIndexRef.lastTimestampUs` is a hard safety net: mp4-muxer throws if
 * it ever sees a non-increasing timestamp, which would abort the whole
 * export. The catch-up margin in processBeat is what actually prevents that
 * from happening, but if any future edit (or an unforeseen timing edge
 * case) ever produces an out-of-order timestamp anyway, this clamps it
 * forward by one frame duration instead of crashing — at worst a single
 * frame is very slightly compressed, never dropped, and the export
 * finishes.
 */
async function encodeFrameAt(params: {
  videoEncoder: VideoEncoder;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  quiz: Quiz;
  runtimeTimeline: Timeline;
  t: number;
  fps: number;
  runKey: number;
  frameIndexRef: { value: number; lastTimestampUs: number };
  keyFrameInterval: number;
}) {
  const { videoEncoder, canvas, ctx, quiz, runtimeTimeline, t, fps, runKey, frameIndexRef, keyFrameInterval } =
    params;

  const state = getState(runtimeTimeline, quiz, t);
  drawFrame(ctx, quiz, state, canvas.width, canvas.height, runKey);

  const frameDurationUs = Math.round(1_000_000 / fps);
  let timestampUs = Math.round(t * 1_000_000);

  if (timestampUs <= frameIndexRef.lastTimestampUs) {
    console.warn(
      "[export] Clamping out-of-order video timestamp:",
      timestampUs,
      "->",
      frameIndexRef.lastTimestampUs + frameDurationUs,
    );
    timestampUs = frameIndexRef.lastTimestampUs + frameDurationUs;
  }

  frameIndexRef.lastTimestampUs = timestampUs;

  const frame = new VideoFrame(canvas, {
    timestamp: timestampUs,
    duration: frameDurationUs,
  });

  // Backpressure only — a memory-safety valve, NOT a correctness mechanism.
  // It never skips a frame or a timestamp; it just pauses briefly so the
  // encoder's internal queue doesn't grow unbounded on a long export.
  while (videoEncoder.encodeQueueSize > 30) {
    await sleep(4);
  }

  const isKeyFrame = frameIndexRef.value % keyFrameInterval === 0;
  videoEncoder.encode(frame, { keyFrame: isKeyFrame });
  frame.close();
  frameIndexRef.value += 1;
}

/**
 * Process one beat: determine its real duration AND encode its frames,
 * with the drawing/encoding work running CONCURRENTLY with the beat's
 * unavoidable real-time component (speech playback, or the wall-clock
 * pacing a fixed beat needs so its SFX lines up), instead of sequentially
 * after it.
 *
 * A background "catch-up" loop encodes whatever frame indices should exist
 * by now given real elapsed time. Once the real-time bound resolves with
 * the beat's actual duration, a short deterministic flush tops up to the
 * *exact* frame count (round(actualDur * fps)) — pure compute, no waiting.
 * That flush is what guarantees correctness (exact, never-skipped frame
 * count/timestamps) even if this machine fell behind real time during the
 * catch-up loop; the loop itself is purely a speed optimization so most or
 * all of the beat's frames are already done by the time the wait ends,
 * instead of only starting afterward.
 *
 * NOTE on audio: this flush can take real wall-clock time beyond the
 * beat's nominal duration (see the BUGFIX header comment above). That's
 * fine as long as nothing is generating unbounded audio in the
 * background during it — see renderVideo's audio.stopMusic() call and
 * the trailing-hold step after the beat loop.
 */
async function processBeat(params: {
  beat: Beat;
  quiz: Quiz;
  audio: AudioEngine;
  audioSettings: AudioSettings;
  runtimeTimeline: Timeline;
  cursor: number;
  fps: number;
  runKey: number;
  frameIndexRef: { value: number; lastTimestampUs: number };
  keyFrameInterval: number;
  videoEncoder: VideoEncoder;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  signal?: { cancelled: boolean };
}): Promise<number> {
  const {
    beat,
    quiz,
    audio,
    audioSettings,
    runtimeTimeline,
    cursor,
    fps,
    runKey,
    frameIndexRef,
    keyFrameInterval,
    videoEncoder,
    canvas,
    ctx,
    signal,
  } = params;

  const startWall = performance.now();
  let done = false;
  let nextFrameIndex = 0;

  // Speech beats' PLANNED duration (from buildTimeline) is just an
  // estimate — the real duration is only known once audio.speak()
  // resolves below. getState() finds "which beat is active" by checking
  // t against [beat.start, beat.start + beat.dur), so if we left
  // beat.dur at its stale planned value while frames are being drawn,
  // the instant real elapsed time exceeds that (short) estimate,
  // getState() stops matching THIS beat entirely and falls through to
  // rendering some other (usually the very last) beat instead — a
  // sudden, wrong-looking jump mid-animation. Temporarily widening the
  // window to "as long as it takes" prevents that; we narrow it back to
  // the real value the moment we know it, right below.
  const originalPlannedDur = beat.dur;
  if (beat.say) {
    beat.dur = 9999;
  }

  // The catch-up loop below estimates "how far into this beat are we" from
  // wall-clock elapsed time. But audio.speak() (and, less so, plain
  // setTimeout scheduling) has a little startup/scheduling overhead before
  // playback actually begins, so by the time the beat's real-time bound
  // resolves, elapsed wall time can be SLIGHTLY MORE than the beat's true
  // duration. Without a margin, the catch-up loop could draw a frame or two
  // past the beat's real end — i.e. into the next beat's timestamp range —
  // which then collides with that next beat's (earlier, correct) starting
  // timestamp and produces non-monotonic DTS in the muxer.
  //
  // Trailing elapsed time by a fixed safety margin means the catch-up loop
  // can never reach that dangerous last stretch of the beat; the small tail
  // it deliberately leaves behind is always filled in by the deterministic
  // flush AFTER the true duration is known, where it's safe by construction.
  const CATCHUP_SAFETY_MARGIN_S = 0.3;

  const encodeOneMore = () =>
    encodeFrameAt({
      videoEncoder,
      canvas,
      ctx,
      quiz,
      runtimeTimeline,
      t: cursor + nextFrameIndex / fps,
      fps,
      runKey,
      frameIndexRef,
      keyFrameInterval,
    });

  const catchUpLoop = (async () => {
    while (!done) {
      if (signal?.cancelled) return;

      const elapsed = (performance.now() - startWall) / 1000;
      const safeElapsed = Math.max(0, elapsed - CATCHUP_SAFETY_MARGIN_S);
      const targetIndex = Math.floor(safeElapsed * fps);

      while (nextFrameIndex <= targetIndex) {
        if (signal?.cancelled) return;
        await encodeOneMore();
        nextFrameIndex++;
      }

      await sleep(Math.max(1, Math.round(500 / fps)));
    }
  })();

  let actualDur: number;

  if (beat.say) {
    const estimatedFallbackDur = originalPlannedDur;
    const spokenSeconds = await audio.speak(beat.say, quiz.language, audioSettings);
    actualDur = Math.max(0.25, spokenSeconds > 0 ? spokenSeconds : estimatedFallbackDur);

    // Narrow the beat's window back to its real duration immediately —
    // any frames still to be drawn (catch-up tail + flush) now compute
    // correct duration-ratio-based animation (easing, pose transitions)
    // instead of the 9999 placeholder.
    beat.dur = actualDur;

    if (beat.kind === "read-question") audio.sfx("board");
    if (beat.kind === "read-option") audio.sfx("point");

    if (beat.kind === "reveal") {
      audio.sfx("correct");
      await sleep(150);
      audio.sfx("confetti");
    }
  } else {
    actualDur = beat.dur;

    if (beat.kind === "countdown") {
      const totalTicks = Math.max(0, Math.floor(beat.dur));

      for (let i = 0; i < totalTicks; i++) {
        window.setTimeout(() => audio.sfx("tick"), i * 1000);
      }

      window.setTimeout(() => audio.sfx("final"), Math.round(beat.dur * 1000));
    }

    // The only reason we wait here at all is to pace SFX/audio capture —
    // it does NOT gate frame correctness (see catchUpLoop + flush above).
    await sleep(beat.dur * 1000);

    if (beat.kind === "question-in") audio.sfx("board");
    if (beat.kind === "options-in") audio.sfx("pop");
    if (beat.kind === "celebrate") audio.sfx("cheer");
  }

  done = true;
  await catchUpLoop;

  const targetFrameCount = Math.max(1, Math.round(actualDur * fps));
  while (nextFrameIndex < targetFrameCount) {
    if (signal?.cancelled) break;
    await encodeOneMore();
    nextFrameIndex++;
  }

  return actualDur;
}

/* ---------------------------------------------------------------------------
 * MAIN EXPORT
 * ------------------------------------------------------------------------- */

// How long to hold the final frame / keep capturing audio after the last
// beat finishes. This is what stops any one-shot SFX from the final beat
// (the reveal chime, confetti, the cheer) from being cut off, WITHOUT
// letting the audio track run any longer than the video track — both are
// extended by exactly this much, together. See the BUGFIX header comment.
const TRAIL_HOLD_SECONDS = 1.2;

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
  const { quiz, timeline, width, height, audio, audioSettings, onProgress, signal } = opts;

  const support = checkWebCodecsSupport();
  if (!support.supported) {
    throw new Error(support.reason);
  }

  const fps = 30;
  const keyFrameInterval = fps * 2; // one keyframe every ~2s, globally across the whole video

  /* -------------------------------------------------------------------- */
  onProgress({ stage: "Preparing animation...", percent: 2 });

  // A perpetual, wall-clock-driven audio source (background music) is
  // exactly the kind of "real time leaking into the output" problem this
  // exporter was written to eliminate — it just wasn't guarded against on
  // the audio side. If a live preview (sharing this same AudioEngine)
  // left the music loop running, stop it before we start capturing, so
  // the only audio recorded is audio that's actually tied to a beat.
  audio.stopMusic();

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas is not available in this browser.");
  }

  /* -------------------------------------------------------------------- */
  onProgress({ stage: "Preparing animation...", percent: 4 });

  const narrationOk = await audio.captureNarration();
  console.log("[export] Narration capture:", narrationOk);

  audio.ensure();
  audio.apply(audioSettings);

  // Belt-and-braces: captureNarration()/apply() above don't start music,
  // but if anything else touched this AudioEngine between the call above
  // and here, make sure it's still off before we open the audio pump.
  audio.stopMusic();

  if (!audio.dest) {
    throw new Error("Audio engine has no destination stream.");
  }

  const audioTrack = audio.dest.stream.getAudioTracks()[0];
  if (!audioTrack) {
    throw new Error("No audio track available to encode.");
  }

  const trackSettings = audioTrack.getSettings();
  const sampleRate = trackSettings.sampleRate ?? 48000;
  const numberOfChannels = trackSettings.channelCount ?? 1;

  /* -------------------------------------------------------------------- */
  const videoCodec = await pickVideoCodec(width, height, fps);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: videoCodec.muxCodec, width, height },
    audio: { codec: "aac", sampleRate, numberOfChannels },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => console.error("[export] video encoder error:", e),
  });

  videoEncoder.configure({
    codec: videoCodec.codec,
    width,
    height,
    bitrate: 8_000_000,
    framerate: fps,
    // Falls back to software transparently if no hardware encoder is
    // available — this is the single biggest lever for export speed at
    // 1080p, since software H.264 encoding is comparatively slow per
    // frame.
    hardwareAcceleration: "prefer-hardware",
  });

  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => console.error("[export] audio encoder error:", e),
  });

  audioEncoder.configure({
    codec: "mp4a.40.2", // AAC-LC
    sampleRate,
    numberOfChannels,
    bitrate: 128_000,
  });

  /* -----------------------------------------------------------------------
   * AUDIO PUMP — runs concurrently for the whole export, independent of
   * whatever the video-frame loop below is doing. Reads live AudioData off
   * the mixed destination track and feeds it straight to the AudioEncoder.
   *
   * This is a genuinely real-time capture (SFX and captured narration have
   * no offline equivalent), so its timestamps are wall-clock based. Video
   * timestamps are not (see the BUGFIX header comment). That asymmetry is
   * fine for the DURATION of the beat loop, because the loop is bounded
   * below by the sum of the beats' real-time components anyway — the only
   * way it becomes user-visible is an unbounded audio source outliving the
   * loop, which audio.stopMusic() above and the trailing hold below now
   * both guard against.
   * --------------------------------------------------------------------- */

  const audioProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
  const audioReader = audioProcessor.readable.getReader();

  let audioBaseTimestamp: number | null = null;
  let audioPumpActive = true;

  const audioPumpPromise = (async () => {
    while (audioPumpActive) {
      let result: ReadableStreamReadResult<AudioData>;

      try {
        result = await audioReader.read();
      } catch {
        break;
      }

      if (result.done) {
        break;
      }

      const frame = result.value;
      if (!frame) {
        continue;
      }

      if (audioBaseTimestamp === null) {
        audioBaseTimestamp = frame.timestamp;
      }

      const relativeTimestampUs = frame.timestamp - audioBaseTimestamp;
      const rebased = rebaseAudioData(frame, relativeTimestampUs);
      frame.close();

      if (audioEncoder.state === "configured" && audioEncoder.encodeQueueSize < 50) {
        audioEncoder.encode(rebased);
      }

      rebased.close();
    }
  })();

  /* -----------------------------------------------------------------------
   * BEAT LOOP — beats are still processed in order (each needs the
   * previous one's real duration to know its own start time), but within
   * each beat, frame drawing/encoding is overlapped with that beat's
   * real-time component instead of stacked after it (see processBeat).
   * --------------------------------------------------------------------- */

  onProgress({ stage: "Rendering beats...", percent: 6 });

  const runtimeBeats: Beat[] = timeline.beats.map((b) => ({ ...b }));
  const runtimeTimeline: Timeline = {
    beats: runtimeBeats,
    duration: 0,
    seed: timeline.seed,
  };

  const runKey = Math.random();
  const frameIndexRef = { value: 0, lastTimestampUs: -1 };

  const total = timeline.beats.length;
  let cursor = 0;

  const loopStartWall = performance.now();

  for (let index = 0; index < total; index++) {
    if (signal?.cancelled) {
      break;
    }

    const plannedBeat = timeline.beats[index];
    const beat = runtimeBeats[index];
    if (!plannedBeat || !beat) {
      continue;
    }

    beat.start = cursor;
    const percent = 6 + Math.round((index / total) * 86);

    console.log("[export] Beat:", index + 1, "/", total, beat.kind, beat.label);
    onProgress({ stage: "Rendering beats...", percent });

    // Duration is determined AND frames are drawn/encoded here, with the
    // encoding work overlapped against the beat's unavoidable real-time
    // component (see processBeat's doc comment) instead of stacked after
    // it — this is what keeps total export time close to the video's
    // actual runtime rather than runtime + full encode time.
    const actualDur = await processBeat({
      beat,
      quiz,
      audio,
      audioSettings,
      runtimeTimeline,
      cursor,
      fps,
      runKey,
      frameIndexRef,
      keyFrameInterval,
      videoEncoder,
      canvas,
      ctx,
      signal,
    });

    beat.dur = actualDur;
    cursor += actualDur;
  }

  // Diagnostic only: lets you see in the console how much real time the
  // encode/flush overhead added beyond the video's nominal duration. On a
  // machine with working hardware acceleration this should be small
  // (well under a second); if it's large, software encoding is likely the
  // bottleneck. This no longer affects correctness either way — it's just
  // useful for debugging slow exports.
  const loopRealSeconds = (performance.now() - loopStartWall) / 1000;
  const encodeOverheadSeconds = loopRealSeconds - cursor;
  console.log(
    "[export] Beat loop real time:",
    loopRealSeconds.toFixed(2) + "s vs nominal",
    cursor.toFixed(2) + "s",
    "(overhead " + encodeOverheadSeconds.toFixed(2) + "s)",
  );

  /* -----------------------------------------------------------------------
   * TRAILING HOLD — see the BUGFIX header comment at the top of this file.
   * Extends both the video (holding the final rendered frame) and the
   * audio-capture window (via the matching sleep) by the SAME fixed
   * amount, so any still-playing one-shot SFX from the last beat gets
   * captured, and neither track can end up longer than the other.
   * --------------------------------------------------------------------- */

  if (!signal?.cancelled) {
    onProgress({ stage: "Rendering beats...", percent: 94 });

    const holdFrameCount = Math.round(TRAIL_HOLD_SECONDS * fps);

    for (let i = 0; i < holdFrameCount; i++) {
      if (signal?.cancelled) break;

      // t is past every beat's [start, start+dur) window, so getState()
      // falls back to the last beat with its progress fraction clamped to
      // 1 — i.e. this naturally holds the final beat's end pose/caption,
      // no separate "freeze frame" plumbing needed.
      await encodeFrameAt({
        videoEncoder,
        canvas,
        ctx,
        quiz,
        runtimeTimeline,
        t: cursor + i / fps,
        fps,
        runKey,
        frameIndexRef,
        keyFrameInterval,
      });
    }

    cursor += TRAIL_HOLD_SECONDS;

    // Give the audio pump the same amount of real time so any trailing
    // SFX tail (cheer/confetti/correct) actually gets read and encoded
    // before we cut the pump off below.
    await sleep(TRAIL_HOLD_SECONDS * 1000);
  }

  runtimeTimeline.duration = cursor;

  /* -----------------------------------------------------------------------
   * FINALIZE
   * --------------------------------------------------------------------- */

  audioPumpActive = false;
  await audioReader.cancel().catch(() => {});
  await audioPumpPromise.catch(() => {});

  // Defensive cleanup: nothing in this function starts music, but stop it
  // again in case something external raced with the export.
  audio.stopMusic();

  onProgress({ stage: "Encoding video...", percent: 90 });
  await videoEncoder.flush();
  await audioEncoder.flush();

  videoEncoder.close();
  audioEncoder.close();

  onProgress({ stage: "Finalizing MP4...", percent: 96 });
  muxer.finalize();

  const { buffer } = muxer.target as ArrayBufferTarget;
  const blob = new Blob([buffer], { type: "video/mp4" });

  onProgress({ stage: "Done", percent: 100 });

  return { blob, extension: "mp4" };
}

/* ---------------------------------------------------------------------------
 * DOWNLOAD (unchanged)
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