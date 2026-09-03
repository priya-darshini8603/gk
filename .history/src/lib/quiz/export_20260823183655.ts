import { drawFrame } from "./renderer";
import { getState, buildCues, type Timeline } from "./timeline";
import type { Quiz } from "./types";
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
 * MediaRecorder (video + SFX/music bed). Resolves once the file is complete.
 */
export async function renderVideo(opts: {
  quiz: Quiz;
  timeline: Timeline;
  width: number;
  height: number;
  audio: AudioEngine;
  onProgress: (p: RenderProgress) => void;
  signal?: { cancelled: boolean };
}): Promise<{ blob: Blob; extension: string }> {
  const { quiz, timeline, width, height, audio, onProgress } = opts;
  onProgress({ stage: "Preparing animation...", percent: 2 });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");

  const fps = 30;
  const stream = canvas.captureStream(fps);
  audio.ensure();
  if (audio.dest) audio.dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));

  const mimeType = pickMime();
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const cues = buildCues(timeline);
  let cueIndex = 0;
  const runKey = Math.random();

  onProgress({ stage: "Animating character...", percent: 6 });
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
        cueIndex++;
      }
      drawFrame(ctx, quiz, getState(timeline, quiz, t), width, height, runKey);
      const pct = 6 + (t / timeline.duration) * 84;
      const stage: RenderStage =
        pct < 25 ? "Animating character..." : pct < 45 ? "Adding voice..." : "Rendering video...";
      onProgress({ stage, percent: Math.round(pct) });
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
