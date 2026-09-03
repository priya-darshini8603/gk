import { drawFrame } from "./renderer";
import { getState, type Beat, type Timeline } from "./timeline";
import type { AudioSettings, Quiz } from "./types";
import type { AudioEngine } from "./audio";

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

  recorder.start(200);

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

  onProgress({ stage: "Finalizing MP4...", percent: 96 });

  const blob = await new Promise<Blob>((resolve) => {
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: mimeType }));
    };

    recorder.stop();
  });

  stream.getTracks().forEach((track) => track.stop());

  onProgress({ stage: "Done", percent: 100 });

  return {
    blob,
    extension: mimeType.startsWith("video/mp4") ? "mp4" : "webm",
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