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
  getVideoBitrate,
  renderVideo,
  getVideoDimensions,
  type RenderStage,
  type VideoQuality,
} from "@/lib/quiz/export";

import { buildTimeline } from "@/lib/quiz/timeline";

import type { AudioEngine } from "@/lib/quiz/audio";

import type {
  AudioSettings,
  Orientation,
  Quiz,
} from "@/lib/quiz/types";
import { CHARACTERS } from "@/lib/quiz/types";

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
  stage?: RenderStage;
  blob?: Blob;
  extension?: string;
  previewUrl?: string;
  error?: string;
}

interface Props {
  baseQuiz: Quiz;
  orientation: Orientation;
  videoQuality: VideoQuality;
  audio: AudioEngine;

  /** Voice/volume settings — needed so exported narration matches the editor's voice picker. */
  audioSettings: AudioSettings;
}

const wait = (ms: number) =>
  new Promise((resolve) =>
    setTimeout(resolve, ms),
  );

export function CsvBatchPanel({
  baseQuiz,
  orientation,
  videoQuality,
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

  const [downloadState, setDownloadState] =
    useState<{
      current: number;
      total: number;
      name?: string;
    } | null>(null);

  const videosRef = useRef(videos);

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
          baseQuiz.character,
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

          ...getVideoDimensions(videoQuality, orientation),
          videoBitrate: getVideoBitrate(videoQuality),

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

  const generateAll = async () => {
    if (
      !videos.length ||
      batchBusy
    ) {
      return;
    }

    setBatchBusy(true);

    /*
     * Ask for narration capture once, up front,
     * before the loop.
     */
    const narrationOk =
      await audio.captureNarration();

    if (!narrationOk) {
      toast.warning(
        "Narration capture wasn't granted — batch videos will render with SFX only.",
      );
    }

    /*
     * Videos are generated in CSV order.
     *
     * generateOne() checks:
     *   video.number === 1
     *
     * Therefore only the first video receives
     * the Owl entrance and intro.
     */
    for (
      const video of videos
    ) {
      await generateOne(video);
    }

    setBatchBusy(false);
  };

  const filename = (
    video: BatchVideo,
  ) =>
    `GK_Question_${String(
      video.number,
    ).padStart(
      2,
      "0",
    )}.${video.extension ?? "mp4"}`;

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
          <p className="mt-1 text-sm font-semibold text-primary">
            Character: {CHARACTERS.find((character) => character.id === baseQuiz.character)?.name ?? baseQuiz.character}
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

            <div className="flex gap-2">
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