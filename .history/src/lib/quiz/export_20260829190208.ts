import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  CanvasSource,
  AudioBufferSource,
  Quality,
} from "mediabunny";

import { drawFrame } from "./renderer";
import { getState, type Beat, type Timeline } from "./timeline";
import type { AudioSettings, Quiz } from "./types";
import type { AudioEngine } from "./audio";

export type RenderStage =
  | "Preparing animation..."
  | "Measuring narration..."
  | "Synthesizing audio..."
  | "Rendering frames..."
  | "Finalizing MP4..."
  | "Done";

export interface RenderProgress {
  stage: RenderStage;
  percent: number;
}

/* ---------------------------------------------------------------------------
 * Offline SFX synthesis helpers (unchanged from the WebCodecs version) —
 * pure oscillator/noise recipes scheduled onto an OfflineAudioContext at
 * absolute times. Fully deterministic, runs faster than real time.
 * ------------------------------------------------------------------------- */

function scheduleTone(
  ctx: OfflineAudioContext,
  dest: AudioNode,
  freq: number,
  dur: number,
  type: OscillatorType,
  gain: number,
  atTime: number,
  slideTo?: number
) {
  if (atTime < 0) atTime = 0;

  const osc = ctx.createOscillator();
  const g = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, atTime);
  if (slideTo) {
    osc.frequency.exponentialRampToValueAtTime(slideTo, atTime + dur);
  }

  g.gain.setValueAtTime(0.0001, atTime);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), atTime + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, atTime + dur);

  osc.connect(g).connect(dest);
  osc.start(atTime);
  osc.stop(atTime + dur + 0.05);
}

function scheduleNoise(
  ctx: OfflineAudioContext,
  dest: AudioNode,
  dur: number,
  gain: number,
  atTime: number
) {
  if (atTime < 0) atTime = 0;

  const buf = ctx.createBuffer(1, Math.max(1, Math.ceil(ctx.sampleRate * dur)), ctx.sampleRate);
  const d = buf.getChannelData(0);

  for (let i = 0; i < d.length; i++) {
    d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  }

  const src = ctx.createBufferSource();
  src.buffer = buf;

  const g = ctx.createGain();
  g.gain.value = gain;

  src.connect(g).connect(dest);
  src.start(atTime);
}

/** Reproduces the per-beat SFX timing exactly as before: a chime after
 * each beat completes, countdown ticks, and the reveal/celebrate stingers —
 * all as absolute offsets into the final timeline. */
function scheduleBeatSfx(
  ctx: OfflineAudioContext,
  dest: AudioNode,
  beat: Beat,
  sfxVolumeScale: number
) {
  const s = (gain: number) => gain * sfxVolumeScale;
  const endOfBeat = beat.start + beat.dur;

  switch (beat.kind) {
    case "question-in":
      scheduleTone(ctx, dest, 320, 0.25, "sine", s(0.4), endOfBeat, 780);
      break;

    case "options-in":
      scheduleTone(ctx, dest, 660, 0.12, "triangle", s(0.35), endOfBeat, 980);
      break;

    case "read-question":
      scheduleTone(ctx, dest, 320, 0.25, "sine", s(0.4), endOfBeat, 780);
      break;

    case "read-option":
      scheduleTone(ctx, dest, 880, 0.09, "sine", s(0.3), endOfBeat, 1240);
      break;

    case "countdown": {
      const ticks = Math.max(0, Math.ceil(beat.dur) - 1);
      for (let i = 0; i <= ticks; i++) {
        scheduleTone(ctx, dest, 520, 0.09, "square", s(0.18), beat.start + i);
      }
      scheduleTone(ctx, dest, 300, 0.4, "sawtooth", s(0.28), endOfBeat, 120);
      break;
    }

    case "reveal": {
      [523, 659, 784, 1046].forEach((f, i) =>
        scheduleTone(ctx, dest, f, 0.28, "triangle", s(0.36), endOfBeat + i * 0.09)
      );
      scheduleNoise(ctx, dest, 0.5, s(0.18), endOfBeat + 0.15);
      break;
    }

    case "celebrate": {
      [784, 988, 1175].forEach((f, i) =>
        scheduleTone(ctx, dest, f, 0.5, "sine", s(0.24), endOfBeat + i * 0.12)
      );
      scheduleNoise(ctx, dest, 0.7, s(0.1), endOfBeat);
      break;
    }
  }
}

/* ---------------------------------------------------------------------------
 * RENDER VIDEO — mediabunny (built on WebCodecs)
 * ------------------------------------------------------------------------- */

interface FinalBeat extends Beat {
  pcm: Float32Array | null;
  pcmSampleRate: number;
}

export async function renderVideo(opts: {
  quiz: Quiz;
  timeline: Timeline;
  width: number;
  height: number;
  audio: AudioEngine;
  audioSettings: AudioSettings;
  onProgress: (progress: RenderProgress) => void;
  signal?: { cancelled: boolean };
}): Promise<{ blob: Blob; extension: string }> {
  const { quiz, timeline, width, height, audio, audioSettings, onProgress, signal } = opts;

  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") {
    throw new Error(
      "This browser doesn't support WebCodecs, which mediabunny needs to encode video. " +
        "Please use a recent Chrome, Edge, or other Chromium-based browser to export."
    );
  }

  const fps = 30;

  onProgress({ stage: "Preparing animation...", percent: 1 });

  await audio.captureNarration();

  /* =========================================================================
   * PASS 1 — MEASURE REAL NARRATION AUDIO
   *
   * SpeechSynthesis can't be sped up — this is the only wall-clock-bound
   * step, and it does no canvas drawing, so a slow main thread here cannot
   * drop a video frame (none exist yet).
   * ========================================================================= */

  const finalBeats: FinalBeat[] = [];
  let cursor = 0;

  for (let i = 0; i < timeline.beats.length; i++) {
    if (signal?.cancelled) throw new Error("Export cancelled.");

    const planned = timeline.beats[i]!;
    let dur = planned.dur;
    let pcm: Float32Array | null = null;
    let pcmSampleRate = 48000;

    if (planned.say) {
      onProgress({
        stage: "Measuring narration...",
        percent: 2 + Math.round((i / timeline.beats.length) * 38),
      });

      const captured = await audio.speakAndCapture(planned.say, quiz.language, audioSettings);
      pcm = captured.pcm;
      pcmSampleRate = captured.sampleRate;

      dur =
        pcm && pcm.length > 0
          ? pcm.length / pcmSampleRate
          : Math.max(0.25, captured.duration > 0 ? captured.duration : planned.dur);
    }

    finalBeats.push({ ...planned, start: cursor, dur, pcm, pcmSampleRate });
    cursor += dur;
  }

  const totalDuration = cursor;
  const finalTimeline: Timeline = {
    beats: finalBeats,
    duration: totalDuration,
    seed: timeline.seed,
  };

  /* =========================================================================
   * PASS 2 — SYNTHESIZE THE FULL SOUNDTRACK OFFLINE
   *
   * All SFX are pure synthesized tones; narration PCM is already captured.
   * Both get scheduled onto one OfflineAudioContext and rendered in a
   * single non-realtime pass -> one finished AudioBuffer for the whole
   * video. This can't be affected by a slow main thread either.
   * ========================================================================= */

  onProgress({ stage: "Synthesizing audio...", percent: 42 });

  const audioSampleRate = 48000;
  const audioChannels = 2;

  const offlineCtx = new OfflineAudioContext(
    audioChannels,
    Math.max(1, Math.ceil(totalDuration * audioSampleRate)),
    audioSampleRate
  );

  const masterGain = offlineCtx.createGain();
  masterGain.gain.value = audioSettings.muted ? 0 : 1;
  masterGain.connect(offlineCtx.destination);

  for (const beat of finalBeats) {
    if (beat.pcm && beat.pcm.length > 0) {
      const buffer = offlineCtx.createBuffer(1, beat.pcm.length, beat.pcmSampleRate);
      buffer.copyToChannel(beat.pcm, 0);

      const src = offlineCtx.createBufferSource();
      src.buffer = buffer;

      const voiceGain = offlineCtx.createGain();
      voiceGain.gain.value = audioSettings.voiceVolume;

      src.connect(voiceGain).connect(masterGain);
      src.start(beat.start);
    }

    scheduleBeatSfx(offlineCtx, masterGain, beat, audioSettings.sfxVolume);
  }

  const renderedAudio = await offlineCtx.startRendering(); // a plain AudioBuffer

  /* =========================================================================
   * PASS 3 — SET UP THE MEDIABUNNY OUTPUT
   * ========================================================================= */

  onProgress({ stage: "Rendering frames...", percent: 46 });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    throw new Error("Canvas 2D context is not available in this browser.");
  }

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target: new BufferTarget(),
  });

  const videoSource = new CanvasSource(canvas, {
    codec: "avc",
    quality: new Quality({ bitrate: 8_000_000 }),
    keyFrameInterval: 2, // seconds — mediabunny handles the cadence itself
  });

  const audioSource = new AudioBufferSource({
    codec: "aac",
    quality: new Quality({ bitrate: 128_000 }),
  });

  output.addVideoTrack(videoSource, { frameRate: fps });
  output.addAudioTrack(audioSource);

  await output.start();

  /* =========================================================================
   * PASS 4 — RENDER VIDEO FRAME BY FRAME, IN VIRTUAL TIME
   *
   * This is the part that fixes frame dropping. A plain for-loop over frame
   * INDICES, not wall-clock time: frame N is always t = N / fps, however
   * long this iteration actually takes to run. A slow CPU makes the export
   * take longer -- it can never make it skip frame N or shorten the video.
   *
   * `await videoSource.add(...)` is mediabunny's own backpressure signal:
   * it resolves immediately when the encoder can keep up, and only waits
   * when it genuinely can't -- no manual queue-size polling or artificial
   * sleeps needed (that's what was costing extra wall-clock time before).
   * ========================================================================= */

  const totalFrames = Math.max(1, Math.round(totalDuration * fps));
  const frameDuration = 1 / fps;

  try {
    for (let frame = 0; frame < totalFrames; frame++) {
      if (signal?.cancelled) {
        throw new Error("Export cancelled.");
      }

      const t = frame / fps;

      // Pure function of (quiz, t) -- deterministic regardless of how this
      // frame happens to be timed.
      ctx.clearRect(0, 0, width, height);
      drawFrame(ctx, quiz, getState(finalTimeline, quiz, t), width, height, runKeyFor(timeline));

      await videoSource.add(t, frameDuration);

      if (frame % 10 === 0) {
        onProgress({
          stage: "Rendering frames...",
          percent: 46 + Math.round((frame / totalFrames) * 40),
        });
      }
    }

    videoSource.close();

    /* =======================================================================
     * PASS 5 — HAND OFF THE OFFLINE-RENDERED AUDIO
     * ===================================================================== */

    onProgress({ stage: "Finalizing MP4...", percent: 90 });

    await audioSource.add(renderedAudio);
    audioSource.close();

    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  }

  const bytes = output.target.buffer; // ArrayBuffer (or Uint8Array, depending on version)
  const blob = new Blob([bytes as ArrayBuffer], { type: "video/mp4" });

  onProgress({ stage: "Done", percent: 100 });

  return { blob, extension: "mp4" };
}

function runKeyFor(timeline: Timeline) {
  return timeline.seed;
}

/* ---------------------------------------------------------------------------
 * DOWNLOAD (unchanged)
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