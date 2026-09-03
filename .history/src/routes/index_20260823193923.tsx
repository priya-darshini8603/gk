const start = useCallback(
  (fresh: boolean) => {
    if (blocked) {
      toast.error("Please fix the highlighted fields first.");
      return;
    }
    audioRef.current?.ensure();
    audioRef.current?.apply(audioSettings);
    // Kick off narration capture on the first real user gesture too, so
    // Preview and Render share the same connected voice pipeline.
    void audioRef.current?.captureNarration();
    if (fresh) setSeed(Math.floor(Math.random() * 1e9));
    setTime(0);
    setPlaying(true);
  },
  [blocked, audioSettings],
);

const onRender = async () => {
  if (blocked) {
    toast.error("Please fix the highlighted fields first.");
    return;
  }
  if (!audioRef.current) return;
  setPlaying(false);
  setProgress({ stage: "Preparing animation...", percent: 0 });
  try {
    const { blob, extension } = await renderVideo({
      quiz,
      timeline,
      width: orientation === "landscape" ? 1920 : 1080,
      height: orientation === "landscape" ? 1080 : 1920,
      audio: audioRef.current,
      audioSettings, // was already here — keep it
      onProgress: setProgress,
    });
    downloadBlob(blob, `owl-quiz-${orientation}-1080p.${extension}`);
    const hadVoice = audioRef.current.hasNarrationCapture;
    toast.success(
      hadVoice
        ? "Video rendered with narration and downloaded."
        : "Video rendered, but narration capture wasn't granted — this file has SFX only. Click Render again and allow tab audio sharing to include the voice.",
    );
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Rendering failed.");
  } finally {
    setTimeout(() => setProgress(null), 1200);
  }
};