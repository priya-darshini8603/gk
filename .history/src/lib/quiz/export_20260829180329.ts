import { Muxer, ArrayBufferTarget } from "mp4-muxer";

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
 * Offline SFX synthesis helpers
 *
 * These mirror AudioEngine.tone()/noise() exactly, but schedule against an
 * OfflineAudioContext at absolute times instead of "ctx.currentTime + delay"
 * on a live context. Because the whole soundtrack is rendered in one
 * non-realtime pass, none of this is affected by how fast or slow the
 * machine currently is.
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
 * Reproduces the exact per-beat SFX timing from the old renderVideo():
 * a chime after each spoken/fixed beat completes, ticks during the
 * countdown, and the reveal/celebrate stingers. All times are now absolute
 * offsets into the final timeline instead of "whenever this beat happens
 * to finish rendering in real time."
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
 * RENDER VIDEO — WebCodecs + mp4-muxer
 *
 * This replaces MediaRecorder/canvas.captureStream() entirely. See the
 * comments inline for why each pass is immune to a slow main thread.
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

  if (
    typeof VideoEncoder === "undefined" ||
    typeof AudioEncoder === "undefined" ||
    typeof VideoFrame === "undefined" ||
    typeof AudioData === "undefined"
  ) {
    throw new Error(
      "This browser doesn't support WebCodecs (VideoEncoder/AudioEncoder). " +
        "Please use a recent Chrome, Edge, or other Chromium-based browser to export video."
    );
  }

  const fps = 30;

  onProgress({ stage: "Preparing animation...", percent: 1 });

  await audio.captureNarration();

  /* =========================================================================
   * PASS 1 — MEASURE REAL NARRATION AUDIO
   *
   * SpeechSynthesis is a real-time, real-device API — there's no way to
   * render it faster than real time. This is the ONLY wall-clock-bound part
   * of the export, and it does no canvas drawing at all, so a slow main
   * thread here cannot cause a dropped video frame: no video frames exist
   * yet at this point.
   *
   * Every beat ends up with a final, known duration:
   *   - speech beats -> exact length of the captured narration PCM
   *   - fixed beats  -> their already-fixed planned duration (e.g. the
   *                     countdown, which is always exactly quiz.timer)
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

      // The captured sample count IS the ground truth for how long this
      // beat actually is in the final file — more reliable than the
      // separately-measured 'end' event timing, which can be skewed by a
      // few ms of audio-pipeline latency.
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
   * SFX are pure synthesized tones (oscillators/noise), fully deterministic.
   * They're scheduled — along with the already-captured narration PCM —
   * onto an OfflineAudioContext and rendered in one shot. This runs as fast
   * as the CPU allows, NOT in real time, so it's also immune to jank.
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

  const renderedAudio = await offlineCtx.startRendering();

  /* =========================================================================
   * PASS 3 — ENCODE VIDEO, FRAME BY FRAME, IN VIRTUAL TIME
   *
   * This is the part that actually fixes frame dropping. Instead of
   * requestAnimationFrame + canvas.captureStream() + MediaRecorder (all of
   * which are driven by the real compositor and will happily skip whatever
   * didn't get composited in time), we iterate a plain for-loop over frame
   * INDICES. Frame N always represents t = N / fps, no matter how long this
   * loop iteration actually takes on the user's machine. A slow CPU makes
   * the export take longer wall-clock time — it can never make it skip
   * frame N or shorten the video.
   * ========================================================================= */

  onProgress({ stage: "Rendering frames...", percent: 46 });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    throw new Error("Canvas 2D context is not available in this browser.");
  }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: "avc",
      width,
      height,
    },
    audio: {
      codec: "aac",
      sampleRate: audioSampleRate,
      numberOfChannels: audioChannels,
    },
    fastStart: "in-memory",
  });

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => console.error("[export] video encoder error:", e),
  });

  videoEncoder.configure({
    codec: "avc1.640028",
    width,
    height,
    bitrate: 8_000_000,
    framerate: fps,
    avc: { format: "avc" },
  });

  const runKey = timeline.seed;
  const totalFrames = Math.max(1, Math.round(totalDuration * fps));
  const frameDurationUs = 1_000_000 / fps;

  for (let frame = 0; frame < totalFrames; frame++) {
    if (signal?.cancelled) {
      videoEncoder.close();
      throw new Error("Export cancelled.");
    }

    const t = frame / fps;

    // Pure function of (quiz, t) — deterministic, no dependency on how this
    // frame is being timed or how many frames we've drawn so far in real
    // time. Same input always produces the same pixels.
    ctx.clearRect(0, 0, width, height);
    drawFrame(ctx, quiz, getState(finalTimeline, quiz, t), width, height, runKey);

    const videoFrame = new VideoFrame(canvas, {
      timestamp: Math.round(frame * frameDurationUs),
      duration: Math.round(frameDurationUs),
    });

    // Backpressure only — waits if the encoder's internal queue is getting
    // long, so we don't blow up memory. This never skips a frame; it just
    // pauses production until the encoder catches up.
    while (videoEncoder.encodeQueueSize > 30) {
      await new Promise((r) => setTimeout(r, 0));
    }

    videoEncoder.encode(videoFrame, { keyFrame: frame % (fps * 2) === 0 });
    videoFrame.close();

    if (frame % 10 === 0) {
      onProgress({
        stage: "Rendering frames...",
        percent: 46 + Math.round((frame / totalFrames) * 40),
      });

      // Cooperative yield so the tab stays responsive. Purely a courtesy —
      // the frame index only ever advances inside this loop, so yielding
      // here cannot cause a skip.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  await videoEncoder.flush();
  videoEncoder.close();

  /* =========================================================================
   * PASS 4 — ENCODE THE OFFLINE-RENDERED AUDIO AND MUX
   * ========================================================================= */

  onProgress({ stage: "Finalizing MP4...", percent: 90 });

  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => console.error("[export] audio encoder error:", e),
  });

  audioEncoder.configure({
    codec: "mp4a.40.2",
    sampleRate: audioSampleRate,
    numberOfChannels: audioChannels,
    bitrate: 128_000,
  });

  const CHUNK_FRAMES = 1024;
  const totalSamples = renderedAudio.length;

  for (let offset = 0; offset < totalSamples; offset += CHUNK_FRAMES) {
    const frameCount = Math.min(CHUNK_FRAMES, totalSamples - offset);
    const planar = new Float32Array(frameCount * audioChannels);

    for (let ch = 0; ch < audioChannels; ch++) {
      const channelData = renderedAudio.getChannelData(ch);
      planar.set(channelData.subarray(offset, offset + frameCount), ch * frameCount);
    }

    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate: audioSampleRate,
      numberOfFrames: frameCount,
      numberOfChannels: audioChannels,
      timestamp: Math.round((offset / audioSampleRate) * 1_000_000),
      data: planar,
    });

    audioEncoder.encode(audioData);
    audioData.close();

    if ((offset / CHUNK_FRAMES) % 40 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  await audioEncoder.flush();
  audioEncoder.close();

  muxer.finalize();

  const { buffer } = muxer.target as ArrayBufferTarget;
  const blob = new Blob([buffer], { type: "video/mp4" });

  onProgress({ stage: "Done", percent: 100 });

  return { blob, extension: "mp4" };
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