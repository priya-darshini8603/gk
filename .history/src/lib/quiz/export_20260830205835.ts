// lib/quiz/export.ts
import {
  Output,
  Mp4OutputFormat,
  WebMOutputFormat,
  BufferTarget,
  CanvasSource,
  MediaStreamAudioTrackSource,
  getFirstEncodableVideoCodec,
  getFirstEncodableAudioCodec,
  type VideoCodec,
  type AudioCodec,
} from "mediabunny";

import { drawFrame } from "./renderer";
import { getState, type Beat, type Timeline } from "./timeline";
import type { AudioSettings, Quiz } from "./types";
import type { AudioEngine, SfxName } from "./audio";

export type RenderStage =
  | "Preparing animation..."
  | "Animating character..."
  | "Adding voice..."
  | "Finalizing video..."
  | "Done";

export interface RenderProgress {
  stage: RenderStage;
  percent: number;
}

/* ---------------------------------------------------------------------------
 * CODEC / CONTAINER SELECTION
 * ------------------------------------------------------------------------- */

const VIDEO_BITRATE = 8_000_000;
const AUDIO_BITRATE = 160_000;
const FPS = 30;

async function pickCodecs(width: number, height: number) {
  const videoCodec = await getFirstEncodableVideoCodec(
    ["avc", "hevc", "vp9", "vp8"],
    { width, height, bitrate: VIDEO_BITRATE }
  );

  if (!videoCodec) {
    throw new Error(
      "This browser cannot encode video (WebCodecs unsupported)."
    );
  }

  const useMp4 = videoCodec === "avc" || videoCodec === "hevc";

  // Keep codec/container pairing sane: aac in mp4, opus in webm.
  const audioCandidates: AudioCodec[] = useMp4 ? ["aac"] : ["opus"];

  const audioCodec = await getFirstEncodableAudioCodec(audioCandidates, {
    numberOfChannels: 2,
    sampleRate: 48000,
    bitrate: AUDIO_BITRATE,
  });

  return {
    videoCodec: videoCodec as VideoCodec,
    audioCodec: audioCodec as AudioCodec | null,
    useMp4,
  };
}

/* ---------------------------------------------------------------------------
 * FRAME TICKER
 *
 * requestAnimationFrame is throttled — sometimes to ~1fps — when a tab is
 * backgrounded, and starved entirely while the main thread is blocked.
 * That's the direct cause of frozen/skipped export frames. A tiny Worker
 * running its own setInterval is NOT subject to page-visibility throttling
 * in any major browser, so it keeps waking the render loop up on schedule
 * regardless of what the page itself is doing. If Workers are unavailable
 * (e.g. a restrictive CSP blocking blob: workers), we fall back to a plain
 * setTimeout loop, which is still better than requestAnimationFrame alone.
 * ------------------------------------------------------------------------- */

function startRawTicker(intervalMs: number, onTick: () => void) {
  try {
    const workerSrc = `
      let handle = null;
      onmessage = (e) => {
        if (e.data === "start") {
          handle = setInterval(() => postMessage("tick"), ${intervalMs});
        } else if (e.data === "stop" && handle != null) {
          clearInterval(handle);
        }
      };
    `;

    const blobUrl = URL.createObjectURL(
      new Blob([workerSrc], { type: "application/javascript" })
    );

    const worker = new Worker(blobUrl);

    worker.onmessage = () => onTick();
    worker.postMessage("start");

    return {
      stop() {
        worker.postMessage("stop");
        worker.terminate();
        URL.revokeObjectURL(blobUrl);
      },
    };
  } catch (err) {
    console.warn(
      "[export] Worker ticker unavailable, falling back to setTimeout:",
      err
    );

    let stopped = false;

    const loop = () => {
      if (stopped) return;
      onTick();
      window.setTimeout(loop, intervalMs);
    };

    window.setTimeout(loop, intervalMs);

    return {
      stop() {
        stopped = true;
      },
    };
  }
}

/** Async-await friendly wrapper: `await frameTicker.next()` waits for the next tick. */
function createFrameTicker(fps: number) {
  const intervalMs = 1000 / fps;
  let stopped = false;
  const waiters: Array<() => void> = [];

  const raw = startRawTicker(intervalMs, () => {
    const pending = waiters.splice(0, waiters.length);
    pending.forEach((resolve) => resolve());
  });

  return {
    next(): Promise<void> {
      if (stopped) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    stop() {
      if (stopped) return;
      stopped = true;
      raw.stop();
      waiters.splice(0).forEach((resolve) => resolve());
    },
  };
}

/* ---------------------------------------------------------------------------
 * RENDER VIDEO
 *
 * Beats fall into two categories:
 *
 *  - SPEECH beats (beat.say is set): intro, read-question, read-option x4,
 *    reveal, explanation. Their duration is NOT known ahead of time. We
 *    draw continuously while audio.speak() is in flight and use whatever
 *    duration it actually resolves with — no fixed cap, no padding.
 *
 *  - FIXED beats (no beat.say): enter, question-in, options-in, countdown,
 *    celebrate. Nothing to sync to narration for these, so they keep their
 *    planned/estimated duration (countdown specifically comes straight
 *    from quiz.timer).
 *
 * `cursor` is the single source of truth for "current time in the real,
 * as-rendered video" — it only ever advances by an amount that was
 * actually spent (either real speech time or a fixed beat's time).
 *
 * VIDEO TIMING: frames are pushed to Mediabunny's CanvasSource with
 * timestamps derived from `cursor` + local beat progress — never from
 * however long a wall-clock capture happened to observe. `pushFramesUpTo`
 * fills every 1/fps slot up to the target time in one tight loop, so even
 * a multi-second main-thread stall just means several frames get pushed
 * back-to-back on resume (repeating the last-drawn canvas) instead of a
 * gap or a drift in the exported file's timing.
 *
 * AUDIO TIMING: SFX are scheduled ahead of time on the Web Audio clock
 * (AudioEngine.sfx(name, delaySeconds)) rather than triggered by polling
 * inside the draw loop, so they still land on-beat even if this loop
 * itself gets delayed by a busy main thread.
 * ------------------------------------------------------------------------- */

export async function renderVideo(
  opts: {
    quiz: Quiz;
    timeline: Timeline;
    width: number;
    height: number;
    audio: AudioEngine;
    audioSettings: AudioSettings;
    onProgress: (progress: RenderProgress) => void;
    signal?: { cancelled: boolean };
  }
): Promise<{ blob: Blob; extension: string }> {
  const { quiz, timeline, width, height, audio, audioSettings, onProgress } =
    opts;

  /* -----------------------------------------------------------------------
   * PREPARE
   * --------------------------------------------------------------------- */

  onProgress({ stage: "Preparing animation...", percent: 2 });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Canvas is not available in this browser.");
  }

  /* -----------------------------------------------------------------------
   * NARRATION CAPTURE + AUDIO
   * --------------------------------------------------------------------- */

  onProgress({ stage: "Adding voice...", percent: 3 });

  const narrationOk = await audio.captureNarration();
  console.log("[export] Narration capture:", narrationOk);

  audio.ensure();
  audio.apply(audioSettings);

  /* -----------------------------------------------------------------------
   * CODEC SELECTION + OUTPUT SETUP
   * --------------------------------------------------------------------- */

  const { videoCodec, audioCodec, useMp4 } = await pickCodecs(width, height);

  console.log("[export] Codecs selected:", { videoCodec, audioCodec, useMp4 });

  const target = new BufferTarget();

  const output = new Output({
    format: useMp4 ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target,
  });

  const videoSource = new CanvasSource(canvas, {
    codec: videoCodec,
    bitrate: VIDEO_BITRATE,
  });

  output.addVideoTrack(videoSource, { frameRate: FPS });

  // Optional chaining: depending on the installed mediabunny version,
  // `errorPromise` may not be present on every source class. This
  // listener is best-effort logging only — its absence must never crash
  // the export.
  videoSource.errorPromise?.catch((error) => {
    console.error("[export] Video encode error:", error);
  });

  // Narration + SFX are captured live from the shared AudioEngine
  // destination. We do NOT stop these tracks when we're done — the
  // AudioEngine and its destination are reused across every video in a
  // CSV batch, and stopping them here would silence narration on every
  // subsequent video in the batch.
  const audioTracks = audio.dest ? audio.dest.stream.getAudioTracks() : [];

  let audioSource: MediaStreamAudioTrackSource | null = null;

  if (audioCodec && audioTracks[0]) {
    audioSource = new MediaStreamAudioTrackSource(audioTracks[0], {
      codec: audioCodec,
      bitrate: AUDIO_BITRATE,
    });

    output.addAudioTrack(audioSource);

    audioSource.errorPromise?.catch((error) => {
      console.error("[export] Audio encode error:", error);
    });
  } else {
    console.warn(
      "[export] No encodable audio track available — video will render without sound."
    );
  }

  /* -----------------------------------------------------------------------
   * DETERMINISTIC FRAME DELIVERY
   * --------------------------------------------------------------------- */

  const frameDur = 1 / FPS;
  let pushedUpTo = 0;

  const pushFramesUpTo = async (targetTime: number) => {
    while (pushedUpTo < targetTime) {
      const dur = Math.min(frameDur, targetTime - pushedUpTo);
      await videoSource.add(pushedUpTo, dur);
      pushedUpTo += dur;
    }
  };

  /* -----------------------------------------------------------------------
   * RUNTIME TIMELINE
   *
   * Cloned from the planned timeline so kind/say/option/scene/label carry
   * over, but start/dur get finalized as beats actually run. getState()
   * reads this array via tl.beats.find(b => t is within [start, start+dur)),
   * and since we always finalize a beat's start/dur before moving on to the
   * next one, earlier beats are always correctly matched first regardless
   * of what stale estimated values still sit on beats further ahead.
   * --------------------------------------------------------------------- */

  const runtimeBeats: Beat[] = timeline.beats.map((b) => ({ ...b }));
  const runtimeTimeline: Timeline = {
    beats: runtimeBeats,
    duration: 0,
    seed: timeline.seed,
  };

  const runKey = Math.random();

  const drawAt = (time: number) => {
    const safeTime = Math.max(0, time);

    drawFrame(
      ctx,
      quiz,
      getState(runtimeTimeline, quiz, safeTime),
      width,
      height,
      runKey
    );
  };

  const frameTicker = createFrameTicker(FPS);

  /* -----------------------------------------------------------------------
   * FIXED-DURATION BEAT (no narration to sync to)
   * --------------------------------------------------------------------- */

  const renderBeatFixed = async (beat: Beat, cursorAtStart: number) => {
    // Schedule this beat's SFX up front, on the Web Audio clock, so they
    // land on-beat even if this draw loop stalls or falls behind.
    if (beat.kind === "countdown") {
      const totalTicks = Math.max(0, Math.floor(beat.dur));

      for (let i = 0; i < totalTicks; i++) {
        audio.sfx("tick", i);
      }

      audio.sfx("final", beat.dur);
    } else {
      const onCompleteSfx: SfxName | null =
        beat.kind === "question-in"
          ? "board"
          : beat.kind === "options-in"
            ? "pop"
            : beat.kind === "celebrate"
              ? "cheer"
              : null;

      if (onCompleteSfx) {
        audio.sfx(onCompleteSfx, beat.dur);
      }
    }

    const start = performance.now();

    while (true) {
      if (opts.signal?.cancelled) {
        return;
      }

      const elapsed = (performance.now() - start) / 1000;
      const localTime = Math.min(elapsed, Math.max(0, beat.dur - 0.001));

      drawAt(beat.start + localTime);

      await pushFramesUpTo(cursorAtStart + Math.min(elapsed, beat.dur));

      if (elapsed >= beat.dur) {
        break;
      }

      await frameTicker.next();
    }

    // Final flush to the exact beat boundary — closes any rounding gap.
    await pushFramesUpTo(cursorAtStart + beat.dur);
  };

  /* -----------------------------------------------------------------------
   * SPEECH-DRIVEN BEAT
   * --------------------------------------------------------------------- */

  const renderBeatSpeech = async (
    beat: Beat,
    cursorAtStart: number,
    estimatedFallbackDur: number
  ): Promise<number> => {
    const start = performance.now();
    let running = true;

    const drawLoop = async () => {
      while (running) {
        if (opts.signal?.cancelled) {
          return;
        }

        const elapsed = (performance.now() - start) / 1000;

        drawAt(beat.start + elapsed);
        await pushFramesUpTo(cursorAtStart + elapsed);

        await frameTicker.next();
      }
    };

    const loopPromise = drawLoop();

    const spokenSeconds = await audio.speak(
      beat.say!,
      quiz.language,
      audioSettings
    );

    running = false;
    await loopPromise;

    const actualDur = Math.max(
      0.25, // technical floor so a beat is never zero-length; not padding
      spokenSeconds > 0 ? spokenSeconds : estimatedFallbackDur
    );

    // Final frame + flush at the true end-of-beat time.
    drawAt(beat.start + actualDur - 0.001);
    await pushFramesUpTo(cursorAtStart + actualDur);

    console.log(
      "[export] Speech beat actual duration:",
      beat.kind,
      actualDur.toFixed(2) + "s",
      spokenSeconds > 0 ? "(measured)" : "(fallback estimate — no audio played)"
    );

    return actualDur;
  };

  /* -----------------------------------------------------------------------
   * RENDER START
   * --------------------------------------------------------------------- */

  onProgress({ stage: "Animating character...", percent: 6 });

  await output.start();

  try {
    /* ---------------------------------------------------------------------
     * PROCESS EVERY BEAT EXACTLY ONCE, IN ORDER
     * ----------------------------------------------------------------- */

    const total = timeline.beats.length;
    let cursor = 0;

    for (let index = 0; index < total; index++) {
      const plannedBeat = timeline.beats[index];
      const beat = runtimeBeats[index];

      if (!plannedBeat || !beat) {
        continue;
      }

      if (opts.signal?.cancelled) {
        break;
      }

      beat.start = cursor;

      const percent = 6 + Math.round((index / total) * 88);

      console.log(
        "[export] Beat:",
        index + 1,
        "/",
        total,
        beat.kind,
        beat.label
      );

      /* -------------------------------------------------------------------
       * SPEECH BEAT
       * ------------------------------------------------------------- */

      if (beat.say) {
        onProgress({ stage: "Adding voice...", percent });

        const estimatedFallbackDur = beat.dur;

        // Placeholder while this beat is "live" so getState() keeps
        // matching it (find() picks the first match, so already-finalized
        // earlier beats and still-stale later beats never interfere).
        beat.dur = 9999;

        const cursorAtStart = cursor;

        const actualDur = await renderBeatSpeech(
          beat,
          cursorAtStart,
          estimatedFallbackDur
        );

        beat.dur = actualDur;
        cursor += actualDur;

        /* -----------------------------------------------------------
         * SFX AFTER VOICE
         * ------------------------------------------------------- */

        if (beat.kind === "read-question") {
          audio.sfx("board");
        }

        if (beat.kind === "read-option") {
          audio.sfx("point");
        }

        if (beat.kind === "reveal") {
          audio.sfx("correct", 0);
          audio.sfx("confetti", 0.15);
        }

        continue;
      }

      /* ---------------------------------------------------------------
       * NON-SPEECH BEAT — keeps its planned/fixed duration.
       * SFX for question-in/options-in/countdown/celebrate are
       * scheduled inside renderBeatFixed, up front.
       * ------------------------------------------------------------- */

      onProgress({ stage: "Animating character...", percent });

      const cursorAtStart = cursor;

      await renderBeatFixed(beat, cursorAtStart);

      cursor += beat.dur;
    }

    runtimeTimeline.duration = cursor;

    // Final safety flush — should be a no-op, but guarantees the muxed
    // file's duration exactly matches our bookkeeping.
    await pushFramesUpTo(cursor);

    /* -----------------------------------------------------------------
     * FINALIZE
     * ----------------------------------------------------------------- */

    onProgress({ stage: "Finalizing video...", percent: 96 });

    videoSource.close();
    audioSource?.close();

    await output.finalize();
  } finally {
    frameTicker.stop();
  }

  if (!target.buffer) {
    throw new Error("Mediabunny did not produce any output data.");
  }

  const blob = new Blob([target.buffer], { type: output.format.mimeType });

  onProgress({ stage: "Done", percent: 100 });

  return {
    blob,
    extension: useMp4 ? "mp4" : "webm",
  };
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