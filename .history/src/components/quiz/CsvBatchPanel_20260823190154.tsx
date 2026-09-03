// ...unchanged imports...

export function CsvBatchPanel({ baseQuiz, orientation, audio, audioSettings }: Readonly<Props>) {
  // ...unchanged state...

  const generateOne = async (video: BatchVideo) => {
    if (video.previewUrl) URL.revokeObjectURL(video.previewUrl);
    setVideos((current) =>
      current.map((item) => {
        if (item.id !== video.id) return item;
        const { error: _error, ...withoutError } = item;
        return { ...withoutError, status: "generating", percent: 0, stage: "Preparing animation..." };
      }),
    );
    try {
      const quiz = csvRowToQuiz(video.row, baseQuiz);
      const result = await renderVideo({
        quiz,
        timeline: buildTimeline(quiz, crypto.getRandomValues(new Uint32Array(1))[0]),
        width: orientation === "landscape" ? 1920 : 1080,
        height: orientation === "landscape" ? 1080 : 1920,
        audio,
        audioSettings, // FIX: this prop existed but was never passed through before
        onProgress: ({ percent, stage }) => update(video.id, { percent, stage }),
      });
      update(video.id, {
        status: "completed",
        percent: 100,
        stage: "Done",
        blob: result.blob,
        extension: result.extension,
        previewUrl: URL.createObjectURL(result.blob),
      });
      return true;
    } catch (error) {
      update(video.id, { status: "failed", error: error instanceof Error ? error.message : "Rendering failed." });
      return false;
    }
  };

  // ...rest of file unchanged...
}