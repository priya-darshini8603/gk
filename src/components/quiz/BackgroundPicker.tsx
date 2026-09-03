import { useEffect, useRef } from "react";
import { Check, Images } from "lucide-react";
import { SCENES, type BackgroundId, type Scene } from "@/lib/quiz/backgrounds";

function Thumb({ scene, selected, onSelect }: { scene: Scene; selected: boolean; onSelect: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const start = performance.now();
    const loop = (now: number) => {
      ctx.clearRect(0, 0, 320, 180);
      scene.draw(ctx, 320, 180, (now - start) / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [scene]);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`Use ${scene.name} background`}
      className={`group relative overflow-hidden rounded-2xl border-2 transition-transform hover:-translate-y-0.5 ${
        selected ? "border-primary shadow-[var(--shadow-pop)]" : "border-transparent shadow-[var(--shadow-soft)]"
      }`}
    >
      <canvas ref={ref} width={320} height={180} className="block aspect-video w-full" />
      <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-foreground/60 px-2 py-1 text-left text-[11px] font-bold leading-tight text-background">
        <span>{scene.emoji}</span>
        <span className="truncate">{scene.name}</span>
      </span>
      {selected && (
        <span className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-3.5" />
        </span>
      )}
    </button>
  );
}

interface Props {
  value: BackgroundId;
  onChange: (id: BackgroundId) => void;
}

export function BackgroundPicker({ value, onChange }: Props) {
  return (
    <section className="space-y-3 rounded-3xl bg-card p-5 shadow-[var(--shadow-soft)]">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-display text-lg font-extrabold">
          <Images className="size-5 text-primary" /> Backgrounds
        </h2>
        <span className="text-xs text-muted-foreground">{SCENES.length} scenes</span>
      </div>
      <p className="text-sm text-muted-foreground">
        Tap a scene to change the video world instantly. Lighting on the owl adapts automatically.
      </p>
      <div className="grid max-h-[340px] grid-cols-2 gap-2 overflow-y-auto pr-1">
        {SCENES.map((s) => (
          <Thumb key={s.id} scene={s} selected={s.id === value} onSelect={() => onChange(s.id)} />
        ))}
      </div>
    </section>
  );
}
