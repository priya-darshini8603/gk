import { drawFrame } from "./renderer";
import { getState, type Beat, type Timeline } from "./timeline";
import type { AudioSettings, Quiz } from "./types";
import type { AudioEngine } from "./audio";

export type RenderStage =
  | "Preparing animation..."
  | "Verifying narration..."
  | "Animating character..."
  | "Adding voice..."
  | "Finalizing MP4..."
  | "Done";

export interface RenderProgress {
  stage: RenderStage;
  percent: number;
}

/* ---------------------------------------------------------------------------
 * MIME
 * ------------------------------------------------------------------------- */

function pickMime() {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];

  return (
    candidates.find((candidate) =>
      MediaRecorder.isTypeSupported(candidate)
    ) ?? "video/webm"
  );
}

/* ---------------------------------------------------------------------------
 * NEXT FRAME
 * ------------------------------------------------------------------------- */

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/**
 * NEW — shared, user-facing explanation of exactly why narration can't be
 * guaranteed for this export. Thrown instead of silently shipping a video
 * with a video track but no narration.
 */
const NARRATION_CAPTURE_ERROR =
  "Narration couldn't be captured for this export. When the sharing dialog " +
  "opens, choose \"This Tab\" and make sure \"Share tab audio\" is checked " +
  "— that's the only way spoken narration can be included in the video. " +
  "If your browser doesn't support tab-audio sharing (e.g. Safari), video " +
  "export with narration isn't supported there; try Chrome or Edge, or use " +
  "\"Download Audio\" for a narration+SFX-only file instead.";

const NARRATION_SILENT_ERROR =
  "Narration capture was granted, but no actual audio is coming through — " +
  "this usually means a different tab/window/screen was shared instead of " +
  "this one, or \"Share tab audio\" wasn't checked. Click Render again and " +
  "re-select this tab with audio sharing enabled.";

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
 * AUDIO PATH (see AudioEngine for the node graph):
 *   speak() plays via window.speechSynthesis, which cannot be connected to
 *   Web Audio directly. captureNarration() loops that tab's own audio back
 *   in via getDisplayMedia so it can reach voiceGain -> dest -> this
 *   recording's stream. Because that loopback depends on the user's choice
 *   in the browser's sharing dialog, we verify it's actually carrying sound
 *   (see NARRATION CAPTURE / verifyNarrationSignal below) instead of just
 *   trusting that a track object exists, and we hard-fail the export rather
 *   than ever producing a "successful" video with missing narration.
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
   *
   * Narration is only needed if speak() will actually produce sound — this
   * mirrors the exact same gate AudioEngine.speak() uses internally
   * (`settings.muted || settings.voiceVolume <= 0`). If narration is off,
   * we skip the screen-share prompt entirely rather than asking for
   * permission for audio nobody will hear.
   *
   * If narration IS needed, capture failure is now FATAL: we throw before
   * a single frame is recorded, instead of the old behavior of logging a
   * warning and rendering a video with a silent narration track anyway.
   * --------------------------------------------------------------------- */

  const narrationNeeded =
    !audioSettings.muted && audioSettings.voiceVolume > 0;

  if (narrationNeeded) {
    onProgress({ stage: "Adding voice...", percent: 3 });

    const narrationOk = await audio.captureNarration();

    console.log("[export] Narration capture:", narrationOk);

    if (!narrationOk) {
      throw new Error(NARRATION_CAPTURE_ERROR);
    }
  }

  /* -----------------------------------------------------------------------
   * AUDIO
   * --------------------------------------------------------------------- */

  audio.ensure();
  audio.apply(audioSettings);

  /* -----------------------------------------------------------------------
   * VERIFY audio.dest ACTUALLY CONTAINS A LIVE NARRATION TRACK
   *
   * A resolved `captureNarration()` only proves getDisplayMedia returned
   * *some* audio track — it does not prove that track is carrying this
   * tab's real audio (wrong picker selection, silent source, etc). We
   * check track liveness here, then do a real signal check during the
   * first spoken beat below.
   * --------------------------------------------------------------------- */

  if (narrationNeeded) {
    const preflightTracks = audio.dest
      ? audio.dest.stream.getAudioTracks()
      : [];

    const hasLiveTrack =
      audio.hasNarrationCapture &&
      preflightTracks.length > 0 &&
      preflightTracks.every((t) => t.readyState === "live");

    if (!hasLiveTrack) {
      throw new Error(NARRATION_CAPTURE_ERROR);
    }
  }

  /* -----------------------------------------------------------------------
   * RECORDING STREAM
   * --------------------------------------------------------------------- */

  const fps = 30;

  const stream = canvas.captureStream(fps);

  const audioTracks = audio.dest
    ? audio.dest.stream.getAudioTracks()
    : [];

  audioTracks.forEach((track) => {
    stream.addTrack(track);
  });

  // Sanity-check per your requirement: verify audio.dest contains a track
  // before we ever hand the stream to the encoder.
  if (narrationNeeded && stream.getAudioTracks().length === 0) {
    throw new Error(NARRATION_CAPTURE_ERROR);
  }

  const mimeType = pickMime();

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 8_000_000,
  });

  const chunks: BlobPart[] = [];

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  /* -----------------------------------------------------------------------
   * CLEANUP HELPER — used both on normal completion and on any thrown
   * error, so a failed narration-signal check (below) never leaves a
   * MediaRecorder or a getDisplayMedia stream dangling.
   * --------------------------------------------------------------------- */

  let recorderStopped = false;

  const stopRecorderAndTracks = () => {
    if (!recorderStopped && recorder.state !== "inactive") {
      recorderStopped = true;
      try {
        recorder.stop();
      } catch {
        // already stopped/inactive — fine.
      }
    }

    stream.getTracks().forEach((track) => track.stop());
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

  /* -----------------------------------------------------------------------
   * FIXED-DURATION BEAT (no narration to sync to)
   * The beat remains visible for exactly its planned duration.
   * --------------------------------------------------------------------- */

  const renderBeatFixed = async (beat: Beat) => {
    const start = performance.now();

    // Used only for countdown SFX.
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
   * Draws continuously (uncapped) while audio.speak() is actually in
   * flight, and stops the instant that promise resolves — which now
   * happens on the utterance's real 'end' event. The resolved duration
   * IS the beat's real duration; nothing is padded or truncated.
   *
   * If there's no real narration to time against (muted / unsupported /
   * speak() returns 0), we fall back to the original word-count estimate
   * purely so pacing doesn't collapse to zero — never as a target for
   * actual speech.
   *
   * `verifyFirstBeat` runs the AnalyserNode-based signal check (see
   * AudioEngine.verifyNarrationSignal) concurrently with the FIRST spoken
   * beat only. If that check comes back negative — capture is connected
   * but not actually carrying audio — we abort the export immediately
   * instead of finishing a video with silent narration.
   * --------------------------------------------------------------------- */

  let narrationVerified = !narrationNeeded; // nothing to verify if disabled

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

    const shouldVerifyThisBeat = narrationNeeded && !narrationVerified;

    const [spokenSeconds, signalOk] = await Promise.all([
      audio.speak(beat.say!, quiz.language, audioSettings),
      shouldVerifyThisBeat
        ? audio.verifyNarrationSignal(600)
        : Promise.resolve(true),
    ]);

    if (shouldVerifyThisBeat) {
      narrationVerified = true;

      if (!signalOk) {
        running = false;
        await loopPromise;
        throw new Error(NARRATION_SILENT_ERROR);
      }
    }

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

  if (narrationNeeded) {
    onProgress({ stage: "Verifying narration...", percent: 4 });
  }

  onProgress({ stage: "Animating character...", percent: 6 });

  recorder.start(200);

  try {
    /* ---------------------------------------------------------------------
     * PROCESS EVERY BEAT EXACTLY ONCE, IN ORDER
     * ------------------------------------------------------------------- */

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
       * ----------------------------------------------------------------- */

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

        /* -----------------------------------------------------------------
         * SFX AFTER VOICE
         * --------------------------------------------------------------- */

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

    onProgress({ stage: "Finalizing MP4...", percent: 96 });

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(chunks, { type: mimeType }));
      };

      recorderStopped = true;
      recorder.stop();
    });

    stream.getTracks().forEach((track) => track.stop());

    onProgress({ stage: "Done", percent: 100 });

    return {
      blob,
      extension: mimeType.startsWith("video/mp4") ? "mp4" : "webm",
    };
  } catch (err) {
    // Any failure (including the narration-silent check above) must not
    // leave a MediaRecorder running or a getDisplayMedia stream open.
    stopRecorderAndTracks();
    throw err;
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