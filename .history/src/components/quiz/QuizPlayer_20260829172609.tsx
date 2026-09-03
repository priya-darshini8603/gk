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

  /*
   * IMPORTANT:
   * timeRef is the current timeline position.
   * It is NOT incremented by a capped dt anymore.
   */
  const timeRef = useRef(time);

  /*
   * Index of the next audio/SFX cue to fire.
   */
  const cueRef = useRef(0);

  /*
   * Current animation frame.
   */
  const rafRef = useRef<number | null>(null);

  /*
   * Random render key for one playback run.
   */
  const runKeyRef = useRef(Math.random());

  /*
   * Prevent duplicate onEnded calls.
   */
  const endedRef = useRef(false);

  const w =
    orientation === "landscape"
      ? 1920
      : 1080;

  const h =
    orientation === "landscape"
      ? 1080
      : 1920;

  /*
   * Draw one frame.
   */
  const paint = useCallback(
    (t: number) => {
      const canvas = canvasRef.current;

      if (!canvas) {
        return;
      }

      const ctx = canvas.getContext("2d");

      if (!ctx) {
        return;
      }

      drawFrame(
        ctx,
        quiz,
        getState(
          timeline,
          quiz,
          Math.max(0, Math.min(t, timeline.duration)),
        ),
        w,
        h,
        runKeyRef.current,
      );
    },
    [quiz, timeline, w, h],
  );

  /*
   * Handle external seeking while paused.
   */
  useEffect(() => {
    if (playing) {
      return;
    }

    const safeTime = Math.max(
      0,
      Math.min(time, timeline.duration),
    );

    timeRef.current = safeTime;

    const cues = buildCues(timeline);

    /*
     * Find first cue strictly after the current time.
     *
     * IMPORTANT:
     * findIndex() returns -1 if we are after the last cue.
     * In that case all cues are already consumed.
     */
    const nextCue = cues.findIndex(
      (cue) => cue.t > safeTime,
    );

    cueRef.current =
      nextCue === -1
        ? cues.length
        : nextCue;

    paint(safeTime);
  }, [
    time,
    playing,
    timeline,
    paint,
  ]);

  /*
   * PLAYBACK LOOP
   *
   * The old version did:
   *
   *   time += Math.min(dt, 0.06)
   *
   * That is wrong because a browser stall makes the timeline
   * permanently fall behind real time.
   *
   * We now calculate:
   *
   *   timelineTime =
   *     startingTimelineTime + realElapsedTime
   *
   * This makes playback recover automatically after a hiccup.
   */
  useEffect(() => {
    if (!playing) {
      return;
    }

    const cues = buildCues(timeline);

    /*
     * If playback starts from zero, create a new animation run.
     */
    if (timeRef.current <= 0.02) {
      timeRef.current = 0;
      cueRef.current = 0;
      runKeyRef.current = Math.random();
    } else {
      /*
       * Resume/continue from current position.
       */
      const nextCue = cues.findIndex(
        (cue) => cue.t > timeRef.current,
      );

      cueRef.current =
        nextCue === -1
          ? cues.length
          : nextCue;
    }

    endedRef.current = false;

    audio.apply(audioSettings);

    if (
      audioSettings.music &&
      !audioSettings.muted
    ) {
      audio.startMusic();
    }

    /*
     * Timeline position when this playback run starts.
     */
    const startTimelineTime =
      timeRef.current;

    /*
     * Real wall-clock start.
     */
    const startWallTime =
      performance.now();

    let stopped = false;

    const fireCuesUntil = (t: number) => {
      while (
        cueRef.current < cues.length &&
        cues[cueRef.current]!.t <= t
      ) {
        const cue =
          cues[cueRef.current]!;

        if (
          cue.kind === "sfx" &&
          cue.sfx
        ) {
          audio.sfx(cue.sfx);
        }

        if (
          cue.kind === "say" &&
          cue.text
        ) {
          /*
           * Preview narration is intentionally
           * fire-and-forget.
           */
          void audio.speak(
            cue.text,
            quiz.language,
            audioSettings,
          );
        }

        cueRef.current++;
      }
    };

    const loop = (now: number) => {
      if (stopped) {
        return;
      }

      /*
       * DO NOT cap elapsed time.
       *
       * If the browser pauses for 200ms,
       * the timeline moves forward by 200ms.
       */
      const elapsed =
        (now - startWallTime) / 1000;

      let t =
        startTimelineTime + elapsed;

      /*
       * End of timeline.
       */
      if (
        t >= timeline.duration
      ) {
        t = timeline.duration;

        timeRef.current = t;

        /*
         * Fire any final cues crossed by
         * the last frame.
         */
        fireCuesUntil(t);

        paint(t);
        onTime(t);

        audio.stopMusic();
        audio.stopSpeech();

        if (!endedRef.current) {
          endedRef.current = true;
          onEnded();
        }

        stopped = true;
        rafRef.current = null;

        return;
      }

      /*
       * Fire all cues crossed since the
       * previous rendered frame.
       *
       * This is important if a frame was missed.
       */
      fireCuesUntil(t);

      timeRef.current = t;

      /*
       * Always paint the newest state.
       */
      paint(t);

      /*
       * Update UI.
       *
       * React state updates can themselves be expensive,
       * so only update roughly 15 times/sec.
       */
      onTime(t);

      rafRef.current =
        requestAnimationFrame(loop);
    };

    rafRef.current =
      requestAnimationFrame(loop);

    return () => {
      stopped = true;

      if (
        rafRef.current !== null
      ) {
        cancelAnimationFrame(
          rafRef.current,
        );

        rafRef.current = null;
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
   * Initial / dependency-change paint.
   */
  useEffect(() => {
    if (!playing) {
      paint(timeRef.current);
    }
  }, [paint, playing]);

  return (
    <canvas
      ref={canvasRef}
      width={w}
      height={h}
      className="h-full w-full rounded-2xl bg-[#a5e3ff] object-contain"
    />
  );
}