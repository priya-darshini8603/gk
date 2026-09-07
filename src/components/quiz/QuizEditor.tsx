import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  CATEGORIES,
  DIFFICULTIES,
  LANGUAGES,
  OPTION_KEYS,
  PRESETS,
  VOICE_STYLES,
  type AudioSettings,
  type Category,
  type CharacterId,
  type Difficulty,
  type Language,
  type OptionKey,
  type Quiz,
  type QuizTypeId,
  type VoiceStyle,
} from "@/lib/quiz/types";
import type { Issue } from "@/lib/quiz/validation";
import type { BackgroundId } from "@/lib/quiz/backgrounds";
import { BackgroundPicker } from "./BackgroundPicker";
import { CharacterSelector } from "./CharacterSelector";
import { QuizTypeSelector } from "./QuizTypeSelector";
import { AlertTriangle, CircleAlert, Music4, Sparkles } from "lucide-react";

interface Props {
  quiz: Quiz;
  onChange: (q: Quiz) => void;
  audio: AudioSettings;
  onAudioChange: (a: AudioSettings) => void;
  issues: Issue[];
}

const OPTION_TINT: Record<OptionKey, string> = {
  A: "bg-[#ff8fab]",
  B: "bg-[#4dd4ac]",
  C: "bg-[#ffc75f]",
  D: "bg-[#7aa2ff]",
};

export function QuizEditor({ quiz, onChange, audio, onAudioChange, issues }: Props) {
  const set = <K extends keyof Quiz>(key: K, value: Quiz[K]) => onChange({ ...quiz, [key]: value });
  const setOption = (key: OptionKey, value: string) =>
    onChange({ ...quiz, options: { ...quiz.options, [key]: value } });

  return (
    <div className="space-y-6">
      <CharacterSelector
        value={quiz.character}
        onChange={(id: CharacterId) => set("character", id)}
      />

      <QuizTypeSelector
        value={quiz.quizType}
        onChange={(id: QuizTypeId) => set("quizType", id)}
      />

      <section className="rounded-3xl bg-card p-5 shadow-[var(--shadow-soft)]">
        <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-extrabold text-foreground">
          <Sparkles className="size-5 text-primary" /> Quick presets
        </h2>
        <div className="grid grid-cols-2 gap-2">
          {PRESETS.map((p) => (
            <Button
              key={p.name}
              variant="preset"
              size="sm"
              onClick={() =>
                onChange({
                  ...p.quiz,
                  language: quiz.language,
                  timer: quiz.timer,
                  background: quiz.background,
                  character: quiz.character,
                  quizType: quiz.quizType,
                })
              }
            >
              <span className="text-base">{p.emoji}</span> {p.name}
            </Button>
          ))}
        </div>
      </section>

      <BackgroundPicker value={quiz.background} onChange={(id: BackgroundId) => set("background", id)} />

      <section className="space-y-4 rounded-3xl bg-card p-5 shadow-[var(--shadow-soft)]">
        <h2 className="font-display text-lg font-extrabold">Quiz editor</h2>
        <div className="space-y-2">
          <Label htmlFor="question">Question</Label>
          <Textarea
            id="question"
            value={quiz.question}
            rows={2}
            placeholder="Enter GK question"
            onChange={(e) => set("question", e.target.value)}
            className="rounded-2xl text-base"
          />
        </div>

        {OPTION_KEYS.map((key) => (
          <div key={key} className="space-y-2">
            <Label htmlFor={`opt-${key}`}>Option {key}</Label>
            <div className="flex items-center gap-2">
              <span
                className={`grid size-10 shrink-0 place-items-center rounded-2xl font-display text-lg font-extrabold text-white ${OPTION_TINT[key]}`}
              >
                {key}
              </span>
              <Input
                id={`opt-${key}`}
                value={quiz.options[key]}
                placeholder={`Answer ${key}`}
                onChange={(e) => setOption(key, e.target.value)}
                className="rounded-2xl text-base"
              />
            </div>
          </div>
        ))}

        <div className="space-y-2">
          <Label>Correct answer</Label>
          <div className="grid grid-cols-4 gap-2">
            {OPTION_KEYS.map((key) => (
              <Button
                key={key}
                variant={quiz.correct === key ? "fun" : "outline"}
                className="rounded-2xl font-display text-base"
                onClick={() => set("correct", key)}
              >
                {key}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Category</Label>
            <Select value={quiz.category} onValueChange={(v) => set("category", v as Category)}>
              <SelectTrigger className="rounded-2xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Difficulty</Label>
            <Select value={quiz.difficulty} onValueChange={(v) => set("difficulty", v as Difficulty)}>
              <SelectTrigger className="rounded-2xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIFFICULTIES.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Language</Label>
            <Select value={quiz.language} onValueChange={(v) => set("language", v as Language)}>
              <SelectTrigger className="rounded-2xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Timer</Label>
            <Select
              value={String(quiz.timer)}
              onValueChange={(v) => set("timer", Number(v) as Quiz["timer"])}
            >
              <SelectTrigger className="rounded-2xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[3, 5, 7, 10].map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {s} seconds
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-2xl bg-muted px-4 py-3">
          <Label htmlFor="expl" className="cursor-pointer">
            Show explanation
          </Label>
          <Switch
            id="expl"
            checked={quiz.showExplanation}
            onCheckedChange={(v) => set("showExplanation", v)}
          />
        </div>
        {quiz.showExplanation && (
          <Textarea
            value={quiz.explanation}
            rows={2}
            placeholder="That's right! Cows say moo!"
            onChange={(e) => set("explanation", e.target.value)}
            className="rounded-2xl"
          />
        )}

        <div className="flex items-center justify-between rounded-2xl bg-muted px-4 py-3">
          <Label htmlFor="show-board" className="cursor-pointer">
            Show board
          </Label>
          <Switch
            id="show-board"
            checked={quiz.showBoard}
            onCheckedChange={(v) => set("showBoard", v)}
          />
        </div>
      </section>

      <section className="space-y-4 rounded-3xl bg-card p-5 shadow-[var(--shadow-soft)]">
        <h2 className="flex items-center gap-2 font-display text-lg font-extrabold">
          <Music4 className="size-5 text-primary" /> Audio
        </h2>
        <div className="space-y-2">
          <Label>Narrator voice</Label>
          <Select value={audio.voice} onValueChange={(v) => onAudioChange({ ...audio, voice: v as VoiceStyle })}>
            <SelectTrigger className="rounded-2xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VOICE_STYLES.map((v) => (
                <SelectItem key={v} value={v}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {(
          [
            ["Voice", "voiceVolume"],
            ["Music", "musicVolume"],
            ["Sound effects", "sfxVolume"],
          ] as const
        ).map(([label, key]) => (
          <div key={key} className="space-y-2">
            <div className="flex justify-between text-sm">
              <Label>{label}</Label>
              <span className="text-muted-foreground">{Math.round(audio[key] * 100)}%</span>
            </div>
            <Slider
              value={[audio[key] * 100]}
              max={100}
              step={5}
              onValueChange={([v]) => onAudioChange({ ...audio, [key]: (v ?? 0) / 100 })}
            />
          </div>
        ))}
        <div className="flex items-center justify-between rounded-2xl bg-muted px-4 py-3">
          <Label htmlFor="music" className="cursor-pointer">
            Background music
          </Label>
          <Switch
            id="music"
            checked={audio.music}
            onCheckedChange={(v) => onAudioChange({ ...audio, music: v })}
          />
        </div>
      </section>

      {issues.length > 0 && (
        <section className="space-y-2 rounded-3xl bg-card p-5 shadow-[var(--shadow-soft)]">
          <h2 className="font-display text-lg font-extrabold">Checks</h2>
          {issues.map((i, idx) => (
            <p
              key={idx}
              className={`flex items-start gap-2 rounded-2xl px-3 py-2 text-sm ${
                i.level === "error"
                  ? "bg-destructive/10 text-destructive"
                  : "bg-accent/60 text-accent-foreground"
              }`}
            >
              {i.level === "error" ? (
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
              ) : (
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              )}
              {i.message}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}