import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type { SynthesizedClip } from "./tts";

const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";

let ffmpegPromise: Promise<FFmpeg> | null = null;

async function getFFmpeg(): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
      });
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

export interface MergeResult {
  blob: Blob;
  hasVideoStream: boolean;
  hasAudioStream: boolean;
  audioCodec: string | null;
}

function collectStreamInfo(logLines: string[]) {
  const hasVideo = logLines.some((l) => /Stream #\d+:\d+.+?Video:/.test(l));
  const audioLine = logLines.find((l) => /Stream #\d+:\d+.+?Audio:/.test(l));
  const codecMatch = /Audio:\s*(\w+)/.exec(audioLine ?? "");
  return { hasVideo, hasAudio: !!audioLine, audioCodec: codecMatch?.[1] ?? null };
}

/** `ffmpeg -i <path>` with no output always errors after printing stream info — that's fine, we only want the log. */
async function probe(ffmpeg: FFmpeg, path: string) {
  const lines: string[] = [];
  const handler = ({ message }: { message: string }) => lines.push(message);
  ffmpeg.on("log", handler);
  try {
    await ffmpeg.exec(["-i", path]).catch(() => undefined);
  } finally {
    ffmpeg.off("log", handler);
  }
  return collectStreamInfo(lines);
}

/** Builds one WAV narration track spanning totalDurationSec: each clip placed at its cue start, silence elsewhere. */
async function buildNarrationTrack(ffmpeg: FFmpeg, clips: SynthesizedClip[], totalDurationSec: number): Promise<string> {
  const outPath = "narration.wav";

  if (clips.length === 0) {
    await ffmpeg.exec([
      "-f", "lavfi",
      "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-t", totalDurationSec.toFixed(3),
      "-c:a", "pcm_s16le",
      outPath,
    ]);
    return outPath;
  }

  const inputNames = clips.map((clip, i) => `seg${i}.${clip.mime === "audio/wav" ? "wav" : "mp3"}`);
  for (let i = 0; i < clips.length; i++) {
    await ffmpeg.writeFile(inputNames[i]!, await fetchFile(clips[i]!.blob));
  }

  const args: string[] = [];
  inputNames.forEach((name) => args.push("-i", name));

  const delayed = clips
    .map((clip, i) => {
      const ms = Math.max(0, Math.round(clip.startSec * 1000));
      return `[${i}:a]adelay=${ms}|${ms},apad[a${i}]`;
    })
    .join(";");
  const mixInputs = clips.map((_, i) => `[a${i}]`).join("");
  const filter = `${delayed};${mixInputs}amix=inputs=${clips.length}:duration=longest:dropout_transition=0[mixed]`;

  args.push(
    "-filter_complex", filter,
    "-map", "[mixed]",
    "-t", totalDurationSec.toFixed(3),
    "-ar", "44100",
    "-ac", "2",
    "-c:a", "pcm_s16le",
    outPath,
  );
  await ffmpeg.exec(args);

  for (const name of inputNames) await ffmpeg.deleteFile(name).catch(() => undefined);
  return outPath;
}

/**
 * Merges real TTS audio into the recorded video.
 * - If the recorded video already has an audio track (SFX/music bed), the two
 *   are mixed into a single AAC track (never two competing tracks).
 * - Otherwise it's the straightforward "video + tts" map.
 * - Non-mp4 input (e.g. webm from browsers without mp4 MediaRecorder support)
 *   is transcoded to H.264 for universal playback; mp4/H.264 input is stream-copied.
 */
export async function mergeVideoWithNarration(
  videoBlob: Blob,
  videoExt: string,
  clips: SynthesizedClip[],
  totalDurationSec: number,
): Promise<MergeResult> {
  const ffmpeg = await getFFmpeg();
  const inPath = `input.${videoExt}`;
  const outPath = "final.mp4";

  await ffmpeg.writeFile(inPath, await fetchFile(videoBlob));
  const inputInfo = await probe(ffmpeg, inPath);
  const narrationPath = await buildNarrationTrack(ffmpeg, clips, totalDurationSec);

  const videoCodecArgs =
    videoExt === "mp4" ? ["-c:v", "copy"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];

  const args = inputInfo.hasAudio
    ? [
        "-i", inPath,
        "-i", narrationPath,
        "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[aout]",
        "-map", "0:v:0",
        "-map", "[aout]",
        ...videoCodecArgs,
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        outPath,
      ]
    : [
        "-i", inPath,
        "-i", narrationPath,
        "-map", "0:v:0",
        "-map", "1:a:0",
        ...videoCodecArgs,
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        outPath,
      ];

  await ffmpeg.exec(args);

  const outputInfo = await probe(ffmpeg, outPath);
  const data = await ffmpeg.readFile(outPath);
  const blob = new Blob([new Uint8Array(data as ArrayBufferLike)], { type: "video/mp4" });

  await ffmpeg.deleteFile(inPath).catch(() => undefined);
  await ffmpeg.deleteFile(narrationPath).catch(() => undefined);
  await ffmpeg.deleteFile(outPath).catch(() => undefined);

  return {
    blob,
    hasVideoStream: outputInfo.hasVideo,
    hasAudioStream: outputInfo.hasAudio,
    audioCodec: outputInfo.audioCodec,
  };
}