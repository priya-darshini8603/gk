import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

import { AudioEngine } from "@/lib/quiz/audio";
import { csvRowToQuiz } from "@/lib/quiz/csv";
import { buildTimeline } from "@/lib/quiz/timeline";
import { renderVideo } from "@/lib/quiz/export";

import type {
  OpenerToWorkerMessage,
  WorkerRow,
  WorkerToOpenerMessage,
} from "@/lib/quiz/batchProtocol";

export const Route = createFileRoute("/batch-worker")({
  component: BatchWorker,
});

type RowState = WorkerRow & {
  status: "queued" | "generating" | "completed" | "failed";
  percent: number;
  stage?: string;
  error?: string;
};

function BatchWorker() {
  const audioRef = useRef<AudioEngine | null>(null);
  if (!audioRef.current && typeof window !== "undefined") {
    audioRef.current = new AudioEngine();
  }

  const workerIdRef = useRef<string | null>(null);
  const jobRef = useRef<OpenerToWorkerMessage | null>(null);

  const [rows, setRows] = useState<RowState[] | null>(null);
  const [running, setRunning] = useState(false);
  const [hasOpener, setHasOpener] = useState(true);

  const post = (message: WorkerToOpenerMessage) => {
    window.opener?.postMessage(message, window.location.origin);
  };

  useEffect(() => {
    if (!window.opener) {
      setHasOpener(false);
      return;
    }

    // window.open(url, workerId, ...) on the opener side sets this tab's
    // window.name to workerId, so we already have a stable id before any
    // message round-trip.
    workerIdRef.current = window.name || `w${Date.now()}`;

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;

      const data = event.data as OpenerToWorkerMessage | undefined;
      if (!data || data.type !== "assign") return;
      if (data.workerId !== workerIdRef.current) return;

      jobRef.current = data;

      setRows(
        data.rows.map((row) => ({
          ...row,
          status: "queued",
        })),
      );
    };

    window.addEventListener("message", onMessage);

    post({ type: "worker-ready", workerId: workerIdRef.current });

    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateRow = (id: string, patch: Partial<RowState>) =>
    setRows((current) =>
      current
        ? current.map((row) => (row.id === id ? { ...row, ...patch } : row))
        : current,
    );

  const start = async () => {
    const job = jobRef.current;
    const audio = audioRef.current;

    if (!job || !audio || !rows || running) {
      return;
    }

    setRunning(true);

    // This click is the user gesture that authorizes tab-audio capture
    // for THIS tab. It's granted once and reused for every video this
    // worker renders in its assigned slice.
    const narrationOk = await audio.captureNarration();

    if (!narrationOk) {
      console.warn(
        "[batch-worker] Narration capture wasn't granted — this worker's videos will render with SFX only.",
      );
    }

    for (const row of rows) {
      updateRow(row.id, {
        status: "generating",
        percent: 0,
        stage: "Preparing animation...",
      });

      try {
        const quiz = csvRowToQuiz(row.row, job.baseQuiz);
        const isFirstQuestion = row.number === 1;

        const result = await renderVideo({
          quiz,

          timeline: buildTimeline(
            quiz,
            crypto.getRandomValues(new Uint32Array(1))[0],
            isFirstQuestion,
          ),

          width: job.orientation === "landscape" ? 1920 : 1080,
          height: job.orientation === "landscape" ? 1080 : 1920,

          audio,
          audioSettings: job.audioSettings,

          onProgress: ({ percent, stage }) => {
            updateRow(row.id, { percent, stage });

            post({
              type: "progress",
              workerId: job.workerId,
              rowId: row.id,
              percent,
              stage,
            });
          },
        });

        updateRow(row.id, {
          status: "completed",
          percent: 100,
          stage: "Done",
        });

        post({
          type: "row-done",
          workerId: job.workerId,
          rowId: row.id,
          blob: result.blob,
          extension: result.extension,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Rendering failed.";

        updateRow(row.id, { status: "failed", error: message });

        post({
          type: "row-failed",
          workerId: job.workerId,
          rowId: row.id,
          error: message,
        });
      }
    }

    post({ type: "worker-finished", workerId: job.workerId });

    setRunning(false);
  };

  if (!hasOpener) {
    return (
      <main className="mx-auto max-w-md space-y-3 p-8 text-center">
        <h1 className="font-display text-xl font-extrabold">
          Owl Quiz Studio — Batch Worker
        </h1>

        <p className="text-sm text-muted-foreground">
          This page renders quiz videos as part of a CSV batch job started
          from the main app. It isn&apos;t meant to be opened directly —
          go back to the main tab and use &quot;Generate All Videos&quot;
          instead.
        </p>
      </main>
    );
  }

  const allDone =
    rows !== null &&
    rows.every((row) => row.status === "completed" || row.status === "failed");

  return (
    <main className="mx-auto max-w-md space-y-4 p-6">
      <h1 className="font-display text-lg font-extrabold">Batch worker</h1>

      {!rows && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          Waiting for job from the main tab...
        </p>
      )}

      {rows && !running && rows.every((row) => row.status === "queued") && (
        <>
          <p className="text-sm text-muted-foreground">
            Assigned {rows.length} question{rows.length === 1 ? "" : "s"}:{" "}
            {rows.map((row) => `#${row.number}`).join(", ")}
          </p>

          <Button variant="hero" className="w-full" onClick={start}>
            <Play /> Start rendering
          </Button>

          <p className="text-xs text-muted-foreground">
            Your browser will ask to share this tab&apos;s audio — that's
            how narration gets baked into the video. Keep this tab open
            (it doesn't need to be in the foreground) until it closes
            itself automatically.
          </p>
        </>
      )}

      {rows && (running || rows.some((row) => row.status !== "queued")) && (
        <div className="space-y-3">
          {rows.map((row) => (
            <div
              key={row.id}
              className="space-y-1 rounded-2xl border border-border p-3"
            >
              <div className="flex items-center justify-between text-sm font-bold">
                <span>Question {row.number}</span>

                <span className="text-xs font-semibold text-muted-foreground">
                  {row.status === "completed"
                    ? "Done"
                    : row.status === "failed"
                      ? "Failed"
                      : (row.stage ?? "Waiting...")}
                </span>
              </div>

              {row.status === "generating" && <Progress value={row.percent} />}

              {row.status === "failed" && (
                <p className="text-xs text-destructive">{row.error}</p>
              )}
            </div>
          ))}

          {allDone && (
            <p className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <Download className="size-4" />
              All done — sending videos to the main tab. This window will
              close automatically.
            </p>
          )}
        </div>
      )}
    </main>
  );
}