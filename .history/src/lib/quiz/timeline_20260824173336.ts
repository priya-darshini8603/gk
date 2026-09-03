import { OPTION_KEYS, type OptionKey, type Quiz } from "./types";

/* ---------------------------------------------------------------------------
 * Timeline / state-machine engine.
 * A quiz is compiled into a list of beats. Any time `t` can be resolved into a
 * full render state, so the interactive preview and the video renderer share
 * exactly the same source of truth.
 * ------------------------------------------------------------------------- */

export type OwlPose =
  | "walk"
  | "wave"
  | "idle"
  | "point-board"
  | "point-option"
  | "think"
  | "confident"
  | "unsure"
  | "nervous"
  | "shocked"
  | "celebrate"
  | "clap";

export type Reaction =
  | "confident"
  | "thinking"
  | "curious"
  | "confused"
  | "nervous"
  | "surprised"
  | "excited"
  | "sleepy"
  | "detective"
  | "overconfident"
  | "panic"
  | "shy";

export const NARRATION_REACTIONS: Reaction[] = [
  "curious",
  "thinking",
  "excited",
  "detective",
  "overconfident",
  "shy",
  "confident",
  "surprised",
];

export type BeatKind =
  | "enter"
  | "intro"
  | "question-in"
  | "read-question"
  | "options-in"
  | "read-option"
  | "countdown"
  | "reveal"
  | "celebrate"
  | "explanation"
  | "endcard";

export interface Beat {
  kind: BeatKind;
  start: number;
  dur: number;
  say?: string;
  option?: OptionKey;
  reaction?: Reaction;
  scene: number;
  label: string;
}

export interface Timeline {
  beats: Beat[];
  duration: number;
  seed: number;
}

function mulberry(seed: number) {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;

    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const speakTime = (text: string) =>
  Math.max(
    1.4,
    Math.min(7, text.split(/\s+/).length * 0.42 + 0.9),
  );

/**
 * Build the timeline for one quiz video.
 *
 * isFirstQuestion:
 *   true  -> Owl entrance + intro + question
 *   false -> Start directly with question
 *
 * This is important for CSV batch generation:
 * Question 1 gets the full introduction.
 * Question 2+ starts directly with the question.
 */
export function buildTimeline(
  quiz: Quiz,
  seed = Date.now(),
  isFirstQuestion = true,
): Timeline {
  const rnd = mulberry(seed);

  const pick = <T,>(arr: T[]): T =>
    arr[Math.floor(rnd() * arr.length)]!;

  const beats: Beat[] = [];
  let t = 0;

  const push = (b: Omit<Beat, "start">) => {
    beats.push({
      ...b,
      start: t,
    });

    t += b.dur;
  };

  /*
   * ------------------------------------------------------------
   * FIRST QUESTION ONLY
   * Owl enters + Intro
   * ------------------------------------------------------------
   */
  if (isFirstQuestion) {
    push({
      kind: "enter",
      dur: 1.8,
      scene: 1,
      label: "Owl enters",
    });

    const intro = pick([
      "Hello friends! Ready for a fun question?",
      "Hello friendsLet's play a quiz game together!",
    ]);

    push({
      kind: "intro",
      dur: speakTime(intro),
      say: intro,
      scene: 2,
      label: "Intro",
      reaction: "excited",
    });
  }

  /*
   * ------------------------------------------------------------
   * QUESTION
   *
   * For Question 1:
   *   Owl enters -> Intro -> Question appears
   *
   * For Question 2+:
   *   Question appears immediately
   * ------------------------------------------------------------
   */
  push({
    kind: "question-in",
    dur: 1.1,
    scene: isFirstQuestion ? 3 : 1,
    label: "Question appears",
  });

  push({
    kind: "read-question",
    dur: speakTime(quiz.question),
    say: quiz.question,
    scene: isFirstQuestion ? 4 : 2,
    label: "Owl reads the question",
    reaction: pick(NARRATION_REACTIONS),
  });

  /*
   * ------------------------------------------------------------
   * OPTIONS
   * ------------------------------------------------------------
   */
  push({
    kind: "options-in",
    dur: 1.1,
    scene: isFirstQuestion ? 5 : 3,
    label: "Options appear",
  });

  for (const key of OPTION_KEYS) {
    const text = `${key}. ${quiz.options[key]}`;

    push({
      kind: "read-option",
      dur: Math.max(1.5, speakTime(text) * 0.8),
      say: text,
      option: key,
      scene: isFirstQuestion ? 6 : 4,
      label: `Reads option ${key}`,
      reaction: pick(NARRATION_REACTIONS),
    });
  }

  /*
   * ------------------------------------------------------------
   * COUNTDOWN
   * ------------------------------------------------------------
   */
  push({
    kind: "countdown",
    dur: quiz.timer,
    scene: isFirstQuestion ? 7 : 5,
    label: `${quiz.timer}s countdown`,
  });

  /*
   * ------------------------------------------------------------
   * ANSWER REVEAL
   * ------------------------------------------------------------
   */
  push({
    kind: "reveal",
    dur: 2.2,
    say: `Yay! It's ${quiz.options[quiz.correct]}!`,
    scene: isFirstQuestion ? 9 : 7,
    label: "Answer reveal",
  });

  /*
   * ------------------------------------------------------------
   * CELEBRATION
   * ------------------------------------------------------------
   */
  push({
    kind: "celebrate",
    dur: 2.6,
    scene: isFirstQuestion ? 10 : 8,
    label: "Celebration",
  });

  /*
   * ------------------------------------------------------------
   * EXPLANATION
   * ------------------------------------------------------------
   */
  if (quiz.showExplanation && quiz.explanation.trim()) {
    push({
      kind: "explanation",
      dur: speakTime(quiz.explanation),
      say: quiz.explanation,
      scene: isFirstQuestion ? 11 : 9,
      label: "Explanation",
    });
  }

  /*
   * ------------------------------------------------------------
   * END CARD
   * ------------------------------------------------------------
   */
  push({
    kind: "endcard",
    dur: 2.2,
    say: "Can you get the next one?",
    scene: isFirstQuestion ? 12 : 10,
    label: "End card",
  });

  return {
    beats,
    duration: t,
    seed,
  };
}

/* ------------------------------- state ---------------------------------- */

export interface RenderState {
  t: number;
  boardIn: number;
  questionIn: number;
  optionsIn: [number, number, number, number];
  highlight: OptionKey | null;
  countdown: number | null;
  countdownPulse: number;
  reveal: number;
  celebrate: number;
  endCard: number;
  cameraZoom: number;
  caption: string;
  speaking: number;
  reaction: Reaction | null;
  owlX: number;
  owlEnter: number;
  pose: OwlPose;
  lookAt: OptionKey | "board" | "viewer" | "up";
  sweat: number;
  shake: number;
  beat: Beat | null;
}

const clamp01 = (v: number) =>
  v < 0 ? 0 : v > 1 ? 1 : v;

const easeOut = (v: number) =>
  1 - Math.pow(1 - clamp01(v), 3);

export function getState(
  tl: Timeline,
  quiz: Quiz,
  t: number,
): RenderState {
  const beat =
    tl.beats.find(
      (b) => t >= b.start && t < b.start + b.dur,
    ) ??
    tl.beats[tl.beats.length - 1] ??
    null;

  const local = beat ? t - beat.start : 0;

  const p = beat
    ? clamp01(local / beat.dur)
    : 1;

  const after = (kind: BeatKind) => {
    const b = tl.beats.find((x) => x.kind === kind);

    return b
      ? clamp01((t - b.start) / b.dur)
      : 0;
  };

  const optionBeats = tl.beats.filter(
    (b) => b.kind === "read-option",
  );

  const optionsInBeat = tl.beats.find(
    (b) => b.kind === "options-in",
  )!;

  const optionsIn = OPTION_KEYS.map((_, i) =>
    easeOut(
      (t - (optionsInBeat.start + i * 0.22)) / 0.55,
    ),
  ) as [number, number, number, number];

  const state: RenderState = {
    t,

    boardIn: easeOut((t - 0.35) / 1.2),

    questionIn: easeOut(
      after("question-in") * 1.4,
    ),

    optionsIn,

    highlight: null,

    countdown: null,

    countdownPulse: 0,

    reveal: 0,

    celebrate: 0,

    endCard: 0,

    cameraZoom: 1,

    caption: beat?.say ?? "",

    speaking: 0,

    reaction: beat?.reaction ?? null,

    owlX: 0,

    owlEnter: easeOut(t / 1.5),

    pose: "idle",

    lookAt: "viewer",

    sweat: 0,

    shake: 0,

    beat,
  };

  switch (beat?.kind) {
    case "enter":
      state.pose =
        p < 0.68
          ? "walk"
          : "wave";

      state.owlX =
        -1.1 +
        easeOut(p / 0.68) * 1.1;

      state.lookAt = "viewer";
      break;

    case "intro":
      state.pose = "idle";
      state.speaking = 1;
      state.lookAt = "viewer";
      break;

    case "question-in":
      state.pose = "point-board";
      state.lookAt = "board";
      break;

    case "read-question":
      state.pose =
        p < 0.35
          ? "point-board"
          : beat.reaction === "thinking"
            ? "think"
            : "idle";

      state.speaking = 1;

      state.lookAt =
        p < 0.6
          ? "board"
          : "viewer";

      break;

    case "options-in":
      state.pose = "idle";
      state.lookAt = "board";
      break;

    case "read-option": {
      const idx = optionBeats.indexOf(beat);

      state.pose = "point-option";

      state.speaking = 1;

      state.highlight =
        beat.option ?? null;

      state.lookAt =
        beat.option ?? "board";

      state.owlX =
        -0.12 +
        (idx % 2) * 0.16;

      break;
    }

    case "countdown": {
      const remain =
        beat.dur - local;

      const n = Math.ceil(remain);

      state.countdown = n;

      state.countdownPulse =
        1 -
        (remain -
          Math.floor(remain));

      const phase =
        remain / beat.dur;

      if (phase > 0.8) {
        state.pose = "confident";
        state.lookAt = "board";
      } else if (phase > 0.6) {
        state.pose = "think";
        state.lookAt = "up";
      } else if (phase > 0.4) {
        state.pose = "unsure";

        state.lookAt =
          OPTION_KEYS[
            Math.floor(t * 3) % 4
          ]!;
      } else if (phase > 0.2) {
        state.pose = "nervous";

        state.sweat = 0.6;

        state.shake = 0.5;

        state.lookAt =
          OPTION_KEYS[
            Math.floor(t * 6) % 4
          ]!;
      } else {
        state.pose = "shocked";

        state.sweat = 1;

        state.shake = 0.9;

        state.cameraZoom =
          1 +
          (1 - phase / 0.2) * 0.08;

        state.lookAt = "viewer";
      }

      break;
    }

    case "reveal":
      state.reveal = easeOut(
        Math.max(
          0,
          (local - 0.25) / 0.7,
        ),
      );

      state.pose =
        local < 0.3
          ? "shocked"
          : "celebrate";

      state.speaking =
        local > 0.4 ? 1 : 0;

      state.lookAt = quiz.correct;

      state.highlight = quiz.correct;

      break;

    case "celebrate":
      state.reveal = 1;

      state.celebrate = 1;

      state.pose =
        p < 0.5
          ? "celebrate"
          : "clap";

      state.highlight = quiz.correct;

      state.lookAt = "viewer";

      break;

    case "explanation":
      state.reveal = 1;

      state.celebrate = 0.35;

      state.pose = "point-option";

      state.speaking = 1;

      state.highlight = quiz.correct;

      state.lookAt = quiz.correct;

      break;

    case "endcard":
      state.reveal = 1;

      state.endCard = easeOut(
        p * 2,
      );

      state.pose = "wave";

      state.speaking =
        p < 0.6 ? 1 : 0;

      state.lookAt = "viewer";

      break;
  }

  if (
    beat &&
    beat.kind !== "enter"
  ) {
    state.owlEnter = 1;
  }

  return state;
}

export interface Cue {
  t: number;
  kind: "say" | "sfx";
  text?: string;
  sfx?:
    | "board"
    | "pop"
    | "point"
    | "tick"
    | "final"
    | "correct"
    | "confetti"
    | "cheer";
}

export function buildCues(
  tl: Timeline,
): Cue[] {
  const cues: Cue[] = [];

  for (const b of tl.beats) {
    if (b.say) {
      cues.push({
        t: b.start + 0.12,
        kind: "say",
        text: b.say,
      });
    }

    if (b.kind === "question-in") {
      cues.push({
        t: b.start,
        kind: "sfx",
        sfx: "board",
      });
    }

    if (b.kind === "options-in") {
      [0, 0.22, 0.44, 0.66].forEach(
        (d) =>
          cues.push({
            t: b.start + d,
            kind: "sfx",
            sfx: "pop",
          }),
      );
    }

    if (b.kind === "read-option") {
      cues.push({
        t: b.start,
        kind: "sfx",
        sfx: "point",
      });
    }

    if (b.kind === "countdown") {
      for (
        let i = 0;
        i < b.dur;
        i++
      ) {
        const last =
          i === b.dur - 1;

        cues.push({
          t: b.start + i,
          kind: "sfx",
          sfx: last
            ? "final"
            : "tick",
        });
      }
    }

    if (b.kind === "reveal") {
      cues.push({
        t: b.start + 0.25,
        kind: "sfx",
        sfx: "correct",
      });

      cues.push({
        t: b.start + 0.45,
        kind: "sfx",
        sfx: "confetti",
      });
    }

    if (b.kind === "celebrate") {
      cues.push({
        t: b.start,
        kind: "sfx",
        sfx: "cheer",
      });
    }
  }

  return cues.sort(
    (a, b) => a.t - b.t,
  );
}