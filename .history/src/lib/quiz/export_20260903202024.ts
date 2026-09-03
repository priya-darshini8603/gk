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
 * FRAME PACING
 *
 * FIX (hang): this used to be `requestAnimationFrame`. rAF is fully paused
 * by the browser whenever the document is hidden/unfocused. Since export
 * runs in real time (it has to — narration audio and its capture are live),
 * a user alt-tabbing during a render used to freeze the whole `while(true)`
 * loop forever, because `await nextFrame()` would just never resolve again.
 * setTimeout keeps firing (throttled, but never fully paused) in background
 * tabs, so the export always keeps making progress even if the person
 * switches away.
 * ------------------------------------------------------------------------- */

function nextFrame() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
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

  /* -----------------------------------------------------------------------
   * RECORDING STREAM
   *
   * FIX (skipped frames): `canvas.captureStream(fps)` auto-samples the
   * canvas on its own timer, independent of when we actually draw. If our
   * loop stalls, it just re-captures whatever's already on the canvas —
   * a state (e.g. a countdown number) that was only drawn for a moment
   * between two stalled callbacks can be lost entirely.
   *
   * `canvas.captureStream(0)` puts the track into manual/on-demand mode:
   * nothing is captured until we call `track.requestFrame()` ourselves.
   * We call that right after every draw (see `drawAt` below), including
   * every "caught up" countdown second, so every state we actually render
   * is guaranteed to land in the output as its own frame — nothing is ever
   * silently dropped because the browser happened to sample at the wrong
   * moment.
   *
   * Falls back to automatic sampling on browsers without requestFrame().
   * --------------------------------------------------------------------- */

  const fps = 30;

  let stream = canvas.captureStream(0);
  let videoTrack = stream.getVideoTracks()[0];

  const manualCaptureSupported =
    !!videoTrack &&
    typeof (videoTrack as unknown as { requestFrame?: () => void })
      .requestFrame === "function";

  if (!manualCaptureSupported) {
    console.warn(
      "[export] Manual canvas frame capture (requestFrame) isn't supported here — " +
        "falling back to automatic sampling. Skipped frames are more likely if the " +
        "tab is backgrounded or the machine is under load."
    );

    stream.getTracks().forEach((t) => t.stop());
    stream = canvas.captureStream(fps);
    videoTrack = stream.getVideoTracks()[0];
  }

  if (!videoTrack) {
    throw new Error("Unable to capture the canvas as a video track.");
  }

  const captureFrame = () => {
    if (manualCaptureSupported) {
      (videoTrack as unknown as { requestFrame: () => void }).requestFrame();
    }
    // Otherwise the automatic captureStream(fps) timer handles it.
  };

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

  // Every draw now also pushes that exact state into the recorded stream,
  // so nothing we render can fail to show up in the output.
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

    captureFrame();
  };

  /* -----------------------------------------------------------------------
   * FIXED-DURATION BEAT (no narration to sync to)
   *
   * FIX (skipped countdown numbers): instead of only reacting to "what's
   * the current second right now", we track the next second we still owe
   * a tick for and, on every loop iteration, catch up through every second
   * we've now passed — oldest first. If the loop gets delayed past several
   * seconds (a stall, a backgrounded tab), every one of those seconds still
   * gets its own drawAt() (and therefore its own captured frame) and its
   * own tick sound, just fired back-to-back instead of missed entirely.
   * --------------------------------------------------------------------- */

  const renderBeatFixed = async (beat: Beat) => {
    const start = performance.now();

    let owedSecond = beat.kind === "countdown" ? Math.ceil(beat.dur) : null;

    while (true) {
      if (opts.signal?.cancelled) {
        return;
      }

      const elapsed = (performance.now() - start) / 1000;
      const localTime = Math.min(elapsed, Math.max(0, beat.dur - 0.001));

      if (beat.kind === "countdown" && owedSecond !== null) {
        const remaining = Math.ceil(beat.dur - elapsed);

        while (owedSecond >= 1 && owedSecond >= remaining) {
          const secondLocalTime = Math.min(
            Math.max(0, beat.dur - owedSecond),
            Math.max(0, beat.dur - 0.001)
          );

          drawAt(beat.start + secondLocalTime);
          audio.sfx("tick");

          console.log("[export] Countdown tick:", owedSecond);

          owedSecond -= 1;
        }
      }

      drawAt(beat.start + localTime);

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

    const spokenSeconds = await audio.speak(
      beat.say!,
      quiz.language,
      audioSettings
    );

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

  /* -----------------------------------------------------------------------
   * RENDER START
   * --------------------------------------------------------------------- */

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