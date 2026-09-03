import { drawFrame } from "./renderer";
import { getState, buildCues, type Timeline } from "./timeline";
import type { AudioSettings, Quiz } from "./types";
import type { AudioEngine } from "./audio";

export type RenderStage =
  | "Preparing animation..."
  | "Adding voice..."
  | "Animating character..."
  | "Rendering video..."
  | "Finalizing MP4..."
  | "Done";

export interface RenderProgress {
  stage: RenderStage;
  percent: number;
}

function pickMime() {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? "video/webm";
}

/**
 * Renders the quiz in real time off a hidden canvas and captures it with
 * MediaRecorder (video + mixed TTS/SFX/music audio). Resolves once the file
 * is complete.
 */
export async function renderVideo(opts: {
  quiz: Quiz;
  timeline: Timeline;
  width: number;
  height: number;
  audio: AudioEngine;
  audioSettings: AudioSettings; // NEW — required so narration matches the voice picker & is generated correctly
  onProgress: (p: RenderProgress) => void;
  signal?: { cancelled: boolean };
}): Promise<{ blob: Blob; extension: string }> {
  const { quiz, timeline, width, height, audio, audioSettings, onProgress } = opts;
  onProgress({ stage: "Preparing animation...", percent: 2 });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");

  const fps = 30;
  const stream = canvas.captureStream(fps);

  // canvas.captureStream() only ever gives a VIDEO track. The mixed
  // TTS+SFX+music audio track must be added explicitly.
  audio.ensure();
  audio.apply(audioSettings);
  if (audio.dest) audio.dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
  console.log("[Audio] mixed stream audio tracks:", audio.dest?.stream.getAudioTracks().length ?? 0);

  const cues = buildCues(timeline);

  // --- Generate + decode all narration BEFORE recording starts. -----------
  // This is the critical fix: TTS synthesis/decoding is async, so any cue
  // hit while a buffer is still loading would silently be dropped. Doing it
  // up front guarantees every "say" cue can start instantly & gaplessly,
  // in sync with the same clock that drives SFX and the canvas draw calls.
  onProgress({ stage: "Adding voice...", percent: 4 });
  await audio.prepareNarration(cues, quiz.language, audioSettings);

  const mimeType = pickMime();
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  let cueIndex = 0;
  const runKey = Math.random();

  onProgress({ stage: "Animating character...", percent: 8 });
  recorder.start(200);

  const start = performance.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const t = (performance.now() - start) / 1000;
      if (opts.signal?.cancelled || t >= timeline.duration) {
        resolve();
        return;
      }
      while (cueIndex < cues.length && cues[cueIndex]!.t <= t) {
        const cue = cues[cueIndex]!;
        if (cue.kind === "sfx" && cue.sfx) audio.sfx(cue.sfx);
        if (cue.kind === "say" && cue.text) audio.playSpeech(cue.text, quiz.language, audioSettings);
        cueIndex++;
      }
      drawFrame(ctx, quiz, getState(timeline, quiz, t), width, height, runKey);
      const pct = 8 + (t / timeline.duration) * 82;
      onProgress({ stage: pct < 60 ? "Animating character..." : "Rendering video...", percent: Math.round(pct) });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  onProgress({ stage: "Finalizing MP4...", percent: 94 });
  const blob: Blob = await new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.stop();
  });
  stream.getTracks().forEach((tr) => tr.stop());
  audio.stopSpeech();

  console.log("[Audio] recorded blob size:", (blob.size / 1024 / 1024).toFixed(2), "MB");
  onProgress({ stage: "Done", percent: 100 });
  return { blob, extension: mimeType.startsWith("video/mp4") ? "mp4" : "webm" };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}