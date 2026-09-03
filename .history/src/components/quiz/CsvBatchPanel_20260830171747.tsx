import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  Download,
  FileSpreadsheet,
  LoaderCircle,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

import {
  csvRowToQuiz,
  parseQuizCsv,
  type CsvQuizRow,
} from "@/lib/quiz/csv";

import {
  downloadBlob,
  renderVideo,
  type RenderStage,
} from "@/lib/quiz/export";

import { buildTimeline } from "@/lib/quiz/timeline";

import type { AudioEngine } from "@/lib/quiz/audio";

import type {
  AudioSettings,
  Orientation,
  Quiz,
} from "@/lib/quiz/types";

import {
  splitRoundRobin,
  videoFilename,
  type WorkerToOpenerMessage,
} from "@/lib/quiz/batchProtocol";

type VideoStatus =
  | "ready"
  | "generating"
  | "completed"
  | "failed";

interface BatchVideo {
  id: string;
  number: number;
  row: CsvQuizRow;
  status: VideoStatus;
  percent: number;
  stage?: RenderStage | string;
  blob?: Blob;
  extension?: string;
  previewUrl?: string;
  error?: string;
}

interface Props {
  baseQuiz: Quiz;
  orientation: Orientation;
  audio: AudioEngine;

  /** Voice/volume settings — needed so exported narration matches the editor's voice picker. */
  audioSettings: AudioSettings;
}

const wait = (ms: number) =>
  new Promise((resolve) =>
    setTimeout(resolve, ms),
  );

const MAX_POOL_SIZE = 6;

export function CsvBatchPanel({
  baseQuiz,
  orientation,
  audio,
  audioSettings,
}: Readonly<Props>) {
  const inputRef =
    useRef<HTMLInputElement>(null);

  const [videos, setVideos] =
    useState<BatchVideo[]>([]);

  const [errors, setErrors] =
    useState<string[]>([]);

  const [batchBusy, setBatchBusy] =
    useState(false);

  const [poolSize, setPoolSize] =
    useState(3);

  const [downloadState, setDownloadState] =
    useState<{
      current: number;
      total: number;
      name?: string;
    } | null>(null);

  const videosRef = useRef(videos);
  const openPopupsRef = useRef<Window[]>([]);

  useEffect(() => {
    videosRef.current = videos;
  }, [videos]);

  useEffect(
    () => () => {
      videosRef.current.forEach(
        (video) => {
          if (video.previewUrl) {
            URL.revokeObjectURL(
              video.previewUrl,
            );
          }
        },
      );

      // Don't leave orphaned worker tabs behind if the user navigates
      // away mid-batch.
      openPopupsRef.current.forEach((popup) => {
        if (!popup.closed) popup.close();
      });
    },
    [],
  );

  const update = (
    id: string,
    patch: Partial<BatchVideo>,
  ) =>
    setVideos((current) =>
      current.map((video) =>
        video.id === id
          ? {
              ...video,
              ...patch,
            }
          : video,
      ),
    );

  /** Only overwrites videos that haven't already completed — used by the
   * watchdog below so a slow-but-successful worker isn't clobbered by a
   * stale "closed" check racing its final message. */
  const failIfNotCompleted = (
    id: string,
    message: string,
  ) =>
    setVideos((current) =>
      current.map((video) =>
        video.id === id &&
        video.status !== "completed"
          ? {
              ...video,
              status: "failed",
              error: message,
            }
          : video,
      ),
    );

  const upload = async (
    file: File,
  ) => {
    setErrors([]);

    try {
      const result =
        parseQuizCsv(
          await file.text(),
        );

      setErrors(result.errors);

      setVideos(
        result.errors.length
          ? []
          : result.rows.map(
              (row, index) => ({
                id: `${Date.now()}-${index}`,
                number: index + 1,
                row,
                status: "ready",
                percent: 0,
              }),
            ),
      );
    } catch {
      setVideos([]);

      setErrors([
        "Unable to read this file as CSV.",
      ]);
    }
  };

  const generateOne = async (
    video: BatchVideo,
  ) => {
    if (video.previewUrl) {
      URL.revokeObjectURL(
        video.previewUrl,
      );
    }

    setVideos((current) =>
      current.map((item) => {
        if (item.id !== video.id) {
          return item;
        }

        const {
          error: _error,
          ...withoutError
        } = item;

        return {
          ...withoutError,
          status: "generating",
          percent: 0,
          stage:
            "Preparing animation...",
        };
      }),
    );

    try {
      const quiz =
        csvRowToQuiz(
          video.row,
          baseQuiz,
        );

      /*
       * IMPORTANT:
       *
       * Question 1:
       *   isFirstQuestion = true
       *   -> Owl enters
       *   -> Intro
       *   -> Question
       *
       * Question 2+:
       *   isFirstQuestion = false
       *   -> Question directly
       */
      const isFirstQuestion =
        video.number === 1;

      const result =
        await renderVideo({
          quiz,

          timeline:
            buildTimeline(
              quiz,
              crypto.getRandomValues(
                new Uint32Array(1),
              )[0],
              isFirstQuestion,
            ),

          width:
            orientation === "landscape"
              ? 1920
              : 1080,

          height:
            orientation === "landscape"
              ? 1080
              : 1920,

          audio,

          audioSettings,

          onProgress: ({
            percent,
            stage,
          }) =>
            update(
              video.id,
              {
                percent,
                stage,
              },
            ),
        });

      update(video.id, {
        status: "completed",
        percent: 100,
        stage: "Done",
        blob: result.blob,
        extension:
          result.extension,
        previewUrl:
          URL.createObjectURL(
            result.blob,
          ),
      });

      return true;
    } catch (error) {
      update(video.id, {
        status: "failed",
        error:
          error instanceof Error
            ? error.message
            : "Rendering failed.",
      });

      return false;
    }
  };

  /**
   * Real parallel rendering across `poolSize` pop-up tabs. Each tab gets
   * its own AudioEngine, its own tab-audio capture permission, and a
   * slice of the CSV rows to render sequentially — see
   * lib/quiz/batchProtocol.ts for why this (rather than N renders inside
   * one tab) is the only way to get genuine parallelism with free,
   * browser-only speechSynthesis.
   */
  const generateAllParallel = (
    targets: BatchVideo[],
    size: number,
  ) =>
    new Promise<void>((resolveAll) => {
      const buckets = splitRoundRobin(
        targets,
        size,
      );

      const workerIds = buckets.map(
        (_, index) =>
          `w${Date.now()}-${index}`,
      );

      // Open every pop-up synchronously, in direct response to the click
      // that triggered generateAll — opening them after an `await` is
      // much more likely to be blocked as unwanted pop-ups.
      const popups = workerIds.map(
        (workerId) =>
          window.open(
            `${window.location.origin}/batch-worker`,
            workerId,
            "width=440,height=680",
          ),
      );

      const blockedCount = popups.filter(
        (popup) => !popup,
      ).length;

      if (blockedCount > 0) {
        popups.forEach((popup) =>
          popup?.close(),
        );

        toast.error(
          `${blockedCount} pop-up${
            blockedCount > 1
              ? "s were"
              : " was"
          } blocked. Please allow pop-ups for this site, then try again.`,
        );

        resolveAll();
        return;
      }

      const liveWorkers = new Set(
        workerIds,
      );

      openPopupsRef.current = popups.filter(
        (p): p is Window => !!p,
      );

      const onMessage = (
        event: MessageEvent,
      ) => {
        if (
          event.origin !==
          window.location.origin
        ) {
          return;
        }

        const data =
          event.data as
            | WorkerToOpenerMessage
            | undefined;

        if (
          !data ||
          !workerIds.includes(
            data.workerId,
          )
        ) {
          return;
        }

        const workerIndex =
          workerIds.indexOf(
            data.workerId,
          );

        const popup =
          popups[workerIndex];

        switch (data.type) {
          case "worker-ready": {
            const rows =
              buckets[workerIndex] ??
              [];

            popup?.postMessage(
              {
                type: "assign",
                workerId:
                  data.workerId,
                baseQuiz,
                orientation,
                audioSettings,
                rows: rows.map(
                  (video) => ({
                    id: video.id,
                    number:
                      video.number,
                    row: video.row,
                  }),
                ),
              },
              window.location.origin,
            );

            break;
          }

          case "progress":
            update(data.rowId, {
              status:
                "generating",
              percent:
                data.percent,
              stage: data.stage,
            });

            break;

          case "row-done":
            update(data.rowId, {
              status: "completed",
              percent: 100,
              stage: "Done",
              blob: data.blob,
              extension:
                data.extension,
              previewUrl:
                URL.createObjectURL(
                  data.blob,
                ),
            });

            break;

          case "row-failed":
            update(data.rowId, {
              status: "failed",
              error: data.error,
            });

            break;

          case "worker-finished":
            popup?.close();

            liveWorkers.delete(
              data.workerId,
            );

            if (
              liveWorkers.size === 0
            ) {
              window.removeEventListener(
                "message",
                onMessage,
              );

              openPopupsRef.current =
                [];

              resolveAll();
            }

            break;
        }
      };

      window.addEventListener(
        "message",
        onMessage,
      );

      // Safety net: if the user manually closes a worker tab mid-render,
      // don't hang forever waiting for its "worker-finished" message.
      const watchdog =
        window.setInterval(() => {
          let changed = false;

          workerIds.forEach(
            (workerId, index) => {
              if (
                !liveWorkers.has(
                  workerId,
                )
              ) {
                return;
              }

              const popup =
                popups[index];

              if (popup?.closed) {
                liveWorkers.delete(
                  workerId,
                );

                changed = true;

                buckets[
                  index
                ]?.forEach((video) =>
                  failIfNotCompleted(
                    video.id,
                    "Worker tab was closed before finishing.",
                  ),
                );
              }
            },
          );

          if (
            changed &&
            liveWorkers.size === 0
          ) {
            window.clearInterval(
              watchdog,
            );

            window.removeEventListener(
              "message",
              onMessage,
            );

            openPopupsRef.current = [];

            resolveAll();
          }
        }, 1000);

      // Mark everything as queued while the worker tabs spin up.
      targets.forEach((video) =>
        update(video.id, {
          status: "generating",
          percent: 0,
          stage:
            "Waiting for worker tab...",
        }),
      );
    });

  const generateAll = async () => {
    if (
      !videos.length ||
      batchBusy
    ) {
      return;
    }

    setBatchBusy(true);

    const effectivePoolSize = Math.max(
      1,
      Math.min(
        poolSize,
        videos.length,
      ),
    );

    if (effectivePoolSize <= 1) {
      // Single tab, same as before.
      const narrationOk =
        await audio.captureNarration();

      if (!narrationOk) {
        toast.warning(
          "Narration capture wasn't granted — batch videos will render with SFX only.",
        );
      }

      for (
        const video of videos
      ) {
        await generateOne(video);
      }
    } else {
      await generateAllParallel(
        videos,
        effectivePoolSize,
      );
    }

    setBatchBusy(false);
  };

  const filename = (
    video: BatchVideo,
  ) =>
    videoFilename(
      video.number,
      video.extension ?? "mp4",
    );

  const downloadOne = (
    video: BatchVideo,
  ) => {
    if (video.blob) {
      downloadBlob(
        video.blob,
        filename(video),
      );
    }
  };

  const downloadAll = async () => {
    if (downloadState) {
      return;
    }

    let processed = 0;
    let completed = 0;

    for (
      const video of videos
    ) {
      if (
        !video.blob ||
        video.status !==
          "completed"
      ) {
        processed += 1;
        continue;
      }

      const name =
        filename(video);

      setDownloadState({
        current:
          processed + 1,
        total:
          videos.length,
        name,
      });

      try {
        downloadBlob(
          video.blob,
          name,
        );

        completed += 1;
      } catch {
        // Continue the queue when
        // an individual browser
        // download is interrupted.
      }

      processed += 1;

      await wait(350);
    }

    setDownloadState(null);

    const skipped =
      videos.length -
      completed;

    const skippedMessage =
      skipped
        ? `; ${skipped} skipped.`
        : ".";

    toast.success(
      `Download completed. ${completed} / ${videos.length} videos downloaded${skippedMessage}`,
    );
  };

  return (
    <section className="space-y-4 rounded-3xl bg-card p-5 shadow-[var(--shadow-soft)] lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-xl font-extrabold">
            <FileSpreadsheet className="size-5 text-primary" />
            Upload CSV & Generate Videos
          </h2>

          <p className="mt-1 text-sm text-muted-foreground">
            One CSV row becomes one independently downloadable quiz video, with narration baked into the MP4.
          </p>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(event) =>
            event.target.files?.[0] &&
            upload(
              event.target.files[0],
            )
          }
        />

        <Button
          variant="hero"
          onClick={() =>
            inputRef.current?.click()
          }
        >
          <Upload />
          Upload CSV &amp; Generate Videos
        </Button>
      </div>

      {errors.length > 0 && (
        <div className="space-y-1 rounded-2xl bg-destructive/10 p-3 text-sm text-destructive">
          {errors.map(
            (error) => (
              <p key={error}>
                <X className="mr-1 inline size-4" />
                {error}
              </p>
            ),
          )}
        </div>
      )}

      {videos.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-muted px-4 py-3">
            <span className="font-bold">
              <Check className="mr-1 inline size-4 text-green-600" />
              {videos.length} questions detected
            </span>

            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs font-bold text-muted-foreground">
                Parallel tabs
                <select
                  className="rounded-lg border border-border bg-background px-2 py-1 text-xs font-bold text-foreground"
                  value={poolSize}
                  disabled={batchBusy}
                  onChange={(event) =>
                    setPoolSize(
                      Number(
                        event.target
                          .value,
                      ),
                    )
                  }
                >
                  {Array.from(
                    {
                      length:
                        MAX_POOL_SIZE,
                    },
                    (_, i) => i + 1,
                  ).map((n) => (
                    <option
                      key={n}
                      value={n}
                    >
                      {n === 1
                        ? "1 (this tab)"
                        : `${n} tabs`}
                    </option>
                  ))}
                </select>
              </label>

              <Button
                variant="fun"
                disabled={batchBusy}
                onClick={generateAll}
              >
                <LoaderCircle
                  className={
                    batchBusy
                      ? "animate-spin"
                      : ""
                  }
                />

                {batchBusy
                  ? "Generating..."
                  : "Generate All Videos"}
              </Button>

              <Button
                variant="outline"
                disabled={
                  !!downloadState ||
                  !videos.some(
                    (video) =>
                      !!video.blob,
                  )
                }
                onClick={
                  downloadAll
                }
              >
                <Download />
                Download All
              </Button>
            </div>
          </div>

          {poolSize > 1 && !batchBusy && (
            <p className="text-xs text-muted-foreground">
              Generating with {Math.max(1, Math.min(poolSize, videos.length))} tabs — each will ask once to share its tab audio, then render its share of the questions unattended.
            </p>
          )}

          {downloadState && (
            <div className="space-y-2">
              <Progress
                value={
                  (downloadState.current /
                    downloadState.total) *
                  100
                }
              />

              <p className="text-sm font-bold">
                Downloading videos...{" "}
                {downloadState.current} /{" "}
                {downloadState.total} ·{" "}
                {downloadState.name}
              </p>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            {videos.map(
              (video) => (
                <article
                  key={video.id}
                  className="space-y-3 rounded-2xl border border-border bg-background p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-display font-extrabold">
                        Question{" "}
                        {video.number}
                      </p>

                      <p className="line-clamp-2 text-sm text-muted-foreground">
                        {video.row.question}
                      </p>
                    </div>

                    <Status
                      status={
                        video.status
                      }
                    />
                  </div>

                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <div>
                      <dt className="font-bold text-foreground">
                        A
                      </dt>
                      <dd>
                        {
                          video.row
                            .options
                            .A
                        }
                      </dd>
                    </div>

                    <div>
                      <dt className="font-bold text-foreground">
                        B
                      </dt>
                      <dd>
                        {
                          video.row
                            .options
                            .B
                        }
                      </dd>
                    </div>

                    <div>
                      <dt className="font-bold text-foreground">
                        C
                      </dt>
                      <dd>
                        {
                          video.row
                            .options
                            .C
                        }
                      </dd>
                    </div>

                    <div>
                      <dt className="font-bold text-foreground">
                        D
                      </dt>
                      <dd>
                        {
                          video.row
                            .options
                            .D
                        }
                      </dd>
                    </div>

                    <div>
                      <dt className="font-bold text-foreground">
                        Answer
                      </dt>
                      <dd>
                        {
                          video.row
                            .correct
                        }
                      </dd>
                    </div>

                    <div className="col-span-2">
                      <dt className="font-bold text-foreground">
                        Explanation
                      </dt>
                      <dd>
                        {
                          video.row
                            .explanation
                        }
                      </dd>
                    </div>
                  </dl>

                  {video.previewUrl && (
                    <video
                      controls
                      preload="metadata"
                      src={
                        video.previewUrl
                      }
                      className="aspect-video w-full rounded-xl bg-black"
                    >
                      <track
                        kind="captions"
                        src="data:text/vtt,WEBVTT%0A"
                        label="Captions"
                      />
                    </video>
                  )}

                  {video.status ===
                    "generating" && (
                    <div className="space-y-1">
                      <Progress
                        value={
                          video.percent
                        }
                      />

                      <p className="text-xs font-semibold text-muted-foreground">
                        {video.stage ??
                          "Generating..."}
                      </p>
                    </div>
                  )}

                  {video.status ===
                    "failed" && (
                    <p className="text-sm text-destructive">
                      {video.error}
                    </p>
                  )}

                  <div className="flex justify-end gap-2">
                    {video.status ===
                      "failed" && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          batchBusy
                        }
                        onClick={() =>
                          generateOne(
                            video,
                          )
                        }
                      >
                        <RotateCcw />
                        Regenerate
                      </Button>
                    )}

                    {video.status ===
                      "completed" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          downloadOne(
                            video,
                          )
                        }
                      >
                        <Download />
                        Download
                      </Button>
                    )}
                  </div>
                </article>
              ),
            )}
          </div>
        </>
      )}
    </section>
  );
}

function Status({
  status,
}: Readonly<{
  status: VideoStatus;
}>) {
  const labels: Record<
    VideoStatus,
    string
  > = {
    ready: "Ready",
    generating:
      "Generating",
    completed:
      "Completed",
    failed: "Failed",
  };

  let color =
    "bg-secondary text-secondary-foreground";

  if (
    status === "failed"
  ) {
    color =
      "bg-destructive/10 text-destructive";
  }

  if (
    status === "completed"
  ) {
    color =
      "bg-green-100 text-green-700";
  }

  return (
    <span
      className={`rounded-full px-2 py-1 text-xs font-bold ${color}`}
    >
      {labels[status]}
    </span>
  );
}