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
  | "Verifying narration route..."
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

/**
 * Thrown when narration audio cannot be verified as present in the
 * exported output. Exporters MUST surface this to the user rather than
 * catching it and continuing — a video/audio file with silently missing
 * narration is worse than a clear failure.
 */
export class NarrationCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NarrationCaptureError";
  }
}

interface FinalBeat extends Beat {
  pcm: Float32Array | null;
  pcmSampleRate: number;
}

export interface FinalAudioTimeline {
  finalTimeline: Timeline;
  renderedAudio: AudioBuffer;
  totalDuration: number;
}

/* ---------------------------------------------------------------------------
 * Offline SFX synthesis helpers — deterministic oscillator/noise recipes
 * scheduled onto an OfflineAudioContext. Unchanged.
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
 * PASS 0 + 1 + 2 — shared by video export AND audio-only export
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

  const narrationIntentionallyMuted =
    audioSettings.muted || audioSettings.voiceVolume <= 0;
  const hasSpeechBeats = timeline.beats.some((b) => !!b.say);

  /* ---- PASS 0: verify the narration capture route BEFORE doing any work.
   * This is a fast, hard gate — if capture was never granted or never
   * wired up, we fail in milliseconds instead of after minutes of
   * narration measurement. Skipped entirely if narration is intentionally
   * muted or the timeline has no spoken lines at all. ---- */

  if (hasSpeechBeats && !narrationIntentionallyMuted) {
    onProgress?.({ stage: "Verifying narration route...", percent: 1 });

    const captureOk = await audio.captureNarration();
    const route = audio.verifyNarrationRoute();

    if (!captureOk || !route.ok) {
      throw new NarrationCaptureError(
        "Narration audio has no path into the exporter, so it would be silently missing from the output. " +
          (route.reason ?? "") +
          " This is almost always because 'Share tab audio' (sometimes labeled 'Also share tab audio') " +
          "wasn't checked in the sharing dialog. Please retry the export, choose 'This Tab' in the sharing " +
          "prompt, and make sure the audio-sharing checkbox is ticked."
      );
    }
  } else if (!narrationIntentionallyMuted) {
    // No speech beats at all — still fine to call this so downstream code
    // (e.g. re-exports) has a capture channel ready if needed later.
    await audio.captureNarration();
  }

  /* ---- PASS 1: measure every beat's real duration, verifying each
   * narration line actually produced audible captured audio. ---- */

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

      if (captured.silentCapture) {
        const preview =
          planned.say.length > 60 ? `${planned.say.slice(0, 60)}…` : planned.say;

        throw new NarrationCaptureError(
          `Narration was spoken but never reached the exporter (captured audio was silent) for the line: ` +
            `"${preview}". This happens when the active text-to-speech voice renders its audio through the ` +
            `operating system's native audio pipeline instead of the browser tab's own audio mix, which tab-audio ` +
            `capture cannot see. Try selecting a different narration voice (prefer an online/network voice over ` +
            `a local/offline system voice) and export again.`
        );
      }

      pcm = captured.pcm;
      pcmSampleRate = captured.sampleRate;

      // The captured sample count is the ground truth for this beat's real
      // length — more reliable than the separately-timed 'end' event.
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

  /* ---- PASS 2: mix narration + SFX into ONE deterministic AudioBuffer.
   *
   * This OfflineAudioContext graph — masterGain, fed by both the captured
   * narration PCM and every synthesized SFX — IS "the same destination
   * used by the exporter": nothing downstream of this point ever reads
   * from anywhere else. There is no separate, divergent audio path that
   * could drop narration after this. ---- */

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

  let narrationBeatsMixed = 0;

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

      narrationBeatsMixed++;
    }

    scheduleBeatSfx(offlineCtx, masterGain, beat, audioSettings.sfxVolume);
  }

  // Final structural guarantee: if there were speech beats and narration
  // wasn't intentionally muted, we must have actually mixed in narration
  // audio for at least one of them. If not, something upstream let a beat
  // through without pcm despite passing the per-beat silentCapture check
  // (e.g. all narration lines were empty strings) — fail loudly rather
  // than ship a narration-less file.
  if (hasSpeechBeats && !narrationIntentionallyMuted && narrationBeatsMixed === 0) {
    throw new NarrationCaptureError(
      "No narration audio was mixed into the export despite the timeline containing spoken lines. " +
        "Aborting rather than producing a video/audio file with missing narration."
    );
  }

  const renderedAudio = await offlineCtx.startRendering();

  return { finalTimeline, renderedAudio, totalDuration };
}

/* ---------------------------------------------------------------------------
 * RENDER VIDEO — mediabunny (built on WebCodecs)
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

    // This is the single point where narration + SFX (already verified and
    // mixed in buildFinalAudioTimeline) become the MP4's audio track.
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
 * RENDER AUDIO — audio-only export (unchanged aside from inheriting the
 * new verification from buildFinalAudioTimeline)
 * ------------------------------------------------------------------------- */

type RenderAudioOpts =
  | {
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
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
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