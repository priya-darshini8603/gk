import { drawFrame } from "./renderer";
import {
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
    candidates.find(
      (candidate) =>
        MediaRecorder.isTypeSupported(
          candidate,
        ),
    ) ??
    "video/webm"
  );
}

/* ---------------------------------------------------------------------------
 * NEXT FRAME
 * ------------------------------------------------------------------------- */

function nextFrame() {
  return new Promise<void>(
    (resolve) => {
      requestAnimationFrame(
        () => resolve(),
      );
    },
  );
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
 * ------------------------------------------------------------------------- */

export async function renderVideo(
  opts: {
    quiz: Quiz;
    timeline: Timeline;
    width: number;
    height: number;
    audio: AudioEngine;
    audioSettings: AudioSettings;
    onProgress: (
      progress: RenderProgress,
    ) => void;
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
    timeline,
    width,
    height,
    audio,
    audioSettings,
    onProgress,
  } = opts;

  /* -----------------------------------------------------------------------
   * PREPARE
   * --------------------------------------------------------------------- */

  onProgress({
    stage:
      "Preparing animation...",
    percent: 2,
  });

  const canvas =
    document.createElement(
      "canvas",
    );

  canvas.width = width;
  canvas.height = height;

  const ctx =
    canvas.getContext("2d");

  if (!ctx) {
    throw new Error(
      "Canvas is not available in this browser.",
    );
  }

  /* -----------------------------------------------------------------------
   * NARRATION CAPTURE
   * --------------------------------------------------------------------- */

  onProgress({
    stage:
      "Adding voice...",
    percent: 3,
  });

  const narrationOk =
    await audio.captureNarration();

  console.log(
    "[export] Narration capture:",
    narrationOk,
  );

  /* -----------------------------------------------------------------------
   * AUDIO
   * --------------------------------------------------------------------- */

  audio.ensure();

  audio.apply(
    audioSettings,
  );

  /* -----------------------------------------------------------------------
   * RECORDING STREAM
   * --------------------------------------------------------------------- */

  const fps = 30;

  const stream =
    canvas.captureStream(
      fps,
    );

  const audioTracks =
    audio.dest
      ? audio.dest.stream.getAudioTracks()
      : [];

  audioTracks.forEach(
    (track) => {
      stream.addTrack(track);
    },
  );

  const mimeType =
    pickMime();

  const recorder =
    new MediaRecorder(
      stream,
      {
        mimeType,
        videoBitsPerSecond:
          8_000_000,
      },
    );

  const chunks: BlobPart[] =
    [];

  recorder.ondataavailable =
    (event) => {
      if (
        event.data.size > 0
      ) {
        chunks.push(
          event.data,
        );
      }
    };

  /* -----------------------------------------------------------------------
   * DRAW ONE FRAME
   * --------------------------------------------------------------------- */

  const runKey =
    Math.random();

  const drawAt = (
    time: number,
  ) => {
    const safeTime =
      Math.max(
        0,
        Math.min(
          time,
          Math.max(
            0,
            timeline.duration -
              0.001,
          ),
        ),
      );

    drawFrame(
      ctx,
      quiz,
      getState(
        timeline,
        quiz,
        safeTime,
      ),
      width,
      height,
      runKey,
    );
  };

  /* -----------------------------------------------------------------------
   * RENDER ONE BEAT
   *
   * The beat remains visible for its own duration.
   * --------------------------------------------------------------------- */

  const renderBeat = async (
  beat: Timeline["beats"][number],
) => {
  const start = performance.now();

  // Used only for countdown SFX.
  let lastCountdownSecond = -1;

  while (true) {
    if (opts.signal?.cancelled) {
      return;
    }

    const elapsed =
      (performance.now() - start) / 1000;

    const localTime = Math.min(
      elapsed,
      Math.max(0, beat.dur - 0.001),
    );

    drawAt(
      beat.start + localTime,
    );

    /*
     * ---------------------------------------------------------
     * COUNTDOWN SFX
     *
     * Play exactly once for each countdown number.
     *
     * Example for 5 seconds:
     *
     * 5 -> tick
     * 4 -> tick
     * 3 -> tick
     * 2 -> tick
     * 1 -> tick
     * 0 -> final
     * ---------------------------------------------------------
     */
    if (beat.kind === "countdown") {
      const remaining = Math.ceil(
        beat.dur - elapsed,
      );

      /*
       * Only play while the countdown number
       * is actually changing.
       */
      if (
        remaining > 0 &&
        remaining !== lastCountdownSecond
      ) {
        lastCountdownSecond =
          remaining;

        audio.sfx("tick");

        console.log(
          "[export] Countdown tick:",
          remaining,
        );
      }
    }

    if (
      elapsed >= beat.dur
    ) {
      break;
    }

    await nextFrame();
  }

  /*
   * Countdown finished.
   *
   * Play the final countdown sound once.
   */
  if (
    beat.kind === "countdown"
  ) {
    audio.sfx("final");

    console.log(
      "[export] Countdown finished",
    );
  }
};
  /* -----------------------------------------------------------------------
   * RENDER START
   * --------------------------------------------------------------------- */

  onProgress({
    stage:
      "Animating character...",
    percent: 6,
  });

  recorder.start(200);

  /* -----------------------------------------------------------------------
   * PROCESS EVERY BEAT EXACTLY ONCE
   * --------------------------------------------------------------------- */

  const total =
    timeline.beats.length;

  for (
    let index = 0;
    index < total;
    index++
  ) {
    const beat =
      timeline.beats[index];

    if (!beat) {
      continue;
    }

    if (
      opts.signal?.cancelled
    ) {
      break;
    }

    const percent =
      6 +
      Math.round(
        (index / total) *
          88,
      );

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
        stage:
          "Adding voice...",
        percent,
      });

      /*
       * Run the visual beat and speech simultaneously.
       *
       * audio.speak() MUST resolve only after the actual
       * SpeechSynthesis utterance finishes.
       */
      await Promise.all([
        renderBeat(beat),

        audio.speak(
          beat.say,
          quiz.language,
          audioSettings,
        ),
      ]);

      /*
       * Make sure Chrome is completely finished.
       */
      await audio.waitForSpeechEnd(
        2000,
      );

      /* ---------------------------------------------------------------
       * SFX AFTER VOICE
       * ------------------------------------------------------------- */

      if (
        beat.kind ===
        "read-question"
      ) {
        audio.sfx(
          "board",
        );
      }

      if (
        beat.kind ===
        "read-option"
      ) {
        audio.sfx(
          "point",
        );
      }

      if (
        beat.kind ===
        "reveal"
      ) {
        audio.sfx(
          "correct",
        );

        await new Promise<void>(
          (resolve) =>
            setTimeout(
              resolve,
              150,
            ),
        );

        audio.sfx(
          "confetti",
        );
      }

      continue;
    }

    /* ---------------------------------------------------------------------
     * NON-SPEECH BEAT
     * ------------------------------------------------------------------- */

    onProgress({
      stage:
        "Animating character...",
      percent,
    });

    await renderBeat(
      beat,
    );

    /* ---------------------------------------------------------------------
     * SFX AFTER VISUAL MOVEMENT
     * ------------------------------------------------------------------- */

    if (
      beat.kind ===
      "question-in"
    ) {
      audio.sfx(
        "board",
      );
    }

    if (
      beat.kind ===
      "options-in"
    ) {
      audio.sfx(
        "pop",
      );
    }

    if (
      beat.kind ===
      "countdown"
    ) {
      audio.sfx(
        "final",
      );
    }

    if (
      beat.kind ===
      "celebrate"
    ) {
      audio.sfx(
        "cheer",
      );
    }
  }

  /* -----------------------------------------------------------------------
   * FINAL AUDIO WAIT
   *
   * This does NOT render anything.
   * --------------------------------------------------------------------- */

  await audio.waitForSpeechEnd(
    5000,
  );

  /* -----------------------------------------------------------------------
   * FINALIZE
   * --------------------------------------------------------------------- */

  onProgress({
    stage:
      "Finalizing MP4...",
    percent: 96,
  });

  const blob =
    await new Promise<Blob>(
      (resolve) => {
        recorder.onstop =
          () => {
            resolve(
              new Blob(
                chunks,
                {
                  type:
                    mimeType,
                },
              ),
            );
          };

        recorder.stop();
      },
    );

  stream
    .getTracks()
    .forEach(
      (track) =>
        track.stop(),
    );

  onProgress({
    stage: "Done",
    percent: 100,
  });

  return {
    blob,
    extension:
      mimeType.startsWith(
        "video/mp4",
      )
        ? "mp4"
        : "webm",
  };
}

/* ---------------------------------------------------------------------------
 * DOWNLOAD
 * ------------------------------------------------------------------------- */

export function downloadBlob(
  blob: Blob,
  filename: string,
) {
  const url =
    URL.createObjectURL(
      blob,
    );

  const a =
    document.createElement(
      "a",
    );

  a.href = url;
  a.download = filename;

  document.body.appendChild(
    a,
  );

  a.click();

  a.remove();

  setTimeout(
    () => {
      URL.revokeObjectURL(
        url,
      );
    },
    4000,
  );
}