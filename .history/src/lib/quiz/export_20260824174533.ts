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
  | "Rendering video..."
  | "Finalizing MP4..."
  | "Done";

export interface RenderProgress {
  stage: RenderStage;
  percent: number;
}

/* =========================================================
 * MIME
 * ======================================================= */

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

/* =========================================================
 * NEXT FRAME
 * ======================================================= */

function nextFrame() {
  return new Promise<void>(
    (resolve) => {
      requestAnimationFrame(
        () => resolve(),
      );
    },
  );
}

/* =========================================================
 * RENDER VIDEO
 * ======================================================= */

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

  /* =======================================================
   * PREPARE
   * ===================================================== */

  onProgress({
    stage:
      "Preparing animation...",
    percent: 2,
  });

  const canvas =
    document.createElement(
      "canvas",
    );

  canvas.width =
    width;

  canvas.height =
    height;

  const ctx =
    canvas.getContext(
      "2d",
    );

  if (!ctx) {
    throw new Error(
      "Canvas is not available in this browser.",
    );
  }

  /* =======================================================
   * CAPTURE NARRATION
   * ===================================================== */

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

  /* =======================================================
   * AUDIO
   * ===================================================== */

  audio.ensure();

  audio.apply(
    audioSettings,
  );

  /* =======================================================
   * MEDIA STREAM
   * ===================================================== */

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
      stream.addTrack(
        track,
      );
    },
  );

  /* =======================================================
   * MEDIA RECORDER
   * ===================================================== */

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
        event.data.size >
        0
      ) {
        chunks.push(
          event.data,
        );
      }
    };

  /* =======================================================
   * DRAWING
   * ===================================================== */

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

  /* =======================================================
   * RENDER ONE BEAT
   *
   * Countdown SFX are handled INSIDE this function.
   * ===================================================== */

  const renderBeat =
    async (
      beat: Timeline["beats"][number],
    ) => {
      const start =
        performance.now();

      /*
       * Prevent duplicate countdown sounds.
       */
      let lastCountdownSecond =
        -1;

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

        const localTime =
          Math.min(
            elapsed,
            Math.max(
              0,
              beat.dur -
                0.001,
            ),
          );

        /* -------------------------------------------------
         * DRAW CURRENT BEAT
         * ----------------------------------------------- */

        drawAt(
          beat.start +
            localTime,
        );

        /* -------------------------------------------------
         * COUNTDOWN SFX
         *
         * Example:
         *
         * 5 -> tick
         * 4 -> tick
         * 3 -> tick
         * 2 -> tick
         * 1 -> tick
         * 0 -> final
         * ----------------------------------------------- */

        if (
          beat.kind ===
          "countdown"
        ) {
          const remaining =
            Math.ceil(
              beat.dur -
                elapsed,
            );

          if (
            remaining > 0 &&
            remaining !==
              lastCountdownSecond
          ) {
            lastCountdownSecond =
              remaining;

            console.log(
              "[export] Countdown:",
              remaining,
              "tick",
            );

            audio.sfx(
              "tick",
            );
          }
        }

        /* -------------------------------------------------
         * END OF BEAT
         * ----------------------------------------------- */

        if (
          elapsed >=
          beat.dur
        ) {
          break;
        }

        await nextFrame();
      }

      /* ---------------------------------------------------
       * COUNTDOWN FINISHED
       * ------------------------------------------------- */

      if (
        beat.kind ===
        "countdown"
      ) {
        console.log(
          "[export] Countdown finished - final SFX",
        );

        audio.sfx(
          "final",
        );
      }
    };

  /* =======================================================
   * START RECORDING
   * ===================================================== */

  onProgress({
    stage:
      "Animating character...",
    percent: 6,
  });

  recorder.start(200);

  /* =======================================================
   * PROCESS TIMELINE
   *
   * Every beat is processed exactly once.
   *
   * There is exactly one endcard beat and it is the
   * final beat in timeline.ts.
   * ===================================================== */

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
        (index /
          total) *
          88,
      );

    console.log(
      "[export] Processing beat:",
      index + 1,
      "/",
      total,
      beat.kind,
      beat.label,
    );

    /* =====================================================
     * SPEECH BEAT
     * =================================================== */

    if (beat.say) {
      onProgress({
        stage:
          beat.kind ===
          "endcard"
            ? "Rendering video..."
            : "Adding voice...",
        percent,
      });

      /*
       * Visual animation and speech start together.
       *
       * audio.speak() resolves ONLY after onend.
       */
      await Promise.all([
        renderBeat(
          beat,
        ),

        audio.speak(
          beat.say,
          quiz.language,
          audioSettings,
        ),
      ]);

      /*
       * Extra safety.
       */
      await audio.waitForSpeechEnd(
        2000,
      );

      /* ---------------------------------------------------
       * SFX AFTER SPEECH
       * ------------------------------------------------- */

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

      /*
       * End card is simply the last normal beat.
       *
       * DO NOT render another end card here.
       */
      if (
        beat.kind ===
        "endcard"
      ) {
        console.log(
          "[export] End card completed.",
        );
      }

      continue;
    }

    /* =====================================================
     * NON-SPEECH BEAT
     * =================================================== */

    onProgress({
      stage:
        "Animating character...",
      percent,
    });

    await renderBeat(
      beat,
    );

    /* -----------------------------------------------------
     * SFX AFTER MOVEMENT
     * --------------------------------------------------- */

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
      "celebrate"
    ) {
      audio.sfx(
        "cheer",
      );
    }
  }

  /* =======================================================
   * FINAL SPEECH SAFETY
   *
   * Does NOT create another end card.
   * ===================================================== */

  await audio.waitForSpeechEnd(
    5000,
  );

  /* =======================================================
   * FINALIZE
   * ===================================================== */

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

  /* =======================================================
   * CLEANUP
   * ===================================================== */

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

/* =========================================================
 * DOWNLOAD
 * ======================================================= */

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
  a.download =
    filename;

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