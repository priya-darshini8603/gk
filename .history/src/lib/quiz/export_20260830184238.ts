import { drawFrame } from "./renderer";
import { getState, type Beat, type Timeline } from "./timeline";
import type { AudioSettings, Quiz } from "./types";
import type { AudioEngine } from "./audio";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";

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

/*
 * Export quality/performance settings.
 *
 * 30 FPS is retained because this is intended for YouTube/kids content.
 *
 * Increasing encoder queue capacity reduces the amount of time the JS thread
 * spends waiting for WebCodecs.
 */
const FPS = 30;
const FRAME_DURATION_US = Math.round(1_000_000 / FPS);

const VIDEO_BITRATE = 7_000_000;
const VIDEO_QUEUE_HIGH = 60;
const VIDEO_QUEUE_LOW = 30;

const AUDIO_BITRATE = 128_000;
const AUDIO_CHUNK_FRAMES = 8192;
const AUDIO_QUEUE_HIGH = 64;
const AUDIO_QUEUE_LOW = 32;

const KEYFRAME_INTERVAL_FRAMES = FPS * 3;

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wait only when the encoder is genuinely backed up.
 *
 * The old implementation waited at a much smaller queue size, which causes
 * frequent main-thread stalls during long videos.
 */
async function waitForEncoderRoom(
  encoder: { encodeQueueSize: number },
  high: number,
  low: number,
) {
  if (encoder.encodeQueueSize <= high) {
    return;
  }

  while (encoder.encodeQueueSize > low) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 4);
    });
  }
}

async function resolveVideoConfig(
  width: number,
  height: number,
): Promise<VideoEncoderConfig> {
  const candidates: VideoEncoderConfig[] = [
    {
      codec: "avc1.640034",
      width,
      height,
      bitrate: VIDEO_BITRATE,
      framerate: FPS,
      hardwareAcceleration: "prefer-hardware",
      latencyMode: "realtime",
    },
    {
      codec: "avc1.640028",
      width,
      height,
      bitrate: VIDEO_BITRATE,
      framerate: FPS,
      hardwareAcceleration: "prefer-hardware",
      latencyMode: "realtime",
    },
    {
      codec: "avc1.4d0034",
      width,
      height,
      bitrate: VIDEO_BITRATE,
      framerate: FPS,
      hardwareAcceleration: "prefer-hardware",
      latencyMode: "realtime",
    },
    {
      codec: "avc1.42001f",
      width,
      height,
      bitrate: VIDEO_BITRATE,
      framerate: FPS,
      hardwareAcceleration: "prefer-hardware",
      latencyMode: "realtime",
    },

    // Safe fallback without optional encoder hints.
    {
      codec: "avc1.42001f",
      width,
      height,
      bitrate: VIDEO_BITRATE,
      framerate: FPS,
    },
  ];

  for (const config of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported(config);

      if (support.supported) {
        return support.config ?? config;
      }
    } catch {
      // Try next configuration.
    }
  }

  throw new Error(
    "This browser cannot encode H.264 video. Please use a recent desktop Chrome or Edge.",
  );
}

async function resolveAudioConfig(
  sampleRate: number,
): Promise<AudioEncoderConfig> {
  const config: AudioEncoderConfig = {
    codec: "mp4a.40.2",
    sampleRate,
    numberOfChannels: 1,
    bitrate: AUDIO_BITRATE,
  };

  const support = await AudioEncoder.isConfigSupported(config);

  if (!support.supported) {
    throw new Error(
      "This browser cannot encode AAC audio. Please use a recent desktop Chrome or Edge.",
    );
  }

  return support.config ?? config;
}

function scheduleFixedBeatSfx(
  beat: Beat,
  audio: AudioEngine,
) {
  switch (beat.kind) {
    case "question-in":
      audio.sfx("board", 0);
      break;

    case "options-in":
      audio.sfx("pop", 0);
      audio.sfx("pop", 0.22);
      audio.sfx("pop", 0.44);
      audio.sfx("pop", 0.66);
      break;

    case "countdown": {
      const seconds = Math.max(
        1,
        Math.round(beat.dur),
      );

      for (let i = 0; i < seconds; i++) {
        audio.sfx(
          i === seconds - 1
            ? "final"
            : "tick",
          i,
        );
      }

      break;
    }

    case "celebrate":
      audio.sfx("cheer", 0);
      break;

    default:
      break;
  }
}

export async function renderVideo(opts: {
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

  if (
    typeof VideoEncoder === "undefined" ||
    typeof AudioEncoder === "undefined" ||
    typeof VideoFrame === "undefined" ||
    typeof AudioData === "undefined"
  ) {
    throw new Error(
      "WebCodecs is not supported. Please use a recent desktop Chrome or Edge.",
    );
  }

  onProgress({
    stage: "Preparing animation...",
    percent: 2,
  });

  /*
   * OffscreenCanvas avoids attaching the export renderer to the visible DOM.
   */
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : document.createElement("canvas");

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext(
    "2d",
  ) as CanvasRenderingContext2D | null;

  if (!ctx) {
    throw new Error(
      "Canvas is not available in this browser.",
    );
  }

  /*
   * ------------------------------------------------------------
   * AUDIO
   * ------------------------------------------------------------
   */

  onProgress({
    stage: "Adding voice...",
    percent: 3,
  });

  const narrationOk =
    await audio.captureNarration();

  console.log(
    "[export] narration capture:",
    narrationOk,
  );

  const audioCtx = audio.ensure();

  if (!audioCtx) {
    throw new Error(
      "This browser does not support Web Audio.",
    );
  }

  audio.apply(audioSettings);

  await audio.startPcmCapture();

  /*
   * ------------------------------------------------------------
   * ENCODERS
   * ------------------------------------------------------------
   */

  const videoConfig =
    await resolveVideoConfig(
      width,
      height,
    );

  const audioConfig =
    await resolveAudioConfig(
      audioCtx.sampleRate,
    );

  const muxerTarget =
    new ArrayBufferTarget();

  const muxer = new Muxer({
    target: muxerTarget,

    video: {
      codec: "avc",
      width,
      height,
    },

    audio: {
      codec: "aac",
      numberOfChannels:
        audioConfig.numberOfChannels,
      sampleRate:
        audioConfig.sampleRate,
    },

    fastStart: "in-memory",
  });

  let videoEncoderError:
    Error | null = null;

  const videoEncoder =
    new VideoEncoder({
      output: (chunk, meta) => {
        muxer.addVideoChunk(
          chunk,
          meta,
        );
      },

      error: (error) => {
        videoEncoderError =
          error instanceof Error
            ? error
            : new Error(
                String(error),
              );

        console.error(
          "[export] video encoder error",
          error,
        );
      },
    });

  videoEncoder.configure(
    videoConfig,
  );

  let audioEncoderError:
    Error | null = null;

  const audioEncoder =
    new AudioEncoder({
      output: (chunk, meta) => {
        muxer.addAudioChunk(
          chunk,
          meta,
        );
      },

      error: (error) => {
        audioEncoderError =
          error instanceof Error
            ? error
            : new Error(
                String(error),
              );

        console.error(
          "[export] audio encoder error",
          error,
        );
      },
    });

  audioEncoder.configure(
    audioConfig,
  );

  /*
   * ------------------------------------------------------------
   * RUNTIME TIMELINE
   * ------------------------------------------------------------
   */

  const runtimeBeats: Beat[] =
    timeline.beats.map((beat) => ({
      ...beat,
    }));

  const runtimeTimeline: Timeline = {
    beats: runtimeBeats,
    duration: 0,
    seed: timeline.seed,
  };

  const runKey = Math.random();

  /*
   * ------------------------------------------------------------
   * FRAME ENCODING
   * ------------------------------------------------------------
   */

  const encodeBeatFrames = async (
    fromSeconds: number,
    toSeconds: number,
  ) => {
    const firstFrame =
      Math.max(
        0,
        Math.round(
          fromSeconds * FPS,
        ),
      );

    const lastFrameExclusive =
      Math.max(
        firstFrame,
        Math.round(
          toSeconds * FPS,
        ),
      );

    const totalFrames =
      Math.max(
        1,
        lastFrameExclusive -
          firstFrame,
      );

    for (
      let frame = firstFrame;
      frame < lastFrameExclusive;
      frame++
    ) {
      if (
        opts.signal?.cancelled
      ) {
        return;
      }

      const t = frame / FPS;

      const state =
        getState(
          runtimeTimeline,
          quiz,
          t,
        );

      drawFrame(
        ctx,
        quiz,
        state,
        width,
        height,
        runKey,
      );

      const videoFrame =
        new VideoFrame(
          canvas as CanvasImageSource,
          {
            timestamp:
              frame *
              FRAME_DURATION_US,

            duration:
              FRAME_DURATION_US,
          },
        );

      try {
        videoEncoder.encode(
          videoFrame,
          {
            keyFrame:
              frame %
                KEYFRAME_INTERVAL_FRAMES ===
              0,
          },
        );
      } finally {
        videoFrame.close();
      }

      /*
       * Don't block every frame.
       *
       * Only pause when the encoder has genuinely accumulated a large
       * backlog.
       */
      if (
        videoEncoder.encodeQueueSize >
        VIDEO_QUEUE_HIGH
      ) {
        await waitForEncoderRoom(
          videoEncoder,
          VIDEO_QUEUE_HIGH,
          VIDEO_QUEUE_LOW,
        );
      }

      /*
       * Yield occasionally so React/UI remains responsive.
       */
      if (
        (frame - firstFrame) %
          15 ===
        0
      ) {
        const localProgress =
          (frame - firstFrame) /
          totalFrames;

        onProgress({
          stage:
            "Animating character...",
          percent: Math.min(
            92,
            6 +
              Math.round(
                localProgress *
                  84,
              ),
          ),
        });

        await Promise.resolve();
      }
    }
  };

  /*
   * ------------------------------------------------------------
   * TIMELINE + NARRATION
   * ------------------------------------------------------------
   */

  let cursor = 0;

  const totalBeats =
    runtimeBeats.length;

  for (
    let index = 0;
    index < totalBeats;
    index++
  ) {
    const plannedBeat =
      timeline.beats[index];

    const beat =
      runtimeBeats[index];

    if (!plannedBeat || !beat) {
      continue;
    }

    if (
      opts.signal?.cancelled
    ) {
      break;
    }

    beat.start = cursor;

    const progress =
      6 +
      Math.round(
        (index /
          Math.max(
            1,
            totalBeats,
          )) *
          84,
      );

    /*
     * Narration has to be measured because browser speech synthesis
     * does not provide a reliable duration before speaking.
     */
    if (beat.say) {
      onProgress({
        stage: "Adding voice...",
        percent: progress,
      });

      const fallbackDuration =
        beat.dur;

      if (
        beat.kind === "reveal"
      ) {
        audio.sfx(
          "correct",
          0.25,
        );

        audio.sfx(
          "confetti",
          0.45,
        );
      }

      const spokenSeconds =
        await audio.speak(
          beat.say,
          quiz.language,
          audioSettings,
        );

      if (
        beat.kind ===
        "read-question"
      ) {
        audio.sfx(
          "board",
          0,
        );
      }

      if (
        beat.kind ===
        "read-option"
      ) {
        audio.sfx(
          "point",
          0,
        );
      }

      let actualDuration =
        Math.max(
          0.25,
          spokenSeconds > 0
            ? spokenSeconds
            : fallbackDuration,
        );

      /*
       * Preserve the reveal SFX tail.
       */
      if (
        beat.kind === "reveal"
      ) {
        const minimum =
          0.95;

        if (
          actualDuration <
          minimum
        ) {
          await wait(
            (minimum -
              actualDuration) *
              1000,
          );

          actualDuration =
            minimum;
        }
      }

      beat.dur =
        actualDuration;
    } else {
      onProgress({
        stage:
          "Animating character...",
        percent: progress,
      });

      scheduleFixedBeatSfx(
        beat,
        audio,
      );

      /*
       * Fixed beats remain real-time because the audio capture is real-time.
       */
      await wait(
        beat.dur * 1000,
      );
    }

    /*
     * IMPORTANT:
     *
     * We encode frames after the beat duration is known.
     * The encoder itself runs asynchronously, so encoding can overlap
     * with narration for subsequent beats.
     */
    await encodeBeatFrames(
      cursor,
      cursor + beat.dur,
    );

    cursor += beat.dur;
  }

  runtimeTimeline.duration =
    cursor;

  /*
   * ------------------------------------------------------------
   * AUDIO FINALIZATION
   * ------------------------------------------------------------
   */

  onProgress({
    stage: "Finalizing MP4...",
    percent: 93,
  });

  const {
    samples,
    sampleRate,
  } =
    audio.stopPcmCapture();

  const targetSamples =
    Math.max(
      1,
      Math.round(
        cursor * sampleRate,
      ),
    );

  /*
   * Avoid allocating several temporary audio arrays.
   */
  const alignedSamples =
    new Float32Array(
      targetSamples,
    );

  alignedSamples.set(
    samples.subarray(
      0,
      Math.min(
        samples.length,
        targetSamples,
      ),
    ),
  );

  /*
   * Larger chunks dramatically reduce AudioData allocations and
   * encodeQueueSize polling.
   */
  for (
    let offset = 0;
    offset < targetSamples;
    offset += AUDIO_CHUNK_FRAMES
  ) {
    if (
      opts.signal?.cancelled
    ) {
      break;
    }

    const length =
      Math.min(
        AUDIO_CHUNK_FRAMES,
        targetSamples -
          offset,
      );

    const audioData =
      new AudioData({
        format: "f32-planar",
        sampleRate,
        numberOfFrames:
          length,
        numberOfChannels: 1,
        timestamp:
          Math.round(
            (offset /
              sampleRate) *
              1_000_000,
          ),
        data:
          alignedSamples.subarray(
            offset,
            offset + length,
          ),
      });

    try {
      audioEncoder.encode(
        audioData,
      );
    } finally {
      audioData.close();
    }

    if (
      audioEncoder.encodeQueueSize >
      AUDIO_QUEUE_HIGH
    ) {
      await waitForEncoderRoom(
        audioEncoder,
        AUDIO_QUEUE_HIGH,
        AUDIO_QUEUE_LOW,
      );
    }
  }

  /*
   * ------------------------------------------------------------
   * FLUSH
   * ------------------------------------------------------------
   */

  onProgress({
    stage: "Finalizing MP4...",
    percent: 97,
  });

  await Promise.all([
    videoEncoder.flush(),
    audioEncoder.flush(),
  ]);

  if (videoEncoderError) {
    throw videoEncoderError;
  }

  if (audioEncoderError) {
    throw audioEncoderError;
  }

  videoEncoder.close();
  audioEncoder.close();

  muxer.finalize();

  const blob =
    new Blob(
      [muxerTarget.buffer],
      {
        type: "video/mp4",
      },
    );

  onProgress({
    stage: "Done",
    percent: 100,
  });

  return {
    blob,
    extension: "mp4",
  };
}

export function downloadBlob(
  blob: Blob,
  filename: string,
) {
  const url =
    URL.createObjectURL(blob);

  const anchor =
    document.createElement(
      "a",
    );

  anchor.href = url;
  anchor.download = filename;

  document.body.appendChild(
    anchor,
  );

  anchor.click();
  anchor.remove();

  setTimeout(() => {
    URL.revokeObjectURL(
      url,
    );
  }, 4000);
}