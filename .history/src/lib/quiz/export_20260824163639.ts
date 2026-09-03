import { drawFrame } from "./renderer";
import {
  getState,
  type Beat,
  type Timeline,
} from "./timeline";
import type {
  AudioSettings,
  Quiz,
} from "./types";
import type { AudioEngine } from "./audio";

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
    candidates.find((c) =>
      MediaRecorder.isTypeSupported(c),
    ) ?? "video/webm"
  );
}

/* ---------------------------------------------------------------------------
 * NEXT FRAME
 * ------------------------------------------------------------------------- */

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/* ---------------------------------------------------------------------------
 * RENDER VIDEO
 * ------------------------------------------------------------------------- */

export async function renderVideo(opts: {
  quiz: Quiz;
  timeline: Timeline;
  width: number;
  height: number;
  audio: AudioEngine;
  audioSettings: AudioSettings;
  onProgress: (p: RenderProgress) => void;
  signal?: { cancelled: boolean };
}): Promise<{
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
   * PREPARE CANVAS
   * --------------------------------------------------------------------- */

  onProgress({
    stage: "Preparing animation...",
    percent: 2,
  });

  const canvas =
    document.createElement("canvas");

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
    stage: "Adding voice...",
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
      "[export] Narration capture was declined or unsupported.",
    );
  }

  /* -----------------------------------------------------------------------
   * AUDIO
   * --------------------------------------------------------------------- */

  const fps = 30;

  const stream =
    canvas.captureStream(fps);

  audio.ensure();

  audio.apply(
    audioSettings,
  );

  const audioTracks =
    audio.dest
      ? audio.dest.stream.getAudioTracks()
      : [];

  console.log(
    "[export] Mixed destination audio tracks:",
    audioTracks.length,
  );

  audioTracks.forEach((track) => {
    stream.addTrack(track);
  });

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

  const chunks: BlobPart[] = [];

  recorder.ondataavailable = (
    event,
  ) => {
    if (event.data.size > 0) {
      chunks.push(
        event.data,
      );
    }
  };

  console.log(
    "[export] MediaRecorder audio tracks:",
    stream.getAudioTracks()
      .length,
  );

  console.log(
    "[export] MediaRecorder video tracks:",
    stream.getVideoTracks()
      .length,
  );

  /* -----------------------------------------------------------------------
   * DRAW STATE
   * --------------------------------------------------------------------- */

  const runKey =
    Math.random();

  const drawAt = (
    timelineTime: number,
  ) => {
    const safeTime =
      Math.max(
        0,
        Math.min(
          timelineTime,
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
   * HOLD A VISUAL BEAT
   *
   * Keeps rendering the current beat while time passes.
   * --------------------------------------------------------------------- */

  const holdBeat = async (
    beat: Beat,
  ): Promise<void> => {
    const start =
      performance.now();

    while (true) {
      if (
        opts.signal?.cancelled
      ) {
        return;
      }

      const elapsed =
        (performance.now() -
          start) /
        1000;

      /*
       * Never move into the next timeline beat
       * just because the real-time speech is slow.
       *
       * This keeps the current scene visible.
       */
      const localTime =
        Math.min(
          elapsed,
          Math.max(
            0,
            beat.dur -
              0.001,
          ),
        );

      drawAt(
        beat.start +
          localTime,
      );

      if (
        elapsed >=
        beat.dur
      ) {
        break;
      }

      await nextFrame();
    }
  };

  /* -----------------------------------------------------------------------
   * PROCESS SPEECH BEAT
   *
   * IMPORTANT:
   *
   * We start the voice and the visual animation together.
   *
   * We then WAIT for BOTH:
   *
   *   1. minimum visual duration
   *   2. actual TTS completion
   *
   * Therefore a long voice cannot push us into the next scene prematurely.
   * --------------------------------------------------------------------- */

  const processSpeechBeat =
    async (
      beat: Beat,
    ): Promise<void> => {
      if (!beat.say) {
        await holdBeat(
          beat,
        );
        return;
      }

      onProgress({
        stage: "Adding voice...",
        percent: 30,
      });

      console.log(
        "[export] Speech START:",
        beat.kind,
        beat.say,
      );

      /*
       * Start speech immediately.
       *
       * AudioEngine.speak() MUST resolve on
       * SpeechSynthesis.onend.
       */
      const speechPromise =
        audio.speak(
          beat.say,
          quiz.language,
          audioSettings,
        );

      /*
       * Keep drawing the same beat while speech
       * is running.
       */
      const visualPromise =
        holdBeat(
          beat,
        );

      await Promise.all([
        speechPromise,
        visualPromise,
      ]);

      /*
       * Extra safety check.
       */
      await audio.waitForSpeechEnd(
        1500,
      );

      console.log(
        "[export] Speech END:",
        beat.kind,
        beat.say,
      );
    };

  /* -----------------------------------------------------------------------
   * PROCESS NON-SPEECH BEAT
   * --------------------------------------------------------------------- */

  const processBeat =
    async (
      beat: Beat,
    ): Promise<void> => {
      if (
        opts.signal?.cancelled
      ) {
        return;
      }

      console.log(
        "[export] Beat START:",
        beat.kind,
        beat.label,
      );

      /* ---------------------------------------------------------------
       * SPEECH
       * ------------------------------------------------------------- */

      if (beat.say) {
        await processSpeechBeat(
          beat,
        );

        /*
         * SFX AFTER SPEECH
         */
        if (
          beat.kind ===
          "read-question"
        ) {
          audio.sfx(
            "board",
          );

          await holdExtra(
            0.25,
          );
        }

        if (
          beat.kind ===
          "read-option"
        ) {
          audio.sfx(
            "point",
          );

          await holdExtra(
            0.15,
          );
        }

        if (
          beat.kind ===
          "reveal"
        ) {
          audio.sfx(
            "correct",
          );

          await holdExtra(
            0.2,
          );

          audio.sfx(
            "confetti",
          );
        }

        /*
         * END CARD:
         *
         * Nothing is allowed to stop the recorder
         * until this speech has completely finished.
         */
        if (
          beat.kind ===
          "endcard"
        ) {
          console.log(
            "[export] END CARD speech completed.",
          );

          /*
           * Keep the END CARD visible after
           * the voice finishes.
           */
          await holdExtra(
            0.8,
          );

          audio.sfx(
            "cheer",
          );
        }

        return;
      }

      /* ---------------------------------------------------------------
       * ENTER
       * ------------------------------------------------------------- */

      if (
        beat.kind ===
        "enter"
      ) {
        await holdBeat(
          beat,
        );

        return;
      }

      /* ---------------------------------------------------------------
       * QUESTION APPEAR
       * ------------------------------------------------------------- */

      if (
        beat.kind ===
        "question-in"
      ) {
        await holdBeat(
          beat,
        );

        /*
         * Board SFX after the question movement
         * has appeared.
         */
        audio.sfx(
          "board",
        );

        return;
      }

      /* ---------------------------------------------------------------
       * OPTIONS APPEAR
       * ------------------------------------------------------------- */

      if (
        beat.kind ===
        "options-in"
      ) {
        await holdBeat(
          beat,
        );

        /*
         * Option pop SFX after options appear.
         */
        audio.sfx(
          "pop",
        );

        return;
      }

      /* ---------------------------------------------------------------
       * COUNTDOWN
       * ------------------------------------------------------------- */

      if (
        beat.kind ===
        "countdown"
      ) {
        /*
         * Timer runs completely.
         */
        await holdBeat(
          beat,
        );

        audio.sfx(
          "final",
        );

        return;
      }

      /* ---------------------------------------------------------------
       * CELEBRATION
       * ------------------------------------------------------------- */

      if (
        beat.kind ===
        "celebrate"
      ) {
        audio.sfx(
          "cheer",
        );

        await holdBeat(
          beat,
        );

        return;
      }

      /* ---------------------------------------------------------------
       * FALLBACK
       * ------------------------------------------------------------- */

      await holdBeat(
        beat,
      );
    };

  /* -----------------------------------------------------------------------
   * EXTRA HOLD
   * --------------------------------------------------------------------- */

  async function holdExtra(
    seconds: number,
  ) {
    if (
      seconds <= 0
    ) {
      return;
    }

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

      /*
       * Always draw the LAST visible state.
       *
       * This is especially important for the
       * end card.
       */
      const finalTime =
        Math.max(
          0,
          timeline.duration -
            0.001,
        );

      drawAt(
        finalTime,
      );

      await nextFrame();
    }
  }

  /* -----------------------------------------------------------------------
   * START RECORDING
   * --------------------------------------------------------------------- */

  onProgress({
    stage:
      "Animating character...",
    percent: 6,
  });

  recorder.start(200);

  /* -----------------------------------------------------------------------
   * PROCESS ALL BEATS SEQUENTIALLY
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
   * HARD GUARANTEE:
   *
   * Find the end-card beat and explicitly render it.
   *
   * Even if something earlier consumed more/less time,
   * the final recorded frames are guaranteed to be
   * the end card.
   * --------------------------------------------------------------------- */

  const endCard =
    [...timeline.beats]
      .reverse()
      .find(
        (beat) =>
          beat.kind ===
          "endcard",
      );

  if (endCard) {
    console.log(
      "[export] FORCING FINAL END CARD:",
      endCard.label,
    );

    /*
     * Draw end card immediately.
     */
    drawAt(
      endCard.start +
        Math.max(
          0,
          endCard.dur -
            0.001,
        ),
    );

    /*
     * Keep end card visible for an additional
     * safety period.
     */
    const endCardStart =
      performance.now();

    while (
      performance.now() -
        endCardStart <
      1000
    ) {
      drawAt(
        endCard.start +
          Math.max(
            0,
            endCard.dur -
              0.001,
          ),
      );

      await nextFrame();
    }
  }

  /* -----------------------------------------------------------------------
   * FINAL SPEECH SAFETY
   * --------------------------------------------------------------------- */

  await audio.waitForSpeechEnd(
    5000,
  );

  /*
   * Make absolutely sure the final frame is
   * the end card before stopping recording.
   */
  if (endCard) {
    drawAt(
      endCard.start +
        Math.max(
          0,
          endCard.dur -
            0.001,
        ),
    );

    /*
     * Give MediaRecorder at least a few frames
     * containing the final end-card state.
     */
    for (
      let i = 0;
      i < 15;
      i++
    ) {
      drawAt(
        endCard.start +
          Math.max(
            0,
            endCard.dur -
              0.001,
          ),
      );

      await nextFrame();
    }
  }

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
        recorder.onstop = () => {
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

  /* -----------------------------------------------------------------------
   * CLEANUP
   * --------------------------------------------------------------------- */

  stream
    .getTracks()
    .forEach((track) => {
      track.stop();
    });

  console.log(
    "[export] Recorded blob size (MB):",
    (
      blob.size / 1e6
    ).toFixed(2),
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