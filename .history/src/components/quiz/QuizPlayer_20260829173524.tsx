import { useCallback, useEffect, useRef } from "react";
import { drawFrame } from "@/lib/quiz/renderer";
import {
  buildCues,
  getState,
  type Timeline,
} from "@/lib/quiz/timeline";
import type { AudioEngine } from "@/lib/quiz/audio";
import type {
  AudioSettings,
  Orientation,
  Quiz,
} from "@/lib/quiz/types";

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
  const canvasRef =
    useRef<HTMLCanvasElement>(null);

  const timeRef =
    useRef(time);

  const rafRef =
    useRef<number | null>(null);

  const cueRef =
    useRef(0);

  const runKeyRef =
    useRef(Math.random());

  const endedRef =
    useRef(false);

  const lastUiUpdateRef =
    useRef(0);

  const w =
    orientation === "landscape"
      ? 1920
      : 1080;

  const h =
    orientation === "landscape"
      ? 1080
      : 1920;

  /*
   * Draw a single timeline frame.
   */
  const paint = useCallback(
    (t: number) => {
      const canvas =
        canvasRef.current;

      if (!canvas) return;

      const ctx =
        canvas.getContext("2d");

      if (!ctx) return;

      const safeTime =
        Math.max(
          0,
          Math.min(
            t,
            timeline.duration,
          ),
        );

      drawFrame(
        ctx,
        quiz,
        getState(
          timeline,
          quiz,
          safeTime,
        ),
        w,
        h,
        runKeyRef.current,
      );
    },
    [
      quiz,
      timeline,
      w,
      h,
    ],
  );

  /*
   * Set cue pointer correctly after seeking.
   */
  const syncCuePointer =
    useCallback(
      (t: number) => {
        const cues =
          buildCues(timeline);

        const index =
          cues.findIndex(
            (cue) =>
              cue.t > t,
          );

        cueRef.current =
          index === -1
            ? cues.length
            : index;
      },
      [timeline],
    );

  /*
   * PAUSED / SEEKED
   */
  useEffect(() => {
    if (playing) return;

    const safeTime =
      Math.max(
        0,
        Math.min(
          time,
          timeline.duration,
        ),
      );

    timeRef.current =
      safeTime;

    syncCuePointer(
      safeTime,
    );

    paint(
      safeTime,
    );
  }, [
    playing,
    time,
    timeline.duration,
    paint,
    syncCuePointer,
  ]);

  /*
   * PLAYBACK
   *
   * Timeline position is based on wall-clock
   * elapsed time, NOT accumulated/capped dt.
   */
  useEffect(() => {
    if (!playing) return;

    const cues =
      buildCues(timeline);

    const startingTime =
      Math.max(
        0,
        Math.min(
          timeRef.current,
          timeline.duration,
        ),
      );

    /*
     * New playback run.
     */
    if (
      startingTime <=
      0.02
    ) {
      timeRef.current = 0;
      cueRef.current = 0;
      runKeyRef.current =
        Math.random();
    } else {
      /*
       * Resume from current position.
       */
      const next =
        cues.findIndex(
          (cue) =>
            cue.t >
            startingTime,
        );

      cueRef.current =
        next === -1
          ? cues.length
          : next;
    }

    endedRef.current =
      false;

    audio.apply(
      audioSettings,
    );

    if (
      audioSettings.music &&
      !audioSettings.muted
    ) {
      audio.startMusic();
    }

    const wallStart =
      performance.now();

    const timelineStart =
      startingTime;

    let stopped = false;

    const fireCues =
      (currentTime: number) => {
        while (
          cueRef.current <
            cues.length &&
          cues[
            cueRef.current
          ]!.t <= currentTime
        ) {
          const cue =
            cues[
              cueRef.current
            ]!;

          if (
            cue.kind ===
              "sfx" &&
            cue.sfx
          ) {
            audio.sfx(
              cue.sfx,
            );
          }

          if (
            cue.kind ===
              "say" &&
            cue.text
          ) {
            void audio.speak(
              cue.text,
              quiz.language,
              audioSettings,
            );
          }

          cueRef.current++;
        }
      };

    const loop =
      (now: number) => {
        if (stopped) {
          return;
        }

        /*
         * REAL elapsed time.
         *
         * No 60ms cap.
         */
        const elapsed =
          (now -
            wallStart) /
          1000;

        let currentTime =
          timelineStart +
          elapsed;

        if (
          currentTime >=
          timeline.duration
        ) {
          currentTime =
            timeline.duration;

          fireCues(
            currentTime,
          );

          timeRef.current =
            currentTime;

          paint(
            currentTime,
          );

          onTime(
            currentTime,
          );

          audio.stopMusic();
          audio.stopSpeech();

          if (
            !endedRef.current
          ) {
            endedRef.current =
              true;

            onEnded();
          }

          stopped = true;
          rafRef.current =
            null;

          return;
        }

        fireCues(
          currentTime,
        );

        timeRef.current =
          currentTime;

        paint(
          currentTime,
        );

        /*
         * Don't make React re-render unnecessarily
         * on every animation frame.
         */
        if (
          now -
            lastUiUpdateRef.current >=
          1000 / 15
        ) {
          lastUiUpdateRef.current =
            now;

          onTime(
            currentTime,
          );
        }

        rafRef.current =
          requestAnimationFrame(
            loop,
          );
      };

    lastUiUpdateRef.current =
      performance.now();

    rafRef.current =
      requestAnimationFrame(
        loop,
      );

    return () => {
      stopped = true;

      if (
        rafRef.current !==
        null
      ) {
        cancelAnimationFrame(
          rafRef.current,
        );

        rafRef.current =
          null;
      }

      audio.stopMusic();
      audio.stopSpeech();
    };
  }, [
    playing,
    timeline,
    quiz,
    audio,
    audioSettings,
    paint,
    onTime,
    onEnded,
  ]);

  /*
   * Initial render.
   */
  useEffect(() => {
    if (!playing) {
      paint(
        timeRef.current,
      );
    }
  }, [
    paint,
    playing,
  ]);

  return (
    <canvas
      ref={canvasRef}
      width={w}
      height={h}
      className="h-full w-full rounded-2xl bg-[#a5e3ff] object-contain"
    />
  );
}