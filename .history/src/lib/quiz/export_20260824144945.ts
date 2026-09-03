import {
  drawFrame,
} from "./renderer";

import {
  getState,
  type Beat,
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
 * SMALL FRAME DELAY
 * ------------------------------------------------------------------------- */

const nextFrame =
  () =>
    new Promise<void>(
      (resolve) =>
        requestAnimationFrame(
          () => resolve(),
        ),
    );

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
    "[export] Narration capture ready:",
    narrationOk,
  );

  if (!narrationOk) {
    console.warn(
      "[export] Narration capture was not available.",
    );
  }

  /* -----------------------------------------------------------------------
   * AUDIO MIX
   * --------------------------------------------------------------------- */

  const fps = 30;

  const stream =
    canvas.captureStream(
      fps,
    );

  audio.ensure();

  audio.apply(
    audioSettings,
  );

  const audioTracks =
    audio.dest
      ? audio.dest.stream.getAudioTracks()
      : [];

  audioTracks.forEach(
    (track) =>
      stream.addTrack(track),
  );

  console.log(
    "[export] Audio tracks:",
    stream.getAudioTracks()
      .length,
  );

  /* -----------------------------------------------------------------------
   * RECORDER
   * --------------------------------------------------------------------- */

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
        event.data.size
      ) {
        chunks.push(
          event.data,
        );
      }
    };

  /* -----------------------------------------------------------------------
   * DRAWING
   *
   * The animation clock is now controlled by the actual render sequence.
   * Speech can extend a beat without cutting it off.
   * --------------------------------------------------------------------- */

  const runKey =
    Math.random();

  let currentTime = 0;

  let rendering = true;

  const drawAt = (
    time: number,
  ) => {
    drawFrame(
      ctx,
      quiz,
      getState(
        timeline,
        quiz,
        time,
      ),
      width,
      height,
      runKey,
    );
  };

  /*
   * Continuous drawing loop.
   *
   * It does NOT control when speech ends.
   * It only keeps the canvas animated while
   * the audio sequence is running.
   */
  const animationStart =
    performance.now();

  const animationLoop =
    () => {
      if (!rendering) {
        return;
      }

      const elapsed =
        (performance.now() -
          animationStart) /
        1000;

      /*
       * Use the current actual timeline position.
       *
       * It is clamped so the state machine never
       * goes beyond the last timeline beat.
       */
      const stateTime =
        Math.min(
          elapsed,
          timeline.duration -
            0.001,
        );

      drawAt(
        Math.max(
          0,
          stateTime,
        ),
      );

      requestAnimationFrame(
        animationLoop,
      );
    };

  requestAnimationFrame(
    animationLoop,
  );

  /* -----------------------------------------------------------------------
   * RECORD
   * --------------------------------------------------------------------- */

  recorder.start(200);

  onProgress({
    stage:
      "Animating character...",
    percent: 6,
  });

  /* -----------------------------------------------------------------------
   * PROCESS ONE BEAT
   *
   * This is the important synchronization engine.
   * --------------------------------------------------------------------- */

  const processBeat =
    async (
      beat: Beat,
    ) => {
      if (
        opts.signal?.cancelled
      ) {
        return;
      }

      /*
       * --------------------------------------------------
       * SPEECH BEAT
       * --------------------------------------------------
       *
       * Wait for the COMPLETE utterance.
       */
      if (
        beat.say
      ) {
        /*
         * Keep animation visible while speaking.
         */
        onProgress({
          stage:
            "Adding voice...",
          percent: 30,
        });

        await audio.speak(
          beat.say,
          quiz.language,
          audioSettings,
        );

        /*
         * Extra safety.
         */
        await audio.waitForSpeechEnd(
          1000,
        );

        /*
         * ------------------------------------------------
         * AFTER QUESTION SPEECH
         * ------------------------------------------------
         */

        if (
          beat.kind ===
          "read-question"
        ) {
          /*
           * Question voice is finished.
           * NOW trigger the board SFX.
           */
          audio.sfx(
            "board",
          );

          /*
           * Small visual action window.
           */
          await holdVisual(
            0.45,
          );

          return;
        }

        /*
         * ------------------------------------------------
         * AFTER OPTION SPEECH
         * ------------------------------------------------
         */

        if (
          beat.kind ===
          "read-option"
        ) {
          /*
           * Option voice is completely finished.
           * NOW trigger the point SFX.
           */
          audio.sfx(
            "point",
          );

          await holdVisual(
            0.25,
          );

          return;
        }

        /*
         * ------------------------------------------------
         * AFTER ANSWER SPEECH
         * ------------------------------------------------
         */

        if (
          beat.kind ===
          "reveal"
        ) {
          audio.sfx(
            "correct",
          );

          await holdVisual(
            0.3,
          );

          audio.sfx(
            "confetti",
          );

          return;
        }

        /*
         * ------------------------------------------------
         * EXPLANATION
         * ------------------------------------------------
         *
         * Nothing else happens until the
         * explanation has completely finished.
         */
        if (
          beat.kind ===
          "explanation"
        ) {
          await holdVisual(
            0.25,
          );

          return;
        }

        /*
         * INTRO / END CARD
         */
        return;
      }

      /* -------------------------------------------------------------------
       * NON-SPEECH BEATS
       * ----------------------------------------------------------------- */

      if (
        beat.kind ===
        "enter"
      ) {
        await holdVisual(
          beat.dur,
        );

        return;
      }

      if (
        beat.kind ===
        "question-in"
      ) {
        await holdVisual(
          beat.dur,
        );

        return;
      }

      if (
        beat.kind ===
        "options-in"
      ) {
        /*
         * Options movement occurs here,
         * BEFORE their voices.
         *
         * The options are now visible before
         * the owl reads them.
         */
        audio.sfx(
          "pop",
        );

        await holdVisual(
          beat.dur,
        );

        return;
      }

      if (
        beat.kind ===
        "countdown"
      ) {
        /*
         * Timer starts ONLY after every option
         * narration has finished.
         */
        await holdVisual(
          beat.dur,
        );

        /*
         * Final timer SFX happens once.
         */
        audio.sfx(
          "final",
        );

        return;
      }

      if (
        beat.kind ===
        "celebrate"
      ) {
        audio.sfx(
          "cheer",
        );

        await holdVisual(
          beat.dur,
        );

        return;
      }

      if (
        beat.kind ===
        "endcard"
      ) {
        await holdVisual(
          beat.dur,
        );

        return;
      }

      await holdVisual(
        beat.dur,
      );
    };

  /* -----------------------------------------------------------------------
   * HOLD VISUAL
   *
   * This waits in real time while the canvas keeps animating.
   * --------------------------------------------------------------------- */

  async function holdVisual(
    seconds: number,
  ) {
    const start =
      performance.now();

    while (
      performance.now() -
        start <
      seconds * 1000
    ) {
      if (
        opts.signal?.cancelled
      ) {
        return;
      }

      await nextFrame();
    }
  }

  /* -----------------------------------------------------------------------
   * SEQUENTIAL BEAT PROCESSING
   *
   * THIS replaces the old timestamp-based cue processing.
   *
   * Old:
   *
   *   t >= cue.t
   *       -> fire everything
   *
   * New:
   *
   *   beat starts
   *       ↓
   *   speech
   *       ↓
   *   WAIT onend
   *       ↓
   *   SFX
   *       ↓
   *   next beat
   * --------------------------------------------------------------------- */

  for (
    const beat of timeline.beats
  ) {
    if (
      opts.signal?.cancelled
    ) {
      break;
    }

    await processBeat(
      beat,
    );
  }

  /* -----------------------------------------------------------------------
   * FINAL SPEECH SAFETY
   * --------------------------------------------------------------------- */

  await audio.waitForSpeechEnd(
    10000,
  );

  rendering = false;

  /*
   * Draw one final frame.
   */
  drawAt(
    Math.max(
      0,
      timeline.duration -
        0.001,
    ),
  );

  /* -----------------------------------------------------------------------
   * STOP MUSIC
   * --------------------------------------------------------------------- */

  audio.stopMusic();

  /* -----------------------------------------------------------------------
   * FINALIZE
   * --------------------------------------------------------------------- */

  onProgress({
    stage:
      "Finalizing MP4...",
    percent: 94,
  });

  const blob: Blob =
    await new Promise(
      (resolve) => {
        recorder.onstop =
          () => {
            resolve(
              new Blob(
                chunks,
                {
                  type: mimeType,
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

  console.log(
    "[export] Recorded blob size:",
    (
      blob.size / 1e6
    ).toFixed(2),
    "MB",
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

  const anchor =
    document.createElement(
      "a",
    );

  anchor.href = url;
  anchor.download =
    filename;

  document.body.appendChild(
    anchor,
  );

  anchor.click();

  anchor.remove();

  window.setTimeout(
    () =>
      URL.revokeObjectURL(
        url,
      ),
    1000,
  );
}