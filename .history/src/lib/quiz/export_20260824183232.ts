import { drawFrame } from "./renderer";
import {
  cloneTimeline,
  extendBeatDuration,
  getState,
  type Timeline,
} from "./timeline";
import type {
  AudioSettings,
  Quiz,
} from "./types";
import type {
  AudioEngine,
} from "./audio";

export type RenderStage =
  | "Preparing animation..."
  | "Animating character..."
  | "Adding voice..."
  | "Rendering video..."
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
      MediaRecorder.isTypeSupported(candidate),
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
 * EXACT ORDER:
 *
 * Question
 * Options
 * Timer
 * Answer
 * Celebration
 * Explanation
 * END CARD
 *
 * The end card is processed only when the timeline reaches its single
 * final endcard beat.
 *
 * FIXED: narration completion (explanation AND the end card's own line)
 * is now driven entirely by SpeechSynthesisUtterance.onend, via
 * audio.speak() resolving on real completion (see audio.ts). No beat is
 * ever advanced past while its narration is still speaking, and no
 * artificial timeout can truncate it early. If real narration runs longer
 * than the beat's estimated duration, the beat (and every beat after it,
 * i.e. the end card) is pushed out to make room — never cut, never
 * overlapped, never skipped.
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
    signal?: {
      cancelled: boolean;
    };
  },
): Promise<{
  blob: Blob;
  extension: string;
}> {
  const {
    quiz,
    timeline: sourceTimeline,
    width,
    height,
    audio,
    audioSettings,
    onProgress,
  } = opts;

  // Clone so we can safely stretch beat durations to match actual narration
  // length without mutating the timeline object the caller (preview UI,
  // CSV batch panel) may still be holding onto.
  const timeline = cloneTimeline(sourceTimeline);

  /* -----------------------------------------------------------------------
   * PREPARE
   * --------------------------------------------------------------------- */

  onProgress({
    stage: "Preparing animation...",
    percent: 2,
  });

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

  onProgress({
    stage: "Adding voice...",
    percent: 3,
  });

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

  const audioTracks = audio.dest ? audio.dest.stream.getAudioTracks() : [];

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
   * DRAW ONE FRAME
   * --------------------------------------------------------------------- */

  const runKey = Math.random();

  const drawAt = (time: number) => {
    const safeTime = Math.max(
      0,
      Math.min(time, Math.max(0, timeline.duration - 0.001)),
    );

    drawFrame(
      ctx,
      quiz,
      getState(timeline, quiz, safeTime),
      width,
      height,
      runKey,
    );
  };

  /* -----------------------------------------------------------------------
   * RENDER ONE BEAT
   *
   * The beat remains visible for its own duration. If `speechDonePromise`
   * is provided, the beat will NOT end until BOTH its own visual duration
   * has elapsed AND the narration promise has resolved — whichever takes
   * longer wins. This is what lets a long explanation or end-card line
   * extend its beat instead of getting cut off mid-sentence.
   * --------------------------------------------------------------------- */

  const renderBeat = async (
    beat: Timeline["beats"][number],
    speechDonePromise?: Promise<void>,
  ) => {
    const start = performance.now();

    // Used only for countdown SFX.
    let lastCountdownSecond = -1;

    let speechDone = !speechDonePromise;

    if (speechDonePromise) {
      void speechDonePromise.then(() => {
        speechDone = true;
      });
    }

    while (true) {
      if (opts.signal?.cancelled) {
        return;
      }

      const elapsed = (performance.now() - start) / 1000;

      const localTime = Math.min(elapsed, Math.max(0, beat.dur - 0.001));

      drawAt(beat.start + localTime);

      /*
       * ---------------------------------------------------------
       * COUNTDOWN SFX
       *
       * Play exactly once for each countdown number.
       * ---------------------------------------------------------
       */
      if (beat.kind === "countdown") {
        const remaining = Math.ceil(beat.dur - elapsed);

        if (remaining > 0 && remaining !== lastCountdownSecond) {
          lastCountdownSecond = remaining;

          audio.sfx("tick");

          console.log("[export] Countdown tick:", remaining);
        }
      }

      /*
       * Only stop once the beat's own duration has elapsed AND (for
       * speech beats) narration has genuinely finished speaking.
       */
      if (elapsed >= beat.dur && speechDone) {
        break;
      }

      await nextFrame();
    }

    /*
     * Countdown finished.
     *
     * Play the final countdown sound once.
     */
    if (beat.kind === "countdown") {
      audio.sfx("final");

      console.log("[export] Countdown finished");
    }
  };

  /* -----------------------------------------------------------------------
   * RENDER START
   * --------------------------------------------------------------------- */

  onProgress({
    stage: "Animating character...",
    percent: 6,
  });

  recorder.start(200);

  /* -----------------------------------------------------------------------
   * PROCESS EVERY BEAT EXACTLY ONCE
   * --------------------------------------------------------------------- */

  const total = timeline.beats.length;

  for (let index = 0; index < total; index++) {
    const beat = timeline.beats[index];

    if (!beat) {
      continue;
    }

    if (opts.signal?.cancelled) {
      break;
    }

    const percent = 6 + Math.round((index / total) * 88);

    console.log(
      "[export] Beat:",
      index + 1,
      "/",
      total,
      beat.kind,
      beat.label,
    );

    /* ---------------------------------------------------------------------
     * SPEECH BEAT
     * ------------------------------------------------------------------- */

    if (beat.say) {
      onProgress({
        stage: beat.kind === "endcard" ? "Rendering video..." : "Adding voice...",
        percent,
      });

      /*
       * Start narration and the visual beat together. audio.speak() now
       * resolves ONLY on the real SpeechSynthesisUtterance `onend`/`onerror`
       * event (see audio.ts) — that promise is the single source of truth
       * for "narration is done". renderBeat will keep this beat on screen
       * until that promise resolves, no matter how long it takes.
       */
      const speakStart = performance.now();

      const speakPromise = audio.speak(beat.say, quiz.language, audioSettings);

      await renderBeat(beat, speakPromise);

      // Guaranteed already resolved (renderBeat only exits once
      // speechDone is true), but await explicitly for clarity/safety.
      await speakPromise;

      const actualSpeechSeconds = (performance.now() - speakStart) / 1000;

      /*
       * If real narration ran longer than the word-count estimate that
       * originally sized this beat, permanently stretch it (and shift
       * every beat after it, including the end card) so the timeline's
       * beat/start/duration data stays consistent with what was actually
       * shown and heard. This is what satisfies "explanation runs 8s but
       * only 4s was allocated -> extend to 8s, then play the end card
       * normally" for BOTH the explanation beat and the end card's own
       * narration.
       */
      if (actualSpeechSeconds > beat.dur) {
        console.log(
          "[export] Extending beat",
          beat.kind,
          "from",
          beat.dur.toFixed(2),
          "s to",
          actualSpeechSeconds.toFixed(2),
          "s to match actual narration.",
        );

        extendBeatDuration(timeline, index, actualSpeechSeconds);
      }

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

      /*
       * END CARD:
       *
       * No special rendering here.
       *
       * renderBeat(beat, speakPromise) has already displayed the end card
       * for its full duration AND waited for its narration to completely
       * finish (via onend). This is the ONLY end card, it is guaranteed
       * to be the final beat in the timeline, and it is never rendered or
       * replayed anywhere else.
       */
      if (beat.kind === "endcard") {
        console.log("[export] Final end card completed — narration fully heard.");
      }

      continue;
    }

    /* ---------------------------------------------------------------------
     * NON-SPEECH BEAT
     * ------------------------------------------------------------------- */

    onProgress({
      stage: "Animating character...",
      percent,
    });

    await renderBeat(beat);

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

  /* -----------------------------------------------------------------------
   * FINAL AUDIO WAIT
   *
   * Defensive safety net only. By this point the end card's own narration
   * has already been fully awaited above (its speak() promise resolved via
   * onend before the loop could exit), so speechSynthesis.speaking should
   * already be false and this returns immediately. It exists purely to
   * guard against a browser that fails to fire any completion event at
   * all — it must never be relied on to enforce end-card timing.
   *
   * This does NOT render anything and does NOT render another end card.
   * --------------------------------------------------------------------- */

  await audio.waitForSpeechEnd(5000);

  /* -----------------------------------------------------------------------
   * FINALIZE
   * --------------------------------------------------------------------- */

  onProgress({
    stage: "Finalizing MP4...",
    percent: 96,
  });

  const blob = await new Promise<Blob>((resolve) => {
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: mimeType }));
    };

    recorder.stop();
  });

  stream.getTracks().forEach((track) => track.stop());

  onProgress({
    stage: "Done",
    percent: 100,
  });

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