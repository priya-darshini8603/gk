// lib/quiz/export.ts
import {
  Output,
  Mp4OutputFormat,
  WebMOutputFormat,
  BufferTarget,
  CanvasSource,
  AudioBufferSource,
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
 * WHY THIS FILE LOOKS DIFFERENT FROM A "NORMAL" CANVAS RECORDER
 *
 * The old approach captured the live canvas (`canvas.captureStream()`) and
 * fed it to a MediaStreamVideoTrackSource, driven by a requestAnimationFrame
 * loop. That ties the CORRECTNESS of the output video to how fast the main
 * thread happens to run right now: a slow machine, a backgrounded tab
 * (browsers throttle/pause rAF when hidden), or a GC pause all directly
 * cause dropped/duplicated frames and missed countdown ticks.
 *
 * This version instead:
 *
 *   1. Lets each beat's audio actually play in real time (unavoidable —
 *      SpeechSynthesis has no offline render-to-buffer API), but measures
 *      its TRUE duration from how much audio the AudioWorklet-based PCM
 *      capture actually recorded — not from performance.now() deltas.
 *
 *   2. AFTER a beat's true duration is known, generates its video frames
 *      deterministically and pushes each one explicitly via
 *      CanvasSource.add(timestamp, duration). This never depends on
 *      requestAnimationFrame firing, the tab being visible, or the CPU
 *      keeping up in real time — it just draws frame 0, 1, 2, ... N and
 *      pushes them. Slow machine = slower export, never a broken export.
 *
 *   3. All SFX (including every countdown tick) are scheduled UP FRONT
 *      against the Web Audio clock (sample-accurate, immune to JS thread
 *      jank) instead of being detected reactively inside a draw loop —
 *      that reactive detection is what used to cause skipped numbers.
 *
 *   4. Audio is captured as raw PCM the whole time (off the main thread)
 *      and written once via AudioBufferSource, instead of being muxed
 *      live from a MediaStream.
 * ------------------------------------------------------------------------- */

const VIDEO_BITRATE = 8_000_000;
const AUDIO_BITRATE = 160_000;
const FPS = 30;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function pickCodecs(width: number, height: number, sampleRate: number) {
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
    numberOfChannels: 1, // AudioEngine's PCM capture is mono
    sampleRate,
    bitrate: AUDIO_BITRATE,
  });

  return {
    videoCodec: videoCodec as VideoCodec,
    audioCodec: audioCodec as AudioCodec | null,
    useMp4,
  };
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

  /* -----------------------------------------------------------------------
   * TRY TO KEEP THE TAB AWAKE
   *
   * We no longer depend on rAF to make progress, but we still need real
   * wall-clock time to pass for speech/SFX to actually play and be
   * captured. A screen wake lock reduces (not eliminates — background-tab
   * timer throttling is a separate browser policy) the chance of the
   * render stalling if the user's screen would otherwise sleep.
   * ------------------------------------------------------------------- */
  let wakeLock: WakeLockSentinel | null = null;
  try {
    wakeLock = await navigator.wakeLock?.request?.("screen");
  } catch {
    // Not supported / not permitted — non-fatal, just proceed.
  }

  /* -----------------------------------------------------------------------
   * NARRATION CAPTURE — routes SpeechSynthesis's system audio back into
   * the Web Audio graph so it can be recorded at all.
   * ------------------------------------------------------------------- */

  onProgress({ stage: "Adding voice...", percent: 3 });

  const narrationOk = await audio.captureNarration();
  console.log("[export] Narration capture:", narrationOk);

  audio.ensure();
  audio.apply(audioSettings);

  const sampleRate = audio.sampleRate;

  const { videoCodec, audioCodec, useMp4 } = await pickCodecs(
    width,
    height,
    sampleRate
  );

  console.log("[export] Codecs selected:", { videoCodec, audioCodec, useMp4 });

  const target = new BufferTarget();

  const output = new Output({
    format: useMp4 ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target,
  });

  /* -----------------------------------------------------------------------
   * DETERMINISTIC VIDEO SOURCE
   *
   * Frames are drawn and pushed explicitly with explicit timestamps —
   * never sampled live off a canvas — so nothing here can hang, drop, or
   * duplicate a frame because the machine got busy.
   * ------------------------------------------------------------------- */

  const videoSource = new CanvasSource(canvas, {
    codec: videoCodec,
    bitrate: VIDEO_BITRATE,
  });

  output.addVideoTrack(videoSource, { frameRate: FPS });

  /* -----------------------------------------------------------------------
   * SAMPLE-ACCURATE AUDIO CAPTURE (off the main thread)
   * ------------------------------------------------------------------- */

  let audioSource: AudioBufferSource | null = null;

  if (audioCodec) {
    audioSource = new AudioBufferSource({
      codec: audioCodec,
      bitrate: AUDIO_BITRATE,
    });

    output.addAudioTrack(audioSource);
  } else {
    console.warn(
      "[export] No encodable audio codec available — video will render without sound."
    );
  }

  await audio.startPcmCapture();

  const elapsedAudioSeconds = () => audio.pcmSamplesCaptured / sampleRate;

  /* -----------------------------------------------------------------------
   * RUNTIME TIMELINE — beat start/dur get finalized as beats actually run
   * ------------------------------------------------------------------- */

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

  /**
   * Push exactly round(dur * FPS) frames covering [start, start + dur).
   * Purely computational — not tied to real elapsed time in any way, so
   * it can't skip or hang regardless of machine speed. Slower hardware
   * just makes this loop take longer wall-clock time; it never produces
   * a wrong result.
   */
  const emitFrames = async (start: number, dur: number) => {
    const count = Math.max(1, Math.round(dur * FPS));

    for (let f = 0; f < count; f++) {
      const localT = Math.min(f / FPS, Math.max(0, dur - 1 / FPS / 2));
      drawAt(start + localT);
      await videoSource.add(start + f / FPS, 1 / FPS);
    }
  };

  onProgress({ stage: "Animating character...", percent: 6 });

  await output.start();

  const total = timeline.beats.length;
  let cursor = 0;

  try {
    for (let index = 0; index < total; index++) {
      const beat = runtimeBeats[index];

      if (!beat) continue;
      if (opts.signal?.cancelled) break;

      beat.start = cursor;

      const percent = 6 + Math.round((index / total) * 82);

      console.log(
        "[export] Beat:",
        index + 1,
        "/",
        total,
        beat.kind,
        beat.label
      );

      // Ground-truth measurement point: how much audio has been
      // captured right before this beat's real-time actions begin.
      const audioStart = elapsedAudioSeconds();

      if (beat.say) {
        /* --------------------------- SPEECH BEAT --------------------------- */
        onProgress({ stage: "Adding voice...", percent });

        await audio.speak(beat.say, quiz.language, audioSettings);

        if (beat.kind === "read-question") {
          audio.sfx("board");
        }

        if (beat.kind === "read-option") {
          audio.sfx("point");
        }

        if (beat.kind === "reveal") {
          audio.sfx("correct");
          await sleep(150);
          audio.sfx("confetti");
        }
      } else {
        /* ------------------------- FIXED-DURATION BEAT ---------------------- */
        onProgress({ stage: "Animating character...", percent });

        // Schedule every sound up front against the Web Audio clock —
        // sample accurate, immune to any JS-thread jank. This replaces
        // the old "poll every frame and see if we crossed a tick
        // boundary" logic, which is exactly what used to skip numbers.
        if (beat.kind === "question-in") {
          audio.sfx("board", 0);
        }

        if (beat.kind === "options-in") {
          [0, 0.22, 0.44, 0.66].forEach((d) => audio.sfx("pop", d));
        }

        if (beat.kind === "countdown") {
          for (let i = 0; i < beat.dur; i++) {
            audio.sfx("tick", i);
          }
          audio.sfx("final", beat.dur);
        }

        if (beat.kind === "celebrate") {
          audio.sfx("cheer", 0);
        }

        // Let real time pass — plain setTimeout, NOT requestAnimationFrame,
        // so a backgrounded/minimized tab doesn't fully stall this.
        await sleep(beat.dur * 1000);
      }

      // Give the AudioWorklet's queued messages a moment to flush before
      // we trust the sample count as ground truth.
      await sleep(30);

      const actualDur = Math.max(0.15, elapsedAudioSeconds() - audioStart);
      beat.dur = actualDur;

      await emitFrames(cursor, actualDur);
      cursor += actualDur;
    }

    runtimeTimeline.duration = cursor;

    onProgress({ stage: "Finalizing video...", percent: 90 });

    // Catch any trailing narration and let the worklet flush its last
    // chunk(s) before we stop capturing.
    await audio.waitForSpeechEnd();
    await sleep(120);

    const { samples, sampleRate: capturedRate } = audio.stopPcmCapture();

    if (audioSource && samples.length) {
      const audioCtx = audio.ensure();

      if (audioCtx) {
        const buffer = audioCtx.createBuffer(
          1,
          samples.length,
          capturedRate
        );

        buffer.copyToChannel(samples, 0);

        await audioSource.add(buffer);
      }
    }

    videoSource.close();
    audioSource?.close();

    await output.finalize();

    if (!target.buffer) {
      throw new Error("Mediabunny did not produce any output data.");
    }

    const blob = new Blob([target.buffer], { type: output.format.mimeType });

    onProgress({ stage: "Done", percent: 100 });

    return {
      blob,
      extension: useMp4 ? "mp4" : "webm",
    };
  } finally {
    try {
      wakeLock?.release();
    } catch {
      /* ignore */
    }
  }
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