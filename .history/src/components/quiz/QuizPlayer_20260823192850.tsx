import { useCallback, useEffect, useRef } from "react";
import { drawFrame } from "@/lib/quiz/renderer";
import { buildCues, getState, type Timeline } from "@/lib/quiz/timeline";
import type { AudioEngine } from "@/lib/quiz/audio";
import type { AudioSettings, Orientation, Quiz } from "@/lib/quiz/types";

interface Props {
  quiz: Quiz;
  timeline: Timeline;
  orientation: Orientation;
  playing: boolean;
  time: number;
  audio: AudioEngine;
  audioSettings: AudioSettings;
  onTime: (t: number) => void;
  onEnded: () => void;
}

export function QuizPlayer({
  quiz,
  timeline,
  orientation,
  playing,
  time,
  audio,
  audioSettings,
  onTime,
  onEnded,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timeRef = useRef(time);
  const cueRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const runKeyRef = useRef(Math.random());
  const lastPaintRef = useRef(0);
  const lastUiTimeRef = useRef(-Infinity);

  const w = orientation === "landscape" ? 1920 : 1080;
  const h = orientation === "landscape" ? 1080 : 1920;

  const paint = useCallback(
    (t: number) => {
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return;
      drawFrame(
        ctx,
        quiz,
        getState(timeline, quiz, t),
        w,
        h,
        runKeyRef.current,
      );
    },
    [quiz, timeline, w, h],
  );

  // seek from outside
  useEffect(() => {
    if (!playing) {
      timeRef.current = time;
      cueRef.current = buildCues(timeline).findIndex((c) => c.t > time);
      paint(time);
    }
  }, [time, playing, paint, timeline]);

  useEffect(() => {
    if (!playing) return;
    const cues = buildCues(timeline);
    if (timeRef.current <= 0.02) {
      cueRef.current = 0;
      runKeyRef.current = Math.random();
    }
    audio.apply(audioSettings);
    if (audioSettings.music && !audioSettings.muted) audio.startMusic();
    let last = performance.now();
    lastPaintRef.current = 0;
    lastUiTimeRef.current = -Infinity;
    const loop = (now: number) => {
      const dt = Math.min(0.06, (now - last) / 1000);
      last = now;
      let t = timeRef.current + dt;
      if (t >= timeline.duration) {
        t = timeline.duration;
        timeRef.current = t;
        paint(t);
        onTime(t);
        audio.stopMusic();
        audio.stopSpeech();
        onEnded();
        return;
      }
      while (cueRef.current < cues.length && cues[cueRef.current]!.t <= t) {
        const cue = cues[cueRef.current]!;
        if (cue.kind === "sfx" && cue.sfx) audio.sfx(cue.sfx);
        if (cue.kind === "say" && cue.text) audio.speak(cue.text, quiz.language, audioSettings);
        cueRef.current++;
      }
      timeRef.current = t;
      if (now - lastPaintRef.current >= 1000 / 30) {
        lastPaintRef.current = now;
        paint(t);
        if (now - lastUiTimeRef.current >= 1000 / 15) {
          lastUiTimeRef.current = now;
          onTime(t);
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      audio.stopMusic();
      audio.stopSpeech();
    };
  }, [playing, timeline, quiz, audio, audioSettings, paint, onTime, onEnded]);

  useEffect(() => {
    paint(timeRef.current);
  }, [paint]);

  return (
    <canvas
      ref={canvasRef}
      width={w}
      height={h}
      className="h-full w-full rounded-2xl bg-[#a5e3ff] object-contain"
    />
  );
}
