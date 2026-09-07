import { Check } from "lucide-react";
import { QUIZ_TYPES, type QuizTypeId } from "@/lib/quiz/types";

interface Props {
  value: QuizTypeId;
  onChange: (id: QuizTypeId) => void;
}

export function QuizTypeSelector({ value, onChange }: Props) {
  const selected = QUIZ_TYPES.find((q) => q.id === value);

  return (
    <section className="space-y-3 rounded-3xl bg-card p-5 shadow-[var(--shadow-soft)]">
      <h2 className="font-display text-lg font-extrabold text-foreground">Choose Quiz Type</h2>

      <div className="grid grid-cols-2 gap-2">
        {QUIZ_TYPES.map((q) => {
          const active = q.id === value;
          return (
            <button
              key={q.id}
              type="button"
              onClick={() => onChange(q.id)}
              className={`relative flex items-center gap-2 rounded-2xl border-2 px-3 py-2.5 text-left transition-all ${
                active
                  ? "border-primary bg-primary/10 shadow-[var(--shadow-pop)]"
                  : "border-transparent bg-muted hover:border-border"
              }`}
            >
              {active && (
                <span className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground">
                  <Check className="size-3.5" />
                </span>
              )}
              <span className="text-xl leading-none">{q.emoji}</span>
              <span className="text-sm font-bold leading-tight">{q.name}</span>
            </button>
          );
        })}
      </div>

      {selected && (
        <p className="rounded-2xl bg-muted px-3 py-2 text-sm">
          <span className="font-bold">Heading on video:</span> "{selected.heading}"
        </p>
      )}
    </section>
  );
}