import { DEFAULT_BACKGROUND, type BackgroundId } from "./backgrounds";

export type OptionKey = "A" | "B" | "C" | "D";

export const OPTION_KEYS: OptionKey[] = ["A", "B", "C", "D"];

export type Category =
  | "Animals"
  | "Science"
  | "Space"
  | "Nature"
  | "Geography"
  | "General Knowledge"
  | "Colors"
  | "Numbers"
  | "Vehicles"
  | "Food"
  | "Other";

export const CATEGORIES: Category[] = [
  "Animals",
  "Science",
  "Space",
  "Nature",
  "Geography",
  "General Knowledge",
  "Colors",
  "Numbers",
  "Vehicles",
  "Food",
  "Other",
];

export type Difficulty = "Easy" | "Medium" | "Hard";
export const DIFFICULTIES: Difficulty[] = ["Easy", "Medium", "Hard"];

export type Language = "English" | "Tamil" | "Hindi" | "Kannada" | "Telugu" | "Malayalam";
export const LANGUAGES: Language[] = [
  "English",
  "Tamil",
  "Hindi",
  "Kannada",
  "Telugu",
  "Malayalam",
];

export const LANGUAGE_LOCALES: Record<Language, string> = {
  English: "en-US",
  Tamil: "ta-IN",
  Hindi: "hi-IN",
  Kannada: "kn-IN",
  Telugu: "te-IN",
  Malayalam: "ml-IN",
};

export type VoiceStyle = "Cute Child" | "Friendly Female" | "Friendly Male" | "Teacher";
export const VOICE_STYLES: VoiceStyle[] = [
  "Cute Child",
  "Friendly Female",
  "Friendly Male",
  "Teacher",
];

export const VOICE_TUNING: Record<VoiceStyle, { pitch: number; rate: number }> = {
  "Cute Child": { pitch: 1.8, rate: 1.02 },
  "Friendly Female": { pitch: 1.25, rate: 0.98 },
  "Friendly Male": { pitch: 0.8, rate: 0.95 },
  Teacher: { pitch: 1.05, rate: 0.88 },
};

export type Orientation = "landscape" | "portrait";

export interface Quiz {
  question: string;
  options: Record<OptionKey, string>;
  correct: OptionKey;
  category: Category;
  difficulty: Difficulty;
  language: Language;
  timer: 3 | 5 | 7 | 10;
  showExplanation: boolean;
  explanation: string;
  background: BackgroundId;
}

export interface AudioSettings {
  voice: VoiceStyle;
  voiceVolume: number;
  musicVolume: number;
  sfxVolume: number;
  music: boolean;
  muted: boolean;
}

export const DEFAULT_QUIZ: Quiz = {
  question: "Which planet is known as the Red Planet?",
  options: { A: "Earth", B: "Mars", C: "Jupiter", D: "Venus" },
  correct: "B",
  category: "Space",
  difficulty: "Easy",
  language: "English",
  timer: 5,
  showExplanation: true,
  explanation: "Mars looks red because its soil is full of rusty iron dust!",
  background: DEFAULT_BACKGROUND,
};

export interface Preset {
  emoji: string;
  name: string;
  quiz: Quiz;
}

const base = (q: Partial<Quiz>): Quiz => ({ ...DEFAULT_QUIZ, ...q } as Quiz);

export const PRESETS: Preset[] = [
  {
    emoji: "🐾",
    name: "Animal Quiz",
    quiz: base({
      question: 'Which animal says "Moo"?',
      options: { A: "Dog", B: "Cow", C: "Cat", D: "Lion" },
      correct: "B",
      category: "Animals",
      explanation: "That's right! Cows say moo!",
    }),
  },
  {
    emoji: "🚀",
    name: "Space Quiz",
    quiz: base({
      question: "Which planet is known as the Red Planet?",
      options: { A: "Earth", B: "Mars", C: "Jupiter", D: "Venus" },
      correct: "B",
      category: "Space",
      explanation: "Mars is red because of rusty iron dust!",
    }),
  },
  {
    emoji: "🦖",
    name: "Dinosaur Quiz",
    quiz: base({
      question: "Which dinosaur had three horns?",
      options: { A: "T-Rex", B: "Stegosaurus", C: "Triceratops", D: "Raptor" },
      correct: "C",
      category: "Science",
      explanation: "Triceratops means three-horned face!",
    }),
  },
  {
    emoji: "🌈",
    name: "Colors Quiz",
    quiz: base({
      question: "What color do you get mixing blue and yellow?",
      options: { A: "Green", B: "Purple", C: "Orange", D: "Pink" },
      correct: "A",
      category: "Colors",
      explanation: "Blue and yellow make lovely green!",
    }),
  },
  {
    emoji: "🌱",
    name: "Nature Quiz",
    quiz: base({
      question: "What do plants need to make their food?",
      options: { A: "Moonlight", B: "Sunlight", C: "Sand", D: "Ice" },
      correct: "B",
      category: "Nature",
      explanation: "Plants use sunlight to make food. That's photosynthesis!",
    }),
  },
  {
    emoji: "🧠",
    name: "Brain Quiz",
    quiz: base({
      question: "How many sides does a triangle have?",
      options: { A: "Two", B: "Three", C: "Four", D: "Five" },
      correct: "B",
      category: "Numbers",
      explanation: "Tri means three, so a triangle has three sides!",
    }),
  },
  {
    emoji: "🚗",
    name: "Vehicle Quiz",
    quiz: base({
      question: "Which vehicle flies in the sky?",
      options: { A: "Bus", B: "Boat", C: "Aeroplane", D: "Train" },
      correct: "C",
      category: "Vehicles",
      explanation: "Aeroplanes have wings so they can fly!",
    }),
  },
  {
    emoji: "🍎",
    name: "Food Quiz",
    quiz: base({
      question: "Which fruit is yellow and curved?",
      options: { A: "Apple", B: "Banana", C: "Grape", D: "Plum" },
      correct: "B",
      category: "Food",
      explanation: "Bananas are yellow and curved like a smile!",
    }),
  },
];
