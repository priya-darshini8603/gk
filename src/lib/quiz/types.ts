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

// === UPDATE in lib/quiz/types.ts ===

export type CharacterId =
  | "owl"
  | "penguin"
  | "panda"
  | "monkey"
  | "bear"
  | "bunny"
  | "brain"
  | "egg"
  | "bulb";

export const CHARACTERS: CharacterMeta[] = [
  { id: "owl", name: "Owl", emoji: "🦉", personality: "Smart, curious & teacher-like" },
  { id: "penguin", name: "Penguin", emoji: "🐧", personality: "Funny, playful & energetic" },
  { id: "panda", name: "Panda", emoji: "🐼", personality: "Cute, calm & friendly" },
  { id: "monkey", name: "Baby Monkey", emoji: "🐵", personality: "Mischievous & highly energetic" },
  { id: "bear", name: "Baby Bear", emoji: "🐻", personality: "Warm, cheerful & adorable" },
  { id: "bunny", name: "Baby Bunny", emoji: "🐰", personality: "Sweet, curious & playful" },
  { id: "brain", name: "Brain", emoji: "🧠", personality: "Bright, playful & endlessly curious" },
  { id: "egg", name: "Rounded Egg", emoji: "🥚", personality: "Sweet, gentle & a little wobbly" },
  { id: "bulb", name: "Bright Bulb", emoji: "💡", personality: "Bright, cheerful & full of bright ideas" },
];

export interface CharacterMeta {
  id: CharacterId;
  name: string;
  emoji: string;
  personality: string;
}


export type QuizTypeId = "gk" | "grammar" | "riddles" | "interview" | "aptitude";

export interface QuizTypeMeta {
  id: QuizTypeId;
  name: string;
  emoji: string;
  heading: string;
}

export const QUIZ_TYPES: QuizTypeMeta[] = [
  { id: "gk", name: "GK Quiz", emoji: "🧠", heading: "GK QUIZ" },
  { id: "grammar", name: "Grammar Quiz", emoji: "📝", heading: "GRAMMAR QUIZ" },
  { id: "riddles", name: "Riddles Quiz", emoji: "🧩", heading: "RIDDLES QUIZ" },
  { id: "interview", name: "Interview Quiz", emoji: "🎤", heading: "INTERVIEW QUIZ" },
  { id: "aptitude", name: "Aptitude Math Quiz", emoji: "🧮", heading: "APTITUDE MATH QUIZ" },
];

// Inside your existing `Quiz` interface, add:
//   character: CharacterId;
//   quizType: QuizTypeId;

// Inside your existing `DEFAULT_QUIZ` object, add:
//   character: "owl",
//   quizType: "gk",
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
  character: CharacterId;
  quizType: QuizTypeId;
  category: Category;
  difficulty: Difficulty;
  language: Language;
  timer: 3 | 5 | 7 | 10;
  showExplanation: boolean;
  explanation: string;
  showBoard: boolean;
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
  character: "owl",
  quizType: "gk",
  category: "Space",
  difficulty: "Easy",
  language: "English",
  timer: 5,
  showExplanation: true,
  explanation: "Mars looks red because its soil is full of rusty iron dust!",
  showBoard: true,
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
