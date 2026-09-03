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
  | "Encoding audio..."
  | "Finalizing MP4..."
  | "Done";

export interface RenderProgress {
  stage: RenderStage;
  percent: number;
}

interface FinalBeat extends Beat {
  pcm: Float32Array | null;
  pcmSampleRate: number;
}

/**
 * The fully-measured, fully-synthesized result of Pass 1 + Pass 2: an exact
 * beat timeline plus one finished AudioBuffer containing narration + every
 * SFX, correctly timed. This is the single source of truth that BOTH the
 * video exporter and the audio-only exporter build their output from, so
 * their timing can never disagree with each other when they share one of
 * these objects.
 */
export interface FinalAudioTimeline {
  finalTimeline: Timeline;
  renderedAudio: AudioBuffer;
  totalDuration: number;
}

/* ---------------------------------------------------------------------------
 * Offline SFX synthesis helpers
 *
 * Pure oscillator/noise recipes scheduled onto an OfflineAudioContext at
 * absolute times — fully deterministic, rendered faster than real time.
 * Nothing here is ever played out loud or captured from speakers/tab audio.
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

/**
 * Reproduces the exact per-beat SFX timing used by the live preview/export:
 * a chime after each beat completes, countdown ticks each second, and the
 * reveal/celebrate stingers — all as absolute offsets into the final,
 * measured timeline. Every beat kind that ever plays a sound is covered
 * here, so nothing is silently skipped.
 */
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
 * PASS 1 + PASS 2 — shared by video export AND audio-only export
 *
 * PASS 1 measures real narration. SpeechSynthesis can't be sped up or
 * rendered offline — this is the only wall-clock-bound step in the whole
 * pipeline, and it does zero canvas work, so it cannot cause a dropped
 * video frame or an inaccurate audio timestamp.
 *
 * PASS 2 synthesizes the ENTIRE soundtrack (narration + every SFX) onto one
 * OfflineAudioContext and renders it in a single non-realtime pass. Nothing
 * is played out loud, nothing is captured from speakers or tab audio here —
 * SFX are pure synthesis, and narration is the already-captured PCM from
 * Pass 1.
 * ------------------------------------------------------------------------- */

export async function buildFinalAudioTimeline(opts: {
  quiz: Quiz;
  timeline: Timeline;
  audio: AudioEngine;
  audioSettings: AudioSettings;
  onProgress?: (progress: RenderProgress) => void;
  signal?: { cancelled: boolean };
}): Promise<FinalAudioTimeline> {
  const { quiz, timeline, audio, audioSettings, onProgress, signal } = opts;

  // Needed so speakAndCapture() can tap real narration PCM (see audio.ts).
  await audio.captureNarration();

  /* ---- PASS 1: measure every beat's real duration ---- */

  const finalBeats: FinalBeat[] = [];
  let cursor = 0;

  for (let i = 0; i < timeline.beats.length; i++) {
    if (signal?.cancelled) throw new Error("Export cancelled.");

    const planned = timeline.beats[i]!;
    let dur = planned.dur;
    let pcm: Float32Array | null = null;
    let pcmSampleRate = 48000;

    if (planned.say) {
      onProgress?.({
        stage: "Measuring narration...",
        percent: 2 + Math.round((i / timeline.beats.length) * 38),
      });

      const captured = await audio.speakAndCapture(planned.say, quiz.language, audioSettings);
      pcm = captured.pcm;
      pcmSampleRate = captured.sampleRate;

      // The captured sample count is the ground truth for this beat's
      // real length in the final output — more reliable than the
      // separately-timed 'end' event, which can be skewed by a few ms of
      // audio-pipeline latency.
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

  /* ---- PASS 2: synthesize the whole soundtrack offline ---- */

  onProgress?.({ stage: "Synthesizing audio...", percent: 42 });

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
    // Narration, if this beat spoke anything.
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

    // SFX for this beat, if any (covers every beat kind that plays a sound:
    // board, pop, point, countdown ticks + final, correct + confetti, cheer).
    scheduleBeatSfx(offlineCtx, masterGain, beat, audioSettings.sfxVolume);
  }

  const renderedAudio = await offlineCtx.startRendering();

  return { finalTimeline, renderedAudio, totalDuration };
}

/* ---------------------------------------------------------------------------
 * RENDER VIDEO — mediabunny (built on WebCodecs). Unchanged behavior, now
 * just built on top of buildFinalAudioTimeline().
 * ------------------------------------------------------------------------- */

export async function renderVideo(opts: {
  quiz: Quiz;
  timeline: Timeline;
  width: number;
  height: number;
  audio: AudioEngine;
  audioSettings: AudioSettings;
  onProgress: (progress: RenderProgress) => void;
  signal?: { cancelled: boolean };
  /**
   * Called as soon as narration measurement + audio synthesis finish, before
   * video frame rendering starts. Cache this and pass it to renderAudio()
   * as `precomputed` to get an audio-only download with IDENTICAL timing
   * to this exact video, instead of a freshly (and separately) measured one.
   */
  onAudioTimelineReady?: (built: FinalAudioTimeline) => void;
}): Promise<{ blob: Blob; extension: string }> {
  const {
    quiz,
    timeline,
    width,
    height,
    audio,
    audioSettings,
    onProgress,
    signal,
    onAudioTimelineReady,
  } = opts;

  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") {
    throw new Error(
      "This browser doesn't support WebCodecs, which mediabunny needs to encode video. " +
        "Please use a recent Chrome, Edge, or other Chromium-based browser to export."
    );
  }

  const fps = 30;

  onProgress({ stage: "Preparing animation...", percent: 1 });

  const built = await buildFinalAudioTimeline({
    quiz,
    timeline,
    audio,
    audioSettings,
    onProgress,
    signal,
  });

  onAudioTimelineReady?.(built);

  const { finalTimeline, renderedAudio, totalDuration } = built;

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
    keyFrameInterval: 2,
  });

  const audioSource = new AudioBufferSource({
    codec: "aac",
    quality: new Quality({ bitrate: 128_000 }),
  });

  output.addVideoTrack(videoSource, { frameRate: fps });
  output.addAudioTrack(audioSource);

  await output.start();

  const runKey = timeline.seed;
  const totalFrames = Math.max(1, Math.round(totalDuration * fps));
  const frameDuration = 1 / fps;

  try {
    for (let frame = 0; frame < totalFrames; frame++) {
      if (signal?.cancelled) {
        throw new Error("Export cancelled.");
      }

      const t = frame / fps;

      ctx.clearRect(0, 0, width, height);
      drawFrame(ctx, quiz, getState(finalTimeline, quiz, t), width, height, runKey);

      await videoSource.add(t, frameDuration);

      if (frame % 10 === 0) {
        onProgress({
          stage: "Rendering frames...",
          percent: 46 + Math.round((frame / totalFrames) * 40),
        });
      }
    }

    videoSource.close();

    onProgress({ stage: "Finalizing MP4...", percent: 90 });

    await audioSource.add(renderedAudio);
    audioSource.close();

    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  }

  const bytes = output.target.buffer;
  const blob = new Blob([bytes as ArrayBuffer], { type: "video/mp4" });

  onProgress({ stage: "Done", percent: 100 });

  return { blob, extension: "mp4" };
}

/* ---------------------------------------------------------------------------
 * RENDER AUDIO — audio-only export
 *
 * Independent of video export: builds (or reuses) the same
 * FinalAudioTimeline and writes it straight to a WAV file. No
 * MediaRecorder, no canvas.captureStream(), no speaker/tab-audio loopback —
 * the WAV bytes come directly from the offline-rendered AudioBuffer.
 * ------------------------------------------------------------------------- */

type RenderAudioOpts =
  | {
      /** Reuse an already-built timeline (e.g. from a prior renderVideo()
       * call's onAudioTimelineReady) for a byte-for-byte match with that
       * video's audio. */
      precomputed: FinalAudioTimeline;
      audio: AudioEngine;
      audioSettings: AudioSettings;
      onProgress?: (progress: RenderProgress) => void;
      signal?: { cancelled: boolean };
    }
  | {
      quiz: Quiz;
      timeline: Timeline;
      audio: AudioEngine;
      audioSettings: AudioSettings;
      onProgress?: (progress: RenderProgress) => void;
      signal?: { cancelled: boolean };
    };

export async function renderAudio(
  opts: RenderAudioOpts
): Promise<{ blob: Blob; extension: string }> {
  const built =
    "precomputed" in opts
      ? opts.precomputed
      : await buildFinalAudioTimeline({
          quiz: opts.quiz,
          timeline: opts.timeline,
          audio: opts.audio,
          audioSettings: opts.audioSettings,
          onProgress: opts.onProgress,
          signal: opts.signal,
        });

  opts.onProgress?.({ stage: "Encoding audio...", percent: 96 });

  const blob = encodeWavBlob(built.renderedAudio);

  opts.onProgress?.({ stage: "Done", percent: 100 });

  return { blob, extension: "wav" };
}

/**
 * AudioBuffer -> 16-bit PCM WAV. Pure, synchronous, deterministic — no
 * encoding library, no WebCodecs dependency, universally playable.
 */
function encodeWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;

  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size (PCM)
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channelData.push(buffer.getChannelData(ch));
  }

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channelData[ch]![i]));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
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