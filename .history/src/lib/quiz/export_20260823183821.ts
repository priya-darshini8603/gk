import { drawFrame } from "./renderer";
import { getState, buildCues, type Timeline } from "./timeline";
import type { Quiz } from "./types";
import { generateNarrationFile, type AudioEngine } from "./audio";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

export type RenderStage =
  | "Preparing animation..."
  | "Animating character..."
  | "Adding voice..."
  | "Rendering video..."
  | "Merging audio..."
  | "Finalizing MP4..."
  | "Done";

export interface RenderProgress {
  stage: RenderStage;
  percent: number;
}

let ffmpegPromise: Promise<FFmpeg> | null = null;

function getFFmpeg() {
  ffmpegPromise ??= (async () => {
      const ffmpeg = new FFmpeg();
      const base = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";
      await ffmpeg.load({ coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"), wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm") });
      return ffmpeg;
  })();
  return ffmpegPromise;
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
  audioSettings: Parameters<AudioEngine["apply"]>[0];
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
  onProgress({ stage: "Adding voice...", percent: 4 });
  const narration = await generateNarrationFile(cues, timeline.duration, quiz.language, opts.audioSettings);
  let cueIndex = 0;
  const runKey = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

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
      let stage: RenderStage = "Rendering video...";
      if (pct < 25) stage = "Animating character...";
      else if (pct < 45) stage = "Adding voice...";
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
  onProgress({ stage: "Merging audio...", percent: 96 });
  const ffmpeg = await getFFmpeg();
  await ffmpeg.writeFile("input-video", await fetchFile(blob));
  await ffmpeg.writeFile("narration.wav", await fetchFile(narration));
  await ffmpeg.exec(["-i", "input-video", "-i", "narration.wav", "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0[a]", "-map", "0:v:0", "-map", "[a]", "-c:v", mimeType.startsWith("video/mp4") ? "copy" : "libx264", "-c:a", "aac", "-b:a", "192k", "-shortest", "final.mp4"]);
  const finalData = await ffmpeg.readFile("final.mp4");
  if (typeof finalData === "string" || finalData.length === 0) throw new Error("FFmpeg produced an empty video.");
  await Promise.allSettled([ffmpeg.deleteFile("input-video"), ffmpeg.deleteFile("narration.wav"), ffmpeg.deleteFile("final.mp4")]);
  onProgress({ stage: "Done", percent: 100 });
  return { blob: new Blob([finalData], { type: "video/mp4" }), extension: "mp4" };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
