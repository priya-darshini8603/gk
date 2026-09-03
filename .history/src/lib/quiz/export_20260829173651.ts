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
  | "Finalizing MP4..."
  | "Done";

export interface RenderProgress {
  stage: RenderStage;
  percent: number;
}

const FPS = 30;

const FRAME_TIME =
  1 / FPS;

const MIN_DURATION =
  0.25;

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
 * SLEEP
 * ------------------------------------------------------------------------- */

function sleep(
  ms: number,
) {
  return new Promise<void>(
    (resolve) =>
      setTimeout(
        resolve,
        ms,
      ),
  );
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
    signal,
  } = opts;

  /* -------------------------------------------------------------------------
   * CANVAS
   * ----------------------------------------------------------------------- */

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
      {
        alpha: false,
      },
    );

  if (!ctx) {
    throw new Error(
      "Canvas is not available.",
    );
  }

  /* -------------------------------------------------------------------------
   * AUDIO
   * ----------------------------------------------------------------------- */

  onProgress({
    stage:
      "Adding voice...",
    percent: 3,
  });

  await audio.captureNarration();

  audio.ensure();

  audio.apply(
    audioSettings,
  );

  /* -------------------------------------------------------------------------
   * CAPTURE
   * ----------------------------------------------------------------------- */

  /*
   * Automatic capture is used here because MediaRecorder
   * is a real-time API.
   *
   * We NEVER use its timing to decide which animation
   * state should exist.
   *
   * Our animation state is always:
   *
   *     frame / FPS
   */
  const stream =
    canvas.captureStream(
      FPS,
    );

  const audioTracks =
    audio.dest
      ? audio.dest.stream
          .getAudioTracks()
      : [];

  for (
    const track of audioTracks
  ) {
    stream.addTrack(
      track,
    );
  }

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

  /* -------------------------------------------------------------------------
   * RUNTIME TIMELINE
   * ----------------------------------------------------------------------- */

  const runtimeBeats:
    Beat[] =
    timeline.beats.map(
      (beat) => ({
        ...beat,
      }),
    );

  const runtimeTimeline:
    Timeline = {
    beats:
      runtimeBeats,
    duration: 0,
    seed:
      timeline.seed,
  };

  const runKey =
    Math.random();

  /* -------------------------------------------------------------------------
   * DRAW
   * ----------------------------------------------------------------------- */

  const drawAt =
    (time: number) => {
      drawFrame(
        ctx,
        quiz,
        getState(
          runtimeTimeline,
          quiz,
          Math.max(
            0,
            time,
          ),
        ),
        width,
        height,
        runKey,
      );
    };

  /* -------------------------------------------------------------------------
   * FIXED BEAT
   *
   * IMPORTANT:
   *
   * Every logical frame is generated.
   * No elapsed-time based skipping.
   * ----------------------------------------------------------------------- */

  const renderFixedBeat =
    async (
      beat: Beat,
    ) => {
      const duration =
        Math.max(
          0,
          beat.dur,
        );

      const frameCount =
        Math.max(
          1,
          Math.ceil(
            duration *
              FPS,
          ),
        );

      let lastSecond =
        -1;

      for (
        let frame = 0;
        frame < frameCount;
        frame++
      ) {
        if (
          signal?.cancelled
        ) {
          return false;
        }

        /*
         * LOGICAL VIDEO TIME.
         *
         * This is the critical part.
         *
         * Laptop speed does not change this.
         */
        const localTime =
          Math.min(
            duration -
              0.00001,
            frame *
              FRAME_TIME,
          );

        drawAt(
          beat.start +
            localTime,
        );

        /*
         * Countdown.
         */
        if (
          beat.kind ===
          "countdown"
        ) {
          const remaining =
            Math.ceil(
              duration -
                localTime,
            );

          if (
            remaining !==
              lastSecond &&
            remaining > 0
          ) {
            lastSecond =
              remaining;

            audio.sfx(
              "tick",
            );
          }
        }

        /*
         * Give browser/MediaRecorder time
         * to consume the canvas.
         *
         * If laptop slows down, this may
         * take longer, but frame number
         * NEVER jumps.
         */
        await sleep(
          1000 / FPS,
        );
      }

      /*
       * Final frame.
       */
      drawAt(
        beat.start +
          Math.max(
            0,
            duration -
              0.00001,
          ),
      );

      if (
        beat.kind ===
        "countdown"
      ) {
        audio.sfx(
          "final",
        );
      }

      return true;
    };

  /* -------------------------------------------------------------------------
   * SPEECH BEAT
   * ----------------------------------------------------------------------- */

  const renderSpeechBeat =
    async (
      beat: Beat,
      fallbackDuration: number,
    ): Promise<
      number | null
    > => {
      /*
       * Start speech.
       */
      const speechPromise =
        audio.speak(
          beat.say!,
          quiz.language,
          audioSettings,
        );

      /*
       * We don't use performance.now()
       * to choose logical frame positions.
       *
       * Instead we generate:
       *
       * frame 0
       * frame 1
       * frame 2
       * ...
       */
      let spokenSeconds =
        0;

      const speechResult =
        await speechPromise;

      spokenSeconds =
        speechResult;

      const duration =
        Math.max(
          MIN_DURATION,
          spokenSeconds >
            0
            ? spokenSeconds
            : fallbackDuration,
        );

      const frameCount =
        Math.max(
          1,
          Math.ceil(
            duration *
              FPS,
          ),
        );

      /*
       * Now generate the complete
       * visual beat deterministically.
       */
      for (
        let frame = 0;
        frame < frameCount;
        frame++
      ) {
        if (
          signal?.cancelled
        ) {
          return null;
        }

        const localTime =
          Math.min(
            duration -
              0.00001,
            frame *
              FRAME_TIME,
          );

        drawAt(
          beat.start +
            localTime,
        );

        await sleep(
          1000 / FPS,
        );
      }

      /*
       * Final frame.
       */
      drawAt(
        beat.start +
          duration -
          0.00001,
      );

      return duration;
    };

  /* -------------------------------------------------------------------------
   * START RECORDER
   * ----------------------------------------------------------------------- */

  recorder.start(
    250,
  );

  /*
   * Make sure recorder has entered recording
   * state before drawing.
   */
  await sleep(100);

  /* -------------------------------------------------------------------------
   * PROCESS BEATS
   * ----------------------------------------------------------------------- */

  let cursor = 0;

  const total =
    runtimeBeats.length;

  for (
    let index = 0;
    index < total;
    index++
  ) {
    const beat =
      runtimeBeats[index];

    if (!beat) {
      continue;
    }

    if (
      signal?.cancelled
    ) {
      break;
    }

    /*
     * Rebuild runtime timing.
     */
    beat.start =
      cursor;

    const percent =
      6 +
      Math.round(
        (index /
          total) *
          88,
      );

    onProgress({
      stage:
        beat.say
          ? "Adding voice..."
          : "Animating character...",
      percent,
    });

    /* -----------------------------------------------------------------------
     * SPEECH
     * --------------------------------------------------------------------- */

    if (beat.say) {
      const fallback =
        Math.max(
          MIN_DURATION,
          beat.dur,
        );

      /*
       * Make this beat temporarily huge
       * so getState() continues resolving
       * this beat while speech is running.
       */
      beat.dur =
        999999;

      const actualDuration =
        await renderSpeechBeat(
          beat,
          fallback,
        );

      if (
        actualDuration ===
        null
      ) {
        break;
      }

      beat.dur =
        actualDuration;

      cursor +=
        actualDuration;

      /*
       * SFX.
       */
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

        await sleep(
          150,
        );

        audio.sfx(
          "confetti",
        );
      }

      continue;
    }

    /* -----------------------------------------------------------------------
     * FIXED
     * --------------------------------------------------------------------- */

    const success =
      await renderFixedBeat(
        beat,
      );

    if (!success) {
      break;
    }

    cursor +=
      beat.dur;

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

  /* -------------------------------------------------------------------------
   * FINAL DURATION
   * ----------------------------------------------------------------------- */

  runtimeTimeline.duration =
    cursor;

  /*
   * Final frame.
   */
  drawAt(
    Math.max(
      0,
      cursor -
        0.00001,
    ),
  );

  /*
   * Give recorder time to consume it.
   */
  await sleep(
    100,
  );

  /* -------------------------------------------------------------------------
   * STOP
   * ----------------------------------------------------------------------- */

  onProgress({
    stage:
      "Finalizing MP4...",
    percent: 96,
  });

  const blob =
    await new Promise<Blob>(
      (
        resolve,
        reject,
      ) => {
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

        recorder.onerror =
          () => {
            reject(
              new Error(
                "MediaRecorder failed.",
              ),
            );
          };

        recorder.stop();
      },
    );

  /* -------------------------------------------------------------------------
   * CLEANUP
   * ----------------------------------------------------------------------- */

  stream
    .getTracks()
    .forEach(
      (track) =>
        track.stop(),
    );

  audio.stopMusic();
  audio.stopSpeech();

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

  a.href =
    url;

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