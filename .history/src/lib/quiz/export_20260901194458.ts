// lib/quiz/export.ts
import {
  Output,
  Mp4OutputFormat,
  WebMOutputFormat,
  BufferTarget,
  MediaStreamVideoTrackSource,
  MediaStreamAudioTrackSource,
  getFirstEncodableVideoCodec,
  getFirstEncodableAudioCodec,
  type VideoCodec,
  type AudioCodec,
} from "mediabunny";

import { drawFrame } from "./renderer";
import { getState, type Beat, type Timeline } from "./timeline";
import type { AudioSettings, Quiz } from "./types";
import type { AudioEngine } from "./audio";

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
 *
 * Mediabunny encodes via WebCodecs, so instead of guessing a MediaRecorder
 * MIME string (and silently getting webm on browsers without mp4 support),
 * we ask the browser what it can actually encode and build the container
 * around that. AVC/HEVC -> MP4 (most compatible). VP9/VP8 -> WebM fallback.
 * ------------------------------------------------------------------------- */

const VIDEO_BITRATE = 8_000_000;
const AUDIO_BITRATE = 160_000;
const EXPORT_FPS = 30;
const EXPORT_FRAME_STEP = 1 / EXPORT_FPS;

function catchUpFrames(
  drawAt: (time: number) => void,
  beatStart: number,
  elapsedSec: number,
  lastRenderedSec: number,
) {
  let nextRenderAt = lastRenderedSec + EXPORT_FRAME_STEP;
  let renderedLast = lastRenderedSec;

  while (nextRenderAt <= elapsedSec + 0.0005) {
    drawAt(beatStart + nextRenderAt);
    renderedLast = nextRenderAt;
    nextRenderAt += EXPORT_FRAME_STEP;
  }

  return renderedLast;
}

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
 * NEXT FRAME
 * ------------------------------------------------------------------------- */

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
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
 * The running `cursor` is the single source of truth for "current time in
 * the real, as-rendered video" — it only ever advances by an amount that
 * was actually spent (either real speech time or a fixed beat's time).
 *
 * Encoding: the canvas and the Web Audio destination are captured as live
 * MediaStreamTracks (same as before), but instead of feeding a
 * MediaRecorder, Mediabunny's MediaStreamVideoTrackSource /
 * MediaStreamAudioTrackSource pull from those tracks in real time and
 * encode + mux them straight into the output file via WebCodecs.
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
   * NARRATION CAPTURE
   * --------------------------------------------------------------------- */

  onProgress({ stage: "Adding voice...", percent: 3 });

  const narrationOk = await audio.captureNarration();

  console.log("[export] Narration capture:", narrationOk);

  /* -----------------------------------------------------------------------
   * AUDIO
   * --------------------------------------------------------------------- */

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

  /* -----------------------------------------------------------------------
   * RECORDING STREAM
   * --------------------------------------------------------------------- */

  const fps = EXPORT_FPS;

  const stream = canvas.captureStream(fps);

  const videoTrack = stream.getVideoTracks()[0];

  if (!videoTrack) {
    throw new Error("Unable to capture the canvas as a video track.");
  }

  const videoSource = new MediaStreamVideoTrackSource(videoTrack, {
    codec: videoCodec,
    bitrate: VIDEO_BITRATE,
  });

  output.addVideoTrack(videoSource, { frameRate: fps });

  videoSource.errorPromise.catch((error) => {
    console.error("[export] Video encode error:", error);
  });

  const audioTracks = audio.dest
    ? audio.dest.stream.getAudioTracks()
    : [];

  let audioSource: MediaStreamAudioTrackSource | null = null;

  if (audioCodec && audioTracks[0]) {
    audioSource = new MediaStreamAudioTrackSource(audioTracks[0], {
      codec: audioCodec,
      bitrate: AUDIO_BITRATE,
    });

    output.addAudioTrack(audioSource);

    audioSource.errorPromise.catch((error) => {
      console.error("[export] Audio encode error:", error);
    });
  } else {
    console.warn(
      "[export] No encodable audio track available — video will render without sound."
    );
  }

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

  /* -----------------------------------------------------------------------
   * FIXED-DURATION BEAT (no narration to sync to)
   * The beat remains visible for exactly its planned duration.
   * --------------------------------------------------------------------- */

  const renderBeatFixed = async (beat: Beat) => {
    const start = performance.now();

    // A single rAF callback can represent several 30fps slots when the main
    // thread is temporarily blocked. We catch up by rendering every missing
    // frame timestamp in order instead of dropping the animation state.
    let lastRenderedSec = 0;

    // Used only for countdown SFX.
    let lastCountdownSecond = -1;

    while (true) {
      if (opts.signal?.cancelled) {
        return;
      }

      const elapsed = (performance.now() - start) / 1000;
      const localTime = Math.min(elapsed, Math.max(0, beat.dur - 0.001));

      lastRenderedSec = catchUpFrames(drawAt, beat.start, localTime, lastRenderedSec);

      if (beat.kind === "countdown") {
        const remaining = Math.ceil(beat.dur - elapsed);

        if (remaining > 0 && remaining !== lastCountdownSecond) {
          lastCountdownSecond = remaining;
          audio.sfx("tick");
          console.log("[export] Countdown tick:", remaining);
        }
      }

      if (elapsed >= beat.dur) {
        break;
      }

      await nextFrame();
    }

    if (beat.kind === "countdown") {
      audio.sfx("final");
      console.log("[export] Countdown finished");
    }
  };

  /* -----------------------------------------------------------------------
   * SPEECH-DRIVEN BEAT
   *
   * Draws continuously (uncapped) while audio.speak() is actually in
   * flight, and stops the instant that promise resolves — which happens on
   * the utterance's real 'end' event. The resolved duration IS the beat's
   * real duration; nothing is padded or truncated.
   *
   * If there's no real narration to time against (muted / unsupported /
   * speak() returns 0), we fall back to the original word-count estimate
   * purely so pacing doesn't collapse to zero — never as a target for
   * actual speech.
   * --------------------------------------------------------------------- */

  const renderBeatSpeech = async (
    beat: Beat,
    estimatedFallbackDur: number
  ): Promise<number> => {
    const start = performance.now();
    let running = true;
    let lastRenderedSec = 0;

    const drawLoop = async () => {
      while (running) {
        if (opts.signal?.cancelled) {
          return;
        }

        const elapsed = (performance.now() - start) / 1000;
        const capped = Math.min(elapsed, estimatedFallbackDur);

        // When the UI thread stalls, one frame callback can represent many
        // 30fps intervals. Catch up in order so the exported sequence still
        // includes the missing states instead of jumping ahead.
        lastRenderedSec = catchUpFrames(
          drawAt,
          beat.start,
          capped,
          lastRenderedSec,
        );

        await nextFrame();
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

    // Final frame at the true end-of-beat time.
    drawAt(beat.start + actualDur - 0.001);

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

  /* -----------------------------------------------------------------------
   * PROCESS EVERY BEAT EXACTLY ONCE, IN ORDER
   * --------------------------------------------------------------------- */

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

    /* ---------------------------------------------------------------------
     * SPEECH BEAT
     * ------------------------------------------------------------------- */

    if (beat.say) {
      onProgress({ stage: "Adding voice...", percent });

      const estimatedFallbackDur = beat.dur;

      // Placeholder while this beat is "live" so getState() keeps
      // matching it (find() picks the first match, so already-finalized
      // earlier beats and still-stale later beats never interfere).
      beat.dur = 9999;

      const actualDur = await renderBeatSpeech(beat, estimatedFallbackDur);

      beat.dur = actualDur;
      cursor += actualDur;

      /* ---------------------------------------------------------------
       * SFX AFTER VOICE
       * ------------------------------------------------------------- */

      if (beat.kind === "read-question") {
        audio.sfx("board");
      }

      if (beat.kind === "read-option") {
        audio.sfx("point");
      }

      if (beat.kind === "reveal") {
        audio.sfx("correct");

        await new Promise<void>((resolve) => setTimeout(resolve, 150));

        audio.sfx("confetti");
      }

      continue;
    }

    /* ---------------------------------------------------------------------
     * NON-SPEECH BEAT — keeps its planned/fixed duration
     * ------------------------------------------------------------------- */

    onProgress({ stage: "Animating character...", percent });

    await renderBeatFixed(beat);

    cursor += beat.dur;

    /* ---------------------------------------------------------------------
     * SFX AFTER VISUAL MOVEMENT
     * ------------------------------------------------------------------- */

    if (beat.kind === "question-in") {
      audio.sfx("board");
    }

    if (beat.kind === "options-in") {
      audio.sfx("pop");
    }

    if (beat.kind === "countdown") {
      audio.sfx("final");
    }

    if (beat.kind === "celebrate") {
      audio.sfx("cheer");
    }
  }

  runtimeTimeline.duration = cursor;

  /* -----------------------------------------------------------------------
   * FINALIZE
   * --------------------------------------------------------------------- */

  onProgress({ stage: "Finalizing video...", percent: 96 });

  // Closing sources is optional but lets Mediabunny stop buffering and
  // wrap up as soon as possible instead of waiting on finalize() alone.
  videoSource.close();
  audioSource?.close();

  await output.finalize();

  stream.getTracks().forEach((track) => track.stop());

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