import type { AudioSettings, Orientation, Quiz } from "@/lib/quiz/types";
import type { CsvQuizRow } from "@/lib/quiz/csv";
import type { RenderStage } from "@/lib/quiz/export";

/**
 * Messages exchanged between the main tab (opener) and a batch-worker
 * pop-up tab.
 *
 * WHY THIS EXISTS:
 * A live (non-offline) AudioContext, and tab-audio capture via
 * getDisplayMedia, can never run faster than real time — that's a
 * platform constraint, not a config option. Narration is captured by
 * actually speaking it out loud and recording this tab's audio, so one
 * video's render time is roughly equal to that video's own duration.
 *
 * Running N renders "concurrently" inside a single tab doesn't work
 * either: window.speechSynthesis is one global queue per tab, and one
 * tab only has one audio output to capture — two simultaneous narrations
 * would collide and corrupt each other's captured audio.
 *
 * The only way to get genuine parallelism while staying on free,
 * browser-only speechSynthesis is one tab (and one AudioContext, and one
 * getDisplayMedia grant) per concurrent render. Each pop-up tab is
 * completely independent: its own AudioEngine, its own capture
 * permission, its own sequential loop over its assigned CSV rows.
 */

export interface WorkerRow {
  id: string;
  number: number;
  row: CsvQuizRow;
}

export type OpenerToWorkerMessage = {
  type: "assign";
  workerId: string;
  baseQuiz: Quiz;
  orientation: Orientation;
  audioSettings: AudioSettings;
  rows: WorkerRow[];
};

export type WorkerToOpenerMessage =
  | { type: "worker-ready"; workerId: string }
  | {
      type: "progress";
      workerId: string;
      rowId: string;
      percent: number;
      stage: RenderStage;
    }
  | {
      type: "row-done";
      workerId: string;
      rowId: string;
      blob: Blob;
      extension: string;
    }
  | { type: "row-failed"; workerId: string; rowId: string; error: string }
  | { type: "worker-finished"; workerId: string };

export function videoFilename(number: number, extension = "mp4") {
  return `GK_Question_${String(number).padStart(2, "0")}.${extension}`;
}

/** Distributes items across `poolSize` buckets, preserving relative order
 * within each bucket. Bucket count is clamped to at least 1 and at most
 * the number of items (no point opening a tab with nothing assigned). */
export function splitRoundRobin<T>(items: T[], poolSize: number): T[][] {
  const size = Math.max(1, Math.min(poolSize, items.length || 1));
  const buckets: T[][] = Array.from({ length: size }, () => []);
  items.forEach((item, index) => buckets[index % size]!.push(item));
  return buckets.filter((bucket) => bucket.length > 0);
}