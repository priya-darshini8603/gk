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

/* ---------------------------------------------------------------------------
 * CONSTANTS
 * ------------------------------------------------------------------------- */

const FPS = 30;

const FRAME_MS =
  1000 / FPS;

/*
 * Minimum useful frame duration.
 */
const MIN_BEAT_DURATION = 0.25;

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
      MediaRecorder.isTypeSupported(
        candidate,
      ),
    ) ?? "video/webm"
  );
}

/* ---------------------------------------------------------------------------
 * SLEEP
 * ------------------------------------------------------------------------- */

function sleep(ms: number) {
  return new Promise<void>(
    (resolve) => {
      window.setTimeout(
        resolve,
        ms,
      );
    },
  );
}

/* ---------------------------------------------------------------------------
 * CANVAS CAPTURE TRACK
 * ------------------------------------------------------------------------- */

function getCanvasCaptureTrack(
  stream: MediaStream,
): CanvasCaptureMediaStreamTrack | null {
  const track =
    stream.getVideoTracks()[0];

  if (!track) {
    return null;
  }

  /*
   * CanvasCaptureMediaStreamTrack has
   * requestFrame() in browsers that support
   * manual canvas frame capture.
   */
  const canvasTrack =
    track as CanvasCaptureMediaStreamTrack;

  if (
    typeof canvasTrack.requestFrame !==
    "function"
  ) {
    return null;
  }

  return canvasTrack;
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
  } = opts;

  /* -------------------------------------------------------------------------
   * PREPARE
   * ----------------------------------------------------------------------- */

  onProgress({
    stage: "Preparing animation...",
    percent: 2,
  });

  const canvas =
    document.createElement(
      "canvas",
    );

  canvas.width = width;
  canvas.height = height;

  const ctx =
    canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });

  if (!ctx) {
    throw new Error(
      "Canvas is not available in this browser.",
    );
  }

  /*
   * Disable image smoothing if your renderer
   * does not need it. It reduces some canvas
   * overhead.
   *
   * If your owl/background images look worse,
   * remove this line.
   */
  ctx.imageSmoothingEnabled = true;

  /* -------------------------------------------------------------------------
   * NARRATION CAPTURE
   * ----------------------------------------------------------------------- */

  onProgress({
    stage: "Adding voice...",
    percent: 3,
  });

  const narrationOk =
    await audio.captureNarration();

  console.log(
    "[export] Narration capture:",
    narrationOk,
  );

  /* -------------------------------------------------------------------------
   * AUDIO
   * ----------------------------------------------------------------------- */

  audio.ensure();
  audio.apply(audioSettings);

  /* -------------------------------------------------------------------------
   * RECORDING STREAM
   * ----------------------------------------------------------------------- */

  /*
   * IMPORTANT:
   *
   * 0 means:
   * "Do not automatically capture canvas frames."
   *
   * We will explicitly call requestFrame()
   * after every draw.
   */
  const stream =
    canvas.captureStream(0);

  const canvasTrack =
    getCanvasCaptureTrack(stream);

  /*
   * Some browsers do not implement manual
   * requestFrame().
   *
   * We can still fall back to normal
   * captureStream(FPS), but manual capture
   * is strongly preferred.
   */
  if (!canvasTrack) {
    console.warn(
      "[export] Manual canvas requestFrame() is unavailable. Falling back to automatic capture.",
    );

    stream
      .getTracks()
      .forEach((track) =>
        track.stop(),
      );

    /*
     * Re-create automatic capture stream.
     */
    const fallbackStream =
      canvas.captureStream(FPS);

    const fallbackAudioTracks =
      audio.dest
        ? audio.dest.stream
            .getAudioTracks()
        : [];

    fallbackAudioTracks.forEach(
      (track) => {
        fallbackStream.addTrack(
          track,
        );
      },
    );

    return renderVideoFallbackRecorder(
      opts,
      canvas,
      ctx,
      fallbackStream,
    );
  }

  /*
   * Add audio to the same recording stream.
   */
  const audioTracks =
    audio.dest
      ? audio.dest.stream
          .getAudioTracks()
      : [];

  audioTracks.forEach(
    (track) => {
      stream.addTrack(track);
    },
  );

  /* -------------------------------------------------------------------------
   * MEDIA RECORDER
   * ----------------------------------------------------------------------- */

  const mimeType =
    pickMime();

  console.log(
    "[export] MIME:",
    mimeType,
  );

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
    if (
      event.data.size > 0
    ) {
      chunks.push(event.data);
    }
  };

  /* -------------------------------------------------------------------------
   * RUNTIME TIMELINE
   * ----------------------------------------------------------------------- */

  const runtimeBeats: Beat[] =
    timeline.beats.map(
      (beat) => ({
        ...beat,
      }),
    );

  const runtimeTimeline:
    Timeline = {
      beats: runtimeBeats,
      duration: 0,
      seed: timeline.seed,
    };

  const runKey =
    Math.random();

  /*
   * Draw a frame at timeline time.
   */
  const drawAt = (
    time: number,
  ) => {
    const safeTime =
      Math.max(
        0,
        time,
      );

    drawFrame(
      ctx,
      quiz,
      getState(
        runtimeTimeline,
        quiz,
        safeTime,
      ),
      width,
      height,
      runKey,
    );
  };

  /*
   * Draw and explicitly push the canvas
   * frame into the MediaStream.
   */
  const captureFrame = (
    time: number,
  ) => {
    drawAt(time);

    /*
     * Explicitly request this exact
     * canvas frame.
     */
    canvasTrack.requestFrame();
  };

  /* -------------------------------------------------------------------------
   * FIXED BEAT
   * ----------------------------------------------------------------------- */

  const renderBeatFixed =
    async (
      beat: Beat,
    ): Promise<boolean> => {
      const duration =
        Math.max(
          0,
          beat.dur,
        );

      const frameCount =
        Math.max(
          1,
          Math.ceil(
            duration * FPS,
          ),
        );

      let lastCountdownSecond =
        -1;

      for (
        let frame = 0;
        frame < frameCount;
        frame++
      ) {
        if (
          opts.signal
            ?.cancelled
        ) {
          return false;
        }

        /*
         * Exact logical frame time.
         */
        const localTime =
          Math.min(
            duration -
              0.0001,
            frame / FPS,
          );

        captureFrame(
          beat.start +
            Math.max(
              0,
              localTime,
            ),
        );

        /*
         * Countdown SFX.
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
            remaining > 0 &&
            remaining !==
              lastCountdownSecond
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

        /*
         * Give MediaRecorder enough real time
         * to timestamp/capture this frame.
         */
        await sleep(
          FRAME_MS,
        );
      }

      /*
       * Final frame at the end of the beat.
       */
      captureFrame(
        beat.start +
          Math.max(
            0,
            duration -
              0.0001,
          ),
      );

      if (
        beat.kind ===
        "countdown"
      ) {
        audio.sfx("final");

        console.log(
          "[export] Countdown finished",
        );
      }

      return true;
    };

  /* -------------------------------------------------------------------------
   * SPEECH BEAT
   * ----------------------------------------------------------------------- */

  const renderBeatSpeech =
    async (
      beat: Beat,
      estimatedFallbackDur: number,
    ): Promise<
      number | null
    > => {
      /*
       * Start narration immediately.
       */
      const speechPromise =
        audio.speak(
          beat.say!,
          quiz.language,
          audioSettings,
        );

      /*
       * Render frames while speech is
       * actually running.
       *
       * We use a separate frame clock.
       */
      const start =
        performance.now();

      let speechFinished =
        false;

      let spokenSeconds = 0;

      /*
       * Await speech in parallel.
       */
      const speechResult =
        speechPromise.then(
          (seconds) => {
            spokenSeconds =
              seconds;

            speechFinished = true;

            return seconds;
          },
        );

      /*
       * Render at 30 FPS until TTS ends.
       */
      let frame = 0;

      while (
        !speechFinished
      ) {
        if (
          opts.signal
            ?.cancelled
        ) {
          return null;
        }

        const elapsed =
          (performance.now() -
            start) /
          1000;

        captureFrame(
          beat.start +
            elapsed,
        );

        frame++;

        /*
         * Keep the exporter around
         * 30 FPS.
         */
        await sleep(
          FRAME_MS,
        );
      }

      /*
       * Wait for the actual promise.
       */
      await speechResult;

      const actualDur =
        Math.max(
          MIN_BEAT_DURATION,
          spokenSeconds >
            0
            ? spokenSeconds
            : estimatedFallbackDur,
        );

      /*
       * Final frame exactly at the
       * calculated speech duration.
       */
      captureFrame(
        beat.start +
          Math.max(
            0,
            actualDur -
              0.0001,
          ),
      );

      console.log(
        "[export] Speech beat:",
        beat.kind,
        actualDur.toFixed(2),
        spokenSeconds > 0
          ? "(measured)"
          : "(fallback)",
      );

      return actualDur;
    };

  /* -------------------------------------------------------------------------
   * RECORD START
   * ----------------------------------------------------------------------- */

  onProgress({
    stage: "Animating character...",
    percent: 6,
  });

  recorder.start(250);

  /*
   * Give MediaRecorder a moment to start.
   */
  await sleep(50);

  /* -------------------------------------------------------------------------
   * PROCESS BEATS
   * ----------------------------------------------------------------------- */

  const total =
    runtimeBeats.length;

  let cursor = 0;

  for (
    let index = 0;
    index < total;
    index++
  ) {
    const plannedBeat =
      timeline.beats[index];

    const beat =
      runtimeBeats[index];

    if (
      !plannedBeat ||
      !beat
    ) {
      continue;
    }

    if (
      opts.signal
        ?.cancelled
    ) {
      break;
    }

    /*
     * IMPORTANT:
     *
     * Runtime start times are rebuilt
     * sequentially, not copied from the
     * original estimated timeline.
     */
    beat.start = cursor;

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
      "start:",
      beat.start.toFixed(2),
    );

    /* -----------------------------------------------------------------------
     * SPEECH BEAT
     * --------------------------------------------------------------------- */

    if (beat.say) {
      onProgress({
        stage: "Adding voice...",
        percent,
      });

      const fallbackDuration =
        Math.max(
          MIN_BEAT_DURATION,
          beat.dur,
        );

      /*
       * Make current beat very long temporarily
       * so getState() always resolves to this
       * beat while it is rendering.
       */
      beat.dur = 999999;

      const actualDur =
        await renderBeatSpeech(
          beat,
          fallbackDuration,
        );

      if (
        actualDur === null
      ) {
        break;
      }

      beat.dur =
        actualDur;

      cursor +=
        actualDur;

      /*
       * SFX after narration.
       */
      if (
        beat.kind ===
        "read-question"
      ) {
        audio.sfx("board");
      }

      if (
        beat.kind ===
        "read-option"
      ) {
        audio.sfx("point");
      }

      if (
        beat.kind ===
        "reveal"
      ) {
        audio.sfx("correct");

        await sleep(150);

        audio.sfx("confetti");
      }

      continue;
    }

    /* -----------------------------------------------------------------------
     * FIXED BEAT
     * --------------------------------------------------------------------- */

    onProgress({
      stage:
        "Animating character...",
      percent,
    });

    const ok =
      await renderBeatFixed(
        beat,
      );

    if (!ok) {
      break;
    }

    cursor +=
      beat.dur;

    /*
     * SFX after fixed animation.
     */
    if (
      beat.kind ===
      "question-in"
    ) {
      /*
       * Already played by timeline
       * only if needed.
       */
    }

    if (
      beat.kind ===
      "options-in"
    ) {
      /*
       * Pop sound is handled here once.
       */
      audio.sfx("pop");
    }

    if (
      beat.kind ===
      "celebrate"
    ) {
      audio.sfx("cheer");
    }
  }

  /* -------------------------------------------------------------------------
   * FINAL TIMELINE
   * ----------------------------------------------------------------------- */

  runtimeTimeline.duration =
    cursor;

  console.log(
    "[export] Final duration:",
    cursor.toFixed(2),
    "seconds",
  );

  /* -------------------------------------------------------------------------
   * FINAL FRAME
   * ----------------------------------------------------------------------- */

  if (
    cursor > 0
  ) {
    captureFrame(
      Math.max(
        0,
        cursor -
          0.0001,
      ),
    );

    /*
     * Give MediaRecorder time to consume
     * the final frame.
     */
    await sleep(
      FRAME_MS * 2,
    );
  }

  /* -------------------------------------------------------------------------
   * STOP RECORDER
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
            try {
              resolve(
                new Blob(
                  chunks,
                  {
                    type: mimeType,
                  },
                ),
              );
            } catch (error) {
              reject(error);
            }
          };

        recorder.onerror =
          (event) => {
            reject(
              new Error(
                `MediaRecorder error: ${String(
                  event,
                )}`,
              ),
            );
          };

        try {
          recorder.stop();
        } catch (error) {
          reject(error);
        }
      },
    );

  /* -------------------------------------------------------------------------
   * CLEANUP
   * ----------------------------------------------------------------------- */

  stream
    .getTracks()
    .forEach((track) =>
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

/* ===========================================================================
 * FALLBACK EXPORTER
 *
 * Used only when CanvasCaptureMediaStreamTrack.requestFrame()
 * is unavailable.
 * ========================================================================== */

async function renderVideoFallbackRecorder(
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
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  stream: MediaStream,
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
    if (
      event.data.size > 0
    ) {
      chunks.push(
        event.data,
      );
    }
  };

  const runtimeBeats =
    timeline.beats.map(
      (beat) => ({
        ...beat,
      }),
    );

  const runtimeTimeline:
    Timeline = {
      beats: runtimeBeats,
      duration: 0,
      seed: timeline.seed,
    };

  const runKey =
    Math.random();

  const drawAt = (
    time: number,
  ) => {
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

  onProgress({
    stage:
      "Animating character...",
    percent: 6,
  });

  recorder.start(250);

  await sleep(50);

  let cursor = 0;

  for (
    let index = 0;
    index <
    runtimeBeats.length;
    index++
  ) {
    if (
      signal?.cancelled
    ) {
      break;
    }

    const beat =
      runtimeBeats[index];

    if (!beat) {
      continue;
    }

    beat.start =
      cursor;

    const percent =
      6 +
      Math.round(
        (index /
          runtimeBeats.length) *
          88,
      );

    onProgress({
      stage: beat.say
        ? "Adding voice..."
        : "Animating character...",
      percent,
    });

    if (beat.say) {
      const fallback =
        beat.dur;

      beat.dur = 999999;

      const start =
        performance.now();

      const speechPromise =
        audio.speak(
          beat.say,
          quiz.language,
          audioSettings,
        );

      let speechDone =
        false;

      let spokenSeconds = 0;

      void speechPromise.then(
        (seconds) => {
          spokenSeconds =
            seconds;
          speechDone = true;
        },
      );

      while (
        !speechDone
      ) {
        if (
          signal?.cancelled
        ) {
          break;
        }

        const elapsed =
          (performance.now() -
            start) /
          1000;

        drawAt(
          beat.start +
            elapsed,
        );

        await sleep(
          FRAME_MS,
        );
      }

      const actualDur =
        Math.max(
          MIN_BEAT_DURATION,
          spokenSeconds >
            0
            ? spokenSeconds
            : fallback,
        );

      beat.dur =
        actualDur;

      drawAt(
        beat.start +
          actualDur -
          0.0001,
      );

      cursor +=
        actualDur;
    } else {
      const duration =
        Math.max(
          0,
          beat.dur,
        );

      const frames =
        Math.max(
          1,
          Math.ceil(
            duration *
              FPS,
          ),
        );

      for (
        let frame = 0;
        frame < frames;
        frame++
      ) {
        if (
          signal?.cancelled
        ) {
          break;
        }

        drawAt(
          beat.start +
            Math.min(
              duration -
                0.0001,
              frame /
                FPS,
            ),
        );

        await sleep(
          FRAME_MS,
        );
      }

      cursor +=
        duration;
    }
  }

  runtimeTimeline.duration =
    cursor;

  drawAt(
    Math.max(
      0,
      cursor -
        0.0001,
    ),
  );

  await sleep(
    FRAME_MS * 2,
  );

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
    .forEach((track) =>
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

  a.href = url;
  a.download =
    filename;

  document.body.appendChild(
    a,
  );

  a.click();

  a.remove();

  window.setTimeout(
    () => {
      URL.revokeObjectURL(
        url,
      );
    },
    4000,
  );
}