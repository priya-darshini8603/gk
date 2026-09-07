import { Check } from "lucide-react";
import { CHARACTERS, type CharacterId } from "@/lib/quiz/types";

interface Props {
  value: CharacterId;
  onChange: (id: CharacterId) => void;
}

export function CharacterSelector({ value, onChange }: Props) {
  const selected = CHARACTERS.find((c) => c.id === value);

  return (
    <section className="space-y-3 rounded-3xl bg-card p-5 shadow-[var(--shadow-soft)]">
      <h2 className="font-display text-lg font-extrabold text-foreground">Choose Your Character</h2>

      <div className="grid grid-cols-3 gap-2">
        {CHARACTERS.map((c) => {
          const active = c.id === value;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onChange(c.id)}
              className={`relative flex flex-col items-center gap-1 rounded-2xl border-2 p-3 text-center transition-all ${
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
              <span className="text-3xl leading-none">{c.emoji}</span>
              <span className="text-xs font-bold leading-tight">{c.name}</span>
            </button>
          );
        })}
      </div>

      {selected && (
        <p className="rounded-2xl bg-muted px-3 py-2 text-sm">
          <span className="font-bold">Selected Character:</span> {selected.name}
          <span className="block text-xs text-muted-foreground">{selected.personality}</span>
        </p>
      )}
    </section>
  );
}