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
 * ------------------------------------------------------------------------- */

const VIDEO_BITRATE = 8_000_000;
const AUDIO_BITRATE = 160_000;

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
 * FRAME SCHEDULER
 *
 * FIX FOR "HANGING FRAMES":
 * The original code drove every drawing loop purely off
 * requestAnimationFrame(). Browsers throttle — or fully stop — rAF when the
 * tab is hidden/backgrounded or the window is minimized. Because the render
 * loops compute elapsed time from performance.now() (a clock that keeps
 * ticking regardless of visibility), a stalled rAF meant the canvas simply
 * stopped being repainted for however long the tab stayed hidden, then
 * "caught up" all at once the moment it became visible again. In the
 * exported video that shows up as a frame frozen for a long stretch,
 * followed by a jump — i.e. exactly the "some frames hang" symptom.
 *
 * The fix: when the document is hidden, fall back to a fixed ~33ms
 * setTimeout instead of rAF. setTimeout keeps firing (browsers clamp it to
 * roughly once per second at worst in background tabs, never fully stop
 * it), so painting keeps making forward progress and beat pacing stays
 * roughly in sync with real elapsed time instead of stalling completely.
 * ------------------------------------------------------------------------- */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof document !== "undefined" && document.hidden) {
      window.setTimeout(() => resolve(), 1000 / 30);
      return;
    }
    requestAnimationFrame(() => resolve());
  });
}

/** Rejects after `ms` — used to hard-bound any single beat so a stuck
 * browser API (most notably SpeechSynthesis) can never freeze the whole
 * export indefinitely. */
function timeoutAfter(ms: number, label: string): Promise<never> {
  return new Promise((_, reject) => {
    window.setTimeout(
      () => reject(new Error(`Timed out waiting for: ${label}`)),
      ms
    );
  });
}

/* ---------------------------------------------------------------------------
 * RENDER VIDEO
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

  onProgress({ stage: "Preparing animation...", percent: 2 });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Canvas is not available in this browser.");
  }

  onProgress({ stage: "Adding voice...", percent: 3 });

  const narrationOk = await audio.captureNarration();
  console.log("[export] Narration capture:", narrationOk);

  audio.ensure();
  audio.apply(audioSettings);

  const { videoCodec, audioCodec, useMp4 } = await pickCodecs(width, height);
  console.log("[export] Codecs selected:", { videoCodec, audioCodec, useMp4 });

  const target = new BufferTarget();

  const output = new Output({
    format: useMp4 ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target,
  });

  const fps = 30;
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

  const audioTracks = audio.dest ? audio.dest.stream.getAudioTracks() : [];

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

  const renderBeatFixed = async (beat: Beat) => {
    const start = performance.now();
    let lastCountdownSecond = -1;

    while (true) {
      if (opts.signal?.cancelled) {
        return;
      }

      const elapsed = (performance.now() - start) / 1000;
      const localTime = Math.min(elapsed, Math.max(0, beat.dur - 0.001));

      drawAt(beat.start + localTime);

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
   * FIX: wrapped with a hard watchdog (timeoutAfter) so that even if
   * audio.speak() itself somehow never resolves (e.g. a browser that
   * doesn't fire onend/onerror AND whose own internal fallback timer gets
   * throttled to death), this beat still terminates and the export moves
   * on, using the word-count estimate as its duration, instead of hanging
   * the whole render forever.
   * --------------------------------------------------------------------- */
  const renderBeatSpeech = async (
    beat: Beat,
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

        await nextFrame();
      }
    };

    const loopPromise = drawLoop();

    // Hard ceiling: never let one beat block the export for more than
    // ~50s regardless of what SpeechSynthesis does.
    const watchdogMs = 50_000;

    let spokenSeconds = 0;

    try {
      spokenSeconds = await Promise.race([
        audio.speak(beat.say!, quiz.language, audioSettings),
        timeoutAfter(watchdogMs, `speech beat "${beat.label}"`),
      ]);
    } catch (err) {
      console.warn(
        "[export] Speech beat watchdog fired — continuing with estimate.",
        beat.label,
        err
      );
      audio.stopSpeech();
      spokenSeconds = 0;
    }

    running = false;
    await loopPromise;

    const actualDur = Math.max(
      0.25,
      spokenSeconds > 0 ? spokenSeconds : estimatedFallbackDur
    );

    drawAt(beat.start + actualDur - 0.001);

    console.log(
      "[export] Speech beat actual duration:",
      beat.kind,
      actualDur.toFixed(2) + "s",
      spokenSeconds > 0 ? "(measured)" : "(fallback estimate — no audio played)"
    );

    return actualDur;
  };

  onProgress({ stage: "Animating character...", percent: 6 });

  await output.start();

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

    console.log("[export] Beat:", index + 1, "/", total, beat.kind, beat.label);

    if (beat.say) {
      onProgress({ stage: "Adding voice...", percent });

      const estimatedFallbackDur = beat.dur;
      beat.dur = 9999;

      const actualDur = await renderBeatSpeech(beat, estimatedFallbackDur);

      beat.dur = actualDur;
      cursor += actualDur;

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

    onProgress({ stage: "Animating character...", percent });

    await renderBeatFixed(beat);
    cursor += beat.dur;

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

  onProgress({ stage: "Finalizing video...", percent: 96 });

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