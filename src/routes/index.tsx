import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Download,
  Maximize2,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { Toaster } from "@/components/ui/sonner";
import { QuizEditor } from "@/components/quiz/QuizEditor";
import { QuizPlayer } from "@/components/quiz/QuizPlayer";
import { CsvBatchPanel } from "@/components/quiz/CsvBatchPanel";
import { AudioEngine } from "@/lib/quiz/audio";
import { buildTimeline } from "@/lib/quiz/timeline";
import {
  downloadBlob,
  getVideoBitrate,
  getVideoDimensions,
  renderVideo,
  type RenderProgress,
  type VideoQuality,
} from "@/lib/quiz/export";
import { hasErrors, validateQuiz } from "@/lib/quiz/validation";
import { DEFAULT_QUIZ, type AudioSettings, type Orientation, type Quiz } from "@/lib/quiz/types";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Owl Quiz Studio — Kids GK Quiz Video Generator" },
      {
        name: "description",
        content:
          "Create animated 1080p kids general-knowledge quiz videos with a cute 3D owl mascot, countdown, answer reveal and confetti celebration.",
      },
      { property: "og:title", content: "Owl Quiz Studio — Kids GK Quiz Video Generator" },
      {
        property: "og:description",
        content:
          "Type a question, hit create, and export a polished animated kids quiz video in landscape or portrait.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Studio,
});

const DEFAULT_AUDIO: AudioSettings = {
  voice: "Cute Child",
  voiceVolume: 1,
  musicVolume: 0.5,
  sfxVolume: 0.7,
  music: true,
  muted: false,
};

// FIX: was `Math.floor(Math.random() * 1e9)` inside useState's initializer.
// That runs during render on the SERVER (one random value baked into the
// SSR HTML) and again during the CLIENT's hydration render (a different
// random value) — producing two different buildTimeline() outputs and
// tripping React's hydration-mismatch check (different slider max, different
// formatted duration text, etc). A render-time value must be deterministic
// and identical on server + client. Only randomize in response to an actual
// user gesture (see `start()` below, which is only ever called from an
// onClick handler — never from render or a mount effect).
const INITIAL_SEED = 1;

function fmt(t: number) {
  const s = Math.max(0, t);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function Studio() {
  const [quiz, setQuiz] = useState<Quiz>(DEFAULT_QUIZ);
  const [audioSettings, setAudioSettings] = useState<AudioSettings>(DEFAULT_AUDIO);
  const [orientation, setOrientation] = useState<Orientation>("landscape");
  const [videoQuality, setVideoQuality] = useState<VideoQuality>("1080p");
  const [seed, setSeed] = useState(INITIAL_SEED);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<AudioEngine | null>(null);
  // Lazy-init pattern (React-docs endorsed): guarded by typeof window so the
  // server never touches it, and it only ever constructs the JS object here
  // — it does NOT create an AudioContext (AudioEngine's constructor is inert;
  // AudioContext creation is deferred to ensure(), which is only called from
  // user-gesture-triggered code paths below).
  if (!audioRef.current && typeof window !== "undefined") audioRef.current = new AudioEngine();

  const issues = useMemo(() => validateQuiz(quiz), [quiz]);
  const blocked = hasErrors(issues);
  const timeline = useMemo(() => buildTimeline(quiz, seed), [quiz, seed]);

  // FIX: previously this ran unconditionally on mount and on every
  // audioSettings change, calling audio.apply() -> audio.ensure() ->
  // `new AudioContext()` with no user gesture at all, which is exactly what
  // triggers "The AudioContext was not allowed to start." Now it only
  // touches the context if one has already been created by a prior user
  // gesture (Play / Render). Settings picked before the first gesture are
  // still respected — QuizPlayer calls audio.apply(audioSettings) itself the
  // moment playback actually starts, and onRender/renderVideo does the same.
  useEffect(() => {
    if (audioRef.current?.hasContext) {
      audioRef.current.apply(audioSettings);
    }
  }, [audioSettings]);

  useEffect(() => () => audioRef.current?.dispose(), []);

  const start = useCallback(
    (fresh: boolean) => {
      if (blocked) {
        toast.error("Please fix the highlighted fields first.");
        return;
      }
      // Safe to create/resume the AudioContext here — this function is only
      // ever invoked from an onClick handler, i.e. inside a real user gesture.
      audioRef.current?.ensure();
      audioRef.current?.apply(audioSettings);
      // Kick off narration tab-capture on the first real gesture too, so the
      // Preview button and the Render button share one connected voice
      // pipeline instead of asking for permission twice. captureNarration()
      // is idempotent, so calling it again from onRender is a no-op.
      void audioRef.current?.captureNarration();
      if (fresh) setSeed(Math.floor(Math.random() * 1e9)); // client-only randomization, post-gesture: safe
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
      const { width, height } = getVideoDimensions(videoQuality, orientation);
      const { blob, extension } = await renderVideo({
        quiz,
        timeline,
        width,
        height,
        videoBitrate: getVideoBitrate(videoQuality),
        audio: audioRef.current,
        audioSettings,
        onProgress: setProgress,
      });
      downloadBlob(blob, `owl-quiz-${orientation}-${videoQuality}.${extension}`);
      const hadVoice = audioRef.current.hasNarrationCapture;
      toast.success(
        hadVoice
          ? extension === "mp4"
            ? "Video rendered with narration and downloaded as MP4."
            : `Video rendered with narration. Your browser exports WebM (${videoQuality}) — playable everywhere and convertible to MP4.`
          : "Video rendered, but narration capture wasn't granted — this file has SFX only. Click Render again and allow tab-audio sharing to include the voice.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rendering failed.");
    } finally {
      setTimeout(() => setProgress(null), 1200);
    }
  };

  const rendering = progress !== null;

  return (
    <div className="min-h-screen bg-[image:var(--gradient-sky)]">
      <Toaster position="top-center" />
      <header className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3 px-5 py-6">
        <div className="flex items-center gap-3">
          <span className="grid size-12 place-items-center rounded-2xl bg-[image:var(--gradient-hero)] text-2xl shadow-[var(--shadow-pop)]">
            🥚
          </span>
          <div>
            <h1 className="inline-block rounded-xl bg-brand-navy px-3 py-1 font-display text-2xl font-extrabold leading-tight text-brand-navy-foreground">
              GK QUIZ
            </h1>
            <p className="text-sm text-muted-foreground">
              Animated GK quiz videos for kids, hosted by one very nervous owl.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-2xl bg-card p-1 shadow-[var(--shadow-soft)]">
            {(["landscape", "portrait"] as Orientation[]).map((o) => (
              <button
                key={o}
                onClick={() => setOrientation(o)}
                className={`rounded-xl px-4 py-2 text-sm font-bold capitalize transition-colors ${
                  orientation === o ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                }`}
              >
                {o === "landscape" ? "16:9" : "9:16"}
              </button>
            ))}
          </div>
          <Button variant="hero" size="lg" disabled={rendering} onClick={() => start(true)}>
            <Wand2 /> Create quiz video
          </Button>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1500px] grid-cols-1 gap-6 px-5 pb-12 lg:grid-cols-[400px_1fr]">
        <CsvBatchPanel
          baseQuiz={quiz}
          orientation={orientation}
          videoQuality={videoQuality}
          audio={audioRef.current!}
          audioSettings={audioSettings}
        />
        <QuizEditor
          quiz={quiz}
          onChange={(q) => {
            setQuiz(q);
            setPlaying(false);
            setTime(0);
          }}
          audio={audioSettings}
          onAudioChange={setAudioSettings}
          issues={issues}
        />

        <section className="space-y-4">
          <div
            ref={stageRef}
            className="rounded-3xl bg-card p-4 shadow-[var(--shadow-soft)]"
          >
            <div
              className={`mx-auto ${orientation === "landscape" ? "aspect-video w-full" : "aspect-[9/16] max-h-[70vh]"}`}
            >
              <QuizPlayer
                quiz={quiz}
                timeline={timeline}
                orientation={orientation}
                playing={playing}
                time={time}
                audio={audioRef.current!}
                audioSettings={audioSettings}
                onTime={setTime}
                onEnded={() => setPlaying(false)}
              />
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                variant="fun"
                size="lg"
                disabled={rendering}
                onClick={() => (playing ? setPlaying(false) : start(false))}
              >
                {playing ? <Pause /> : <Play />} {playing ? "Pause" : "Preview question"}
              </Button>
              <Button variant="outline" className="rounded-2xl" onClick={() => start(true)}>
                <RotateCcw /> Replay
              </Button>
              <Button
                variant="outline"
                className="rounded-2xl"
                onClick={() => {
                  setPlaying(false);
                  document.getElementById("question")?.focus();
                }}
              >
                <Pencil /> Edit quiz
              </Button>
              <div className="flex min-w-[220px] flex-1 items-center gap-3">
                <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
                  {fmt(time)}
                </span>
                <Slider
                  value={[time]}
                  max={timeline.duration}
                  step={0.05}
                  onValueChange={([v]) => {
                    setPlaying(false);
                    setTime(v ?? 0);
                  }}
                />
                <span className="w-10 text-xs tabular-nums text-muted-foreground">
                  {fmt(timeline.duration)}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="rounded-2xl"
                onClick={() => setAudioSettings((a) => ({ ...a, muted: !a.muted }))}
              >
                {audioSettings.muted ? <VolumeX /> : <Volume2 />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="rounded-2xl"
                onClick={() => stageRef.current?.requestFullscreen?.()}
              >
                <Maximize2 />
              </Button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-[1fr_320px]">
            <div className="rounded-3xl bg-card p-5 shadow-[var(--shadow-soft)]">
              <h2 className="mb-3 font-display text-lg font-extrabold">Scene timeline</h2>
              <div className="flex flex-wrap gap-2">
                {timeline.beats.map((b, i) => {
                  const active = time >= b.start && time < b.start + b.dur;
                  return (
                    <button
                      key={i}
                      onClick={() => {
                        setPlaying(false);
                        setTime(b.start + 0.01);
                      }}
                      className={`rounded-2xl px-3 py-2 text-xs font-bold transition-colors ${
                        active
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary text-secondary-foreground hover:bg-accent"
                      }`}
                    >
                      {b.scene}. {b.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-3 rounded-3xl bg-card p-5 shadow-[var(--shadow-soft)]">
              <h2 className="font-display text-lg font-extrabold">Export</h2>
              <label className="block text-sm font-bold" htmlFor="video-quality">
                Video quality
              </label>
              <select
                id="video-quality"
                value={videoQuality}
                disabled={rendering}
                onChange={(event) => setVideoQuality(event.target.value as VideoQuality)}
                className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm font-semibold"
              >
                <option value="1080p">1080p · Full HD</option>
                <option value="2k">2K · QHD</option>
                <option value="4k">4K · Ultra HD</option>
              </select>
              <p className="text-sm text-muted-foreground">
                {getVideoDimensions(videoQuality, orientation).width} × {getVideoDimensions(videoQuality, orientation).height} · 30fps
              </p>
              <Button
                variant="hero"
                size="lg"
                className="w-full"
                disabled={rendering}
                onClick={onRender}
              >
                <Download /> {rendering ? "Rendering…" : "Render video"}
              </Button>
              {progress && (
                <div className="space-y-2">
                  <Progress value={progress.percent} />
                  <p className="text-sm font-bold text-foreground">
                    {progress.stage} {progress.percent}%
                  </p>
                </div>
              )}
              {!rendering && (
                <p className="text-xs text-muted-foreground">
                  Rendering happens in real time in your browser — keep this tab visible until it
                  reaches 100%.
                </p>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}