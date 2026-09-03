/**
 * Kid-friendly animated scene backgrounds.
 * Every scene is procedurally painted on canvas so it works identically in the
 * live preview and in the 1080p video export.
 */

const TAU = Math.PI * 2;

export type BackgroundId =
  | "forest"
  | "rainbow"
  | "space"
  | "underwater"
  | "dinosaur"
  | "castle"
  | "garden"
  | "clouds"
  | "classroom"
  | "lab"
  | "winter"
  | "island"
  | "volcano"
  | "night"
  | "carnival"
  | "ocean";

export interface SceneLight {
  /** colour washed over the owl so it belongs to the scene */
  tint: string;
  tintAlpha: number;
  /** rim / key light glow behind the owl */
  rim: string;
  rimAlpha: number;
}

export interface Scene {
  id: BackgroundId;
  name: string;
  emoji: string;
  /** true when the board needs an extra contrast scrim */
  dark: boolean;
  light: SceneLight;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void;
}

/* ------------------------------ primitives ------------------------------ */

function sky(ctx: CanvasRenderingContext2D, w: number, h: number, stops: [number, string][]) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  stops.forEach(([p, c]) => g.addColorStop(p, c));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}

function ground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  top: string,
  bottom: string,
  y = 0.78,
) {
  const floorY = h * y;
  const g = ctx.createLinearGradient(0, floorY, 0, h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, floorY + h * 0.03);
  ctx.quadraticCurveTo(w * 0.5, floorY - h * 0.03, w, floorY + h * 0.03);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  for (let i = 0; i < 8; i++) {
    ctx.beginPath();
    ctx.ellipse(w * (0.06 + i * 0.13), h * (y + 0.08 + (i % 2) * 0.06), w * 0.05, h * 0.012, 0, 0, TAU);
    ctx.fill();
  }
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = (i / 10) * TAU - Math.PI / 2;
    ctx.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
  }
  ctx.closePath();
  ctx.fill();
}

function twinkles(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, n = 22, span = 0.7) {
  for (let i = 0; i < n; i++) {
    const sx = ((i * 137.5) % 100) / 100;
    const sy = ((i * 61.8) % 100) / 100;
    const tw = 0.5 + 0.5 * Math.sin(t * 1.6 + i);
    star(ctx, sx * w, sy * h * span, h * 0.009 * (0.7 + tw * 0.7), `rgba(255,255,255,${0.3 + tw * 0.5})`);
  }
}

function puff(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, fill: string) {
  ctx.fillStyle = fill;
  ([[0, 0, 1], [-0.7, 0.15, 0.72], [0.75, 0.18, 0.66], [-0.3, -0.3, 0.6], [0.35, -0.32, 0.62]] as const).forEach(
    ([dx, dy, r]) => {
      ctx.beginPath();
      ctx.arc(cx + dx * s, cy + dy * s, r * s, 0, TAU);
      ctx.fill();
    },
  );
}

function clouds(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  fill = "rgba(255,255,255,0.8)",
  n = 4,
) {
  for (let i = 0; i < n; i++) {
    const speed = 0.005 + i * 0.0018;
    const cx = ((0.12 + i * 0.26 + t * speed) % 1.3) * w - w * 0.15;
    puff(ctx, cx, h * (0.09 + (i % 3) * 0.085), h * (0.04 + (i % 2) * 0.018), fill);
  }
}

function tree(ctx: CanvasRenderingContext2D, x: number, baseY: number, s: number, leaf: string, dark: string, sway: number) {
  ctx.save();
  ctx.translate(x, baseY);
  ctx.rotate(sway);
  ctx.fillStyle = "#8a5a3b";
  ctx.fillRect(-s * 0.07, -s * 0.55, s * 0.14, s * 0.56);
  const blob = (dx: number, dy: number, r: number, c: string) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(dx * s, -s * 0.55 + dy * s, r * s, 0, TAU);
    ctx.fill();
  };
  blob(0, -0.18, 0.34, dark);
  blob(-0.26, -0.02, 0.26, leaf);
  blob(0.26, -0.04, 0.27, leaf);
  blob(0.02, -0.34, 0.26, leaf);
  ctx.restore();
}

function flower(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string, sway: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(sway);
  ctx.strokeStyle = "#3fa96a";
  ctx.lineWidth = s * 0.14;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -s * 1.1);
  ctx.stroke();
  ctx.fillStyle = color;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * s * 0.38, -s * 1.1 + Math.sin(a) * s * 0.38, s * 0.3, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = "#ffd166";
  ctx.beginPath();
  ctx.arc(0, -s * 1.1, s * 0.24, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function butterflies(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, n = 4) {
  const colors = ["#ff8fab", "#ffd166", "#7aa2ff", "#4dd4ac"];
  for (let i = 0; i < n; i++) {
    const x = ((0.1 + i * 0.24 + t * (0.02 + i * 0.005)) % 1.1) * w;
    const y = h * (0.3 + 0.12 * Math.sin(t * 1.4 + i * 2)) + h * (i % 2) * 0.12;
    const flap = Math.abs(Math.sin(t * 7 + i));
    ctx.fillStyle = colors[i % 4]!;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.ellipse(-h * 0.012, 0, h * 0.012 * (0.4 + flap), h * 0.014, -0.4, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(h * 0.012, 0, h * 0.012 * (0.4 + flap), h * 0.014, 0.4, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

function bubbles(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, n = 18) {
  for (let i = 0; i < n; i++) {
    const bx = ((i * 83) % 100) / 100;
    const drift = ((t * (0.03 + (i % 4) * 0.01) + i * 0.11) % 1.2) - 0.1;
    const r = h * (0.007 + (i % 3) * 0.006);
    const x = bx * w + Math.sin(t + i) * w * 0.012;
    const y = (1 - drift) * h;
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = r * 0.28;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.fill();
  }
}

function fish(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, n = 5) {
  const colors = ["#ff9f1c", "#ffd166", "#ff6fb5", "#4dd4ac", "#ffffff"];
  for (let i = 0; i < n; i++) {
    const dir = i % 2 === 0 ? 1 : -1;
    const p = (t * (0.03 + i * 0.008) + i * 0.19) % 1.2;
    const x = dir > 0 ? p * w * 1.1 - w * 0.05 : w * 1.05 - p * w * 1.1;
    const y = h * (0.2 + ((i * 0.17) % 0.6)) + Math.sin(t * 2 + i) * h * 0.02;
    const s = h * (0.026 + (i % 3) * 0.008);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir, 1);
    ctx.fillStyle = colors[i % colors.length]!;
    ctx.beginPath();
    ctx.ellipse(0, 0, s, s * 0.6, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-s, 0);
    ctx.lineTo(-s * 1.7, -s * 0.5);
    ctx.lineTo(-s * 1.7, s * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#2b1f4a";
    ctx.beginPath();
    ctx.arc(s * 0.45, -s * 0.12, s * 0.11, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

function seaweed(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  for (let i = 0; i < 7; i++) {
    const x = w * (0.05 + i * 0.15);
    const hh = h * (0.14 + (i % 3) * 0.05);
    ctx.strokeStyle = i % 2 ? "#2f9e6e" : "#37b98a";
    ctx.lineWidth = h * 0.012;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x, h);
    for (let k = 1; k <= 4; k++) {
      const p = k / 4;
      ctx.lineTo(x + Math.sin(t * 1.4 + i + p * 3) * w * 0.012, h - hh * p);
    }
    ctx.stroke();
  }
}

function coral(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const colors = ["#ff8fab", "#ffd166", "#c48bff"];
  for (let i = 0; i < 6; i++) {
    const x = w * (0.1 + i * 0.16);
    ctx.fillStyle = colors[i % 3]!;
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath();
      ctx.ellipse(x + k * w * 0.018, h * 0.97, w * 0.012, h * (0.05 + (i % 2) * 0.02), k * 0.35, 0, TAU);
      ctx.fill();
    }
  }
}

function hills(ctx: CanvasRenderingContext2D, w: number, h: number, y: number, color: string, count = 3) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 0; i <= count; i++) {
    const cx = (i / count) * w;
    ctx.quadraticCurveTo(cx - w / (count * 2), h * (y - 0.08), cx, h * y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
}

function snowfall(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, n = 60) {
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  for (let i = 0; i < n; i++) {
    const x = (((i * 37) % 100) / 100) * w + Math.sin(t * 0.8 + i) * w * 0.02;
    const y = ((t * (0.04 + (i % 5) * 0.012) + i * 0.07) % 1.1) * h;
    ctx.beginPath();
    ctx.arc(x, y, h * (0.003 + (i % 3) * 0.002), 0, TAU);
    ctx.fill();
  }
}

function mountains(ctx: CanvasRenderingContext2D, w: number, h: number, y: number, color: string, snowCap = false) {
  const peaks = 4;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-w * 0.1, h * y + h * 0.2);
  for (let i = 0; i <= peaks; i++) {
    const x = (i / peaks) * w;
    ctx.lineTo(x - w * 0.08, h * y + h * 0.2);
    ctx.lineTo(x, h * (y - 0.1 - (i % 2) * 0.05));
    ctx.lineTo(x + w * 0.08, h * y + h * 0.2);
  }
  ctx.lineTo(w * 1.1, h * y + h * 0.2);
  ctx.closePath();
  ctx.fill();
  if (snowCap) {
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    for (let i = 0; i <= peaks; i++) {
      const x = (i / peaks) * w;
      const py = h * (y - 0.1 - (i % 2) * 0.05);
      ctx.beginPath();
      ctx.moveTo(x, py);
      ctx.lineTo(x - w * 0.022, py + h * 0.035);
      ctx.lineTo(x + w * 0.022, py + h * 0.035);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function rainbowArc(ctx: CanvasRenderingContext2D, w: number, h: number, alpha = 0.75) {
  const colors = ["#ff5c7a", "#ff9f1c", "#ffd166", "#4dd4ac", "#4dabff", "#9b6bd6"];
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = h * 0.028;
  colors.forEach((c, i) => {
    ctx.strokeStyle = c;
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.92, h * (0.52 - i * 0.03), Math.PI, TAU);
    ctx.stroke();
  });
  ctx.restore();
}

function planet(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c1: string, c2: string, ring = false) {
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  if (ring) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.4);
    ctx.strokeStyle = "rgba(255,220,150,0.8)";
    ctx.lineWidth = r * 0.14;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.7, r * 0.5, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
}

function moon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  glow(ctx, x, y, r * 3, "rgba(255,247,214,0.35)");
  ctx.fillStyle = "#fff6d6";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "rgba(226,214,178,0.75)";
  ([[0.3, -0.2, 0.2], [-0.3, 0.25, 0.16], [0.05, 0.45, 0.11]] as const).forEach(([dx, dy, rr]) => {
    ctx.beginPath();
    ctx.arc(x + dx * r, y + dy * r, rr * r, 0, TAU);
    ctx.fill();
  });
}

function bunting(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  const colors = ["#ff5c7a", "#ffd166", "#4dd4ac", "#7aa2ff", "#ff9f1c"];
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = h * 0.004;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.06);
  ctx.quadraticCurveTo(w * 0.5, h * 0.14, w, h * 0.06);
  ctx.stroke();
  for (let i = 0; i <= 14; i++) {
    const p = i / 14;
    const x = p * w;
    const y = h * 0.06 + Math.sin(p * Math.PI) * h * 0.06;
    ctx.fillStyle = colors[i % colors.length]!;
    ctx.beginPath();
    ctx.moveTo(x - w * 0.012, y);
    ctx.lineTo(x + w * 0.012, y);
    ctx.lineTo(x, y + h * 0.045 + Math.sin(t * 2 + i) * h * 0.004);
    ctx.closePath();
    ctx.fill();
  }
}

function balloons(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, n = 5) {
  const colors = ["#ff5c7a", "#ffd166", "#4dd4ac", "#7aa2ff", "#c48bff"];
  for (let i = 0; i < n; i++) {
    const x = w * (0.08 + i * 0.2) + Math.sin(t * 0.8 + i) * w * 0.01;
    const y = h * (0.32 + (i % 3) * 0.07) + Math.sin(t * 1.1 + i) * h * 0.012;
    const r = h * 0.035;
    ctx.fillStyle = colors[i % colors.length]!;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 0.82, r, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = h * 0.003;
    ctx.beginPath();
    ctx.moveTo(x, y + r);
    ctx.quadraticCurveTo(x + w * 0.008, y + r + h * 0.05, x, y + r + h * 0.1);
    ctx.stroke();
  }
}

function floatingIsland(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.fillStyle = "#8ce99a";
  ctx.beginPath();
  ctx.ellipse(x, y, s, s * 0.34, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#a07555";
  ctx.beginPath();
  ctx.moveTo(x - s * 0.92, y + s * 0.1);
  ctx.quadraticCurveTo(x, y + s * 1.05, x + s * 0.92, y + s * 0.1);
  ctx.closePath();
  ctx.fill();
}

/* -------------------------------- scenes -------------------------------- */

const light = (tint: string, tintAlpha: number, rim: string, rimAlpha: number): SceneLight => ({
  tint,
  tintAlpha,
  rim,
  rimAlpha,
});

export const SCENES: Scene[] = [
  {
    id: "forest",
    name: "Enchanted Forest",
    emoji: "🌳",
    dark: false,
    light: light("#ffd79a", 0.16, "rgba(255,224,150,0.55)", 0.9),
    draw: (ctx, w, h, t) => {
      sky(ctx, w, h, [
        [0, "#8fd7ff"],
        [0.45, "#c8f0d2"],
        [0.75, "#ffeec2"],
      ]);
      glow(ctx, w * 0.18, h * 0.1, h * 0.5, "rgba(255,246,200,0.75)");
      clouds(ctx, w, h, t, "rgba(255,255,255,0.6)", 3);
      hills(ctx, w, h, 0.72, "#5fc47f");
      ground(ctx, w, h, "#8ce99a", "#3b9c62");
      for (let i = 0; i < 6; i++) {
        const sway = Math.sin(t * 0.9 + i) * 0.015;
        tree(ctx, w * (0.06 + i * 0.19), h * (0.8 + (i % 2) * 0.03), h * (0.3 + (i % 3) * 0.05), "#54c07a", "#2f8f55", sway);
      }
      for (let i = 0; i < 9; i++)
        flower(ctx, w * (0.04 + i * 0.11), h * (0.9 + (i % 2) * 0.05), h * 0.022, ["#ff8fab", "#ffd166", "#c48bff"][i % 3]!, Math.sin(t + i) * 0.06);
      butterflies(ctx, w, h, t);
    },
  },
  {
    id: "rainbow",
    name: "Rainbow World",
    emoji: "🌈",
    dark: false,
    light: light("#ffd6f0", 0.14, "rgba(255,255,255,0.6)", 0.85),
    draw: (ctx, w, h, t) => {
      sky(ctx, w, h, [
        [0, "#b7e3ff"],
        [0.5, "#ffe3f4"],
        [1, "#fff2c9"],
      ]);
      rainbowArc(ctx, w, h, 0.6);
      clouds(ctx, w, h, t, "rgba(255,255,255,0.9)", 5);
      for (let i = 0; i < 12; i++) {
        const y = h * (0.15 + ((i * 0.13) % 0.55)) + Math.sin(t * 1.2 + i) * h * 0.012;
        star(ctx, w * ((i * 0.083 + 0.04) % 1), y, h * 0.014, ["#ffd166", "#ff8fab", "#7aa2ff"][i % 3]!);
      }
      ground(ctx, w, h, "#a6f0b8", "#4cbb7d");
    },
  },
  {
    id: "space",
    name: "Space",
    emoji: "🚀",
    dark: true,
    light: light("#8fb8ff", 0.2, "rgba(140,190,255,0.6)", 1),
    draw: (ctx, w, h, t) => {
      sky(ctx, w, h, [
        [0, "#140b39"],
        [0.55, "#2a1b63"],
        [1, "#4b2a7a"],
      ]);
      glow(ctx, w * 0.8, h * 0.2, h * 0.55, "rgba(160,110,255,0.35)");
      twinkles(ctx, w, h, t, 40, 1);
      planet(ctx, w * 0.14, h * 0.24, h * 0.075, "#ff9f6b", "#c2502a");
      planet(ctx, w * 0.86, h * 0.62, h * 0.1, "#ffd88f", "#c98a2f", true);
      moon(ctx, w * 0.72, h * 0.16, h * 0.05);
      const rx = ((t * 0.05) % 1.2) * w - w * 0.1;
      ctx.save();
      ctx.translate(rx, h * 0.42 + Math.sin(t) * h * 0.01);
      ctx.fillStyle = "#f4f6ff";
      ctx.beginPath();
      ctx.ellipse(0, 0, h * 0.035, h * 0.016, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#ff5c7a";
      ctx.beginPath();
      ctx.moveTo(-h * 0.035, 0);
      ctx.lineTo(-h * 0.06, -h * 0.018);
      ctx.lineTo(-h * 0.06, h * 0.018);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    },
  },
  {
    id: "underwater",
    name: "Underwater",
    emoji: "🌊",
    dark: true,
    light: light("#7fd8ff", 0.22, "rgba(120,220,255,0.55)", 1),
    draw: (ctx, w, h, t) => {
      sky(ctx, w, h, [
        [0, "#1fa2d8"],
        [0.5, "#1273ad"],
        [1, "#0b4e80"],
      ]);
      for (let i = 0; i < 5; i++) {
        ctx.save();
        ctx.globalAlpha = 0.12 + 0.05 * Math.sin(t + i);
        ctx.fillStyle = "#dff6ff";
        ctx.beginPath();
        ctx.moveTo(w * (0.05 + i * 0.2), 0);
        ctx.lineTo(w * (0.14 + i * 0.2), 0);
        ctx.lineTo(w * (0.3 + i * 0.2), h);
        ctx.lineTo(w * (0.02 + i * 0.2), h);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ground(ctx, w, h, "#f2dfae", "#cdae74", 0.88);
      seaweed(ctx, w, h, t);
      coral(ctx, w, h);
      fish(ctx, w, h, t, 5);
      bubbles(ctx, w, h, t, 20);
    },
  },
  {
    id: "dinosaur",
    name: "Dinosaur Land",
    emoji: "🦖",
    dark: false,
    light: light("#ffc08a", 0.18, "rgba(255,190,120,0.5)", 0.9),
    draw: (ctx, w, h, t) => {
      sky(ctx, w, h, [
        [0, "#ffc27a"],
        [0.5, "#ffd9a0"],
        [1, "#cfe9a8"],
      ]);
      glow(ctx, w * 0.7, h * 0.16, h * 0.4, "rgba(255,220,160,0.7)");
      mountains(ctx, w, h, 0.62, "#7a6a86");
      // volcano
      ctx.fillStyle = "#6b4b4b";
      ctx.beginPath();
      ctx.moveTo(w * 0.12, h * 0.72);
      ctx.lineTo(w * 0.26, h * 0.42);
      ctx.lineTo(w * 0.4, h * 0.72);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#ff7043";
      ctx.beginPath();
      ctx.moveTo(w * 0.23, h * 0.45);
      ctx.lineTo(w * 0.26, h * 0.42);
      ctx.lineTo(w * 0.29, h * 0.45);
      ctx.lineTo(w * 0.27, h * 0.56);
      ctx.lineTo(w * 0.25, h * 0.56);
      ctx.closePath();
      ctx.fill();
      for (let i = 0; i < 3; i++)
        puff(ctx, w * 0.26 + Math.sin(t + i) * w * 0.01, h * (0.36 - i * 0.06), h * 0.026, "rgba(200,190,190,0.55)");
      ground(ctx, w, h, "#8fbf6a", "#4d8a47");
      for (let i = 0; i < 4; i++)
        tree(ctx, w * (0.1 + i * 0.27), h * (0.82 + (i % 2) * 0.03), h * 0.26, "#3f9f5f", "#2b7a45", Math.sin(t * 0.7 + i) * 0.012);
      ctx.fillStyle = "#8a8177";
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.ellipse(w * (0.08 + i * 0.22), h * (0.92 + (i % 2) * 0.04), w * 0.022, h * 0.018, 0, 0, TAU);
        ctx.fill();
      }
    },
  },
  {
    id: "castle",
    name: "Fairy-Tale Castle",
    emoji: "🏰",
    dark: false,
    light: light("#ffd8f2", 0.15, "rgba(255,210,245,0.6)", 0.9),
    draw: (ctx, w, h, t) => {
      sky(ctx, w, h, [
        [0, "#b39bff"],
        [0.5, "#ffc9e6"],
        [1, "#ffe8c2"],
      ]);
      twinkles(ctx, w, h, t, 14, 0.5);
      clouds(ctx, w, h, t, "rgba(255,255,255,0.75)", 4);
      // castle
      const cx = w * 0.5;
      const baseY = h * 0.74;
      ctx.fillStyle = "#efe6ff";
      const towers: [number, number][] = [
        [-0.18, 0.24],
        [0, 0.32],
        [0.18, 0.24],
      ];
      towers.forEach(([dx, hh]) => {
        const tw = w * 0.06;
        ctx.fillStyle = "#f2ebff";
        ctx.fillRect(cx + dx * w - tw / 2, baseY - h * hh, tw, h * hh);
        ctx.fillStyle = "#c48bff";
        ctx.beginPath();
        ctx.moveTo(cx + dx * w - tw * 0.75, baseY - h * hh);
        ctx.lineTo(cx + dx * w, baseY - h * hh - h * 0.1);
        ctx.lineTo(cx + dx * w + tw * 0.75, baseY - h * hh);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#7aa2ff";
        ctx.fillRect(cx + dx * w - tw * 0.13, baseY - h * hh * 0.55, tw * 0.26, h * 0.05);
      });
      ctx.fillStyle = "#e7dcff";
      ctx.fillRect(cx - w * 0.17, baseY - h * 0.14, w * 0.34, h * 0.14);
      ctx.fillStyle = "#8a5a3b";
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.035, baseY);
      ctx.lineTo(cx - w * 0.035, baseY - h * 0.06);
      ctx.quadraticCurveTo(cx, baseY - h * 0.11, cx + w * 0.035, baseY - h * 0.06);
      ctx.lineTo(cx + w * 0.035, baseY);
      ctx.closePath();
      ctx.fill();
      ground(ctx, w, h, "#a6f0b8", "#49b177");
      for (let i = 0; i < 8; i++)
        flower(ctx, w * (0.05 + i * 0.13), h * (0.9 + (i % 2) * 0.05), h * 0.02, ["#ff8fab", "#ffd166"][i % 2]!, Math.sin(t + i) * 0.05);
    },
  },
  {
    id: "garden",
    name: "Flower Garden",
    emoji: "🌻",
    dark: false,
    light: light("#ffe6a8", 0.16, "rgba(255,235,170,0.6)", 0.9),
    draw: (ctx, w, h, t) => {
      sky(ctx, w, h, [
        [0, "#9fdcff"],
        [0.55, "#dff7d8"],
        [1, "#fff3c4"],
      ]);
      glow(ctx, w * 0.85, h * 0.12, h * 0.42, "rgba(255,246,190,0.8)");
      clouds(ctx, w, h, t, "rgba(255,255,255,0.7)", 3);
      ground(ctx, w, h, "#9df0a6", "#3fa96a", 0.72);
      for (let i = 0; i < 4; i++)
        tree(ctx, w * (0.09 + i * 0.29), h * 0.78, h * 0.22, "#63cd85", "#3d9c60", Math.sin(t * 0.8 + i) * 0.014);
      for (let row = 0; row < 3; row++)
        for (let i = 0; i < 11; i++)
          flower(
            ctx,
            w * (0.03 + i * 0.095) + row * w * 0.03,
            h * (0.82 + row * 0.07),
            h * (0.02 + row * 0.007),
            ["#ff8fab", "#ffd166", "#c48bff", "#ff9f1c"][(i + row) % 4]!,
            Math.sin(t * 1.3 + i + row) * 0.07,
          );
      butterflies(ctx, w, h, t, 5);
    },
  },
  {
    id: "clouds",
    name: "Cloud Kingdom",
    emoji: "☁️",
    dark: false,
    light: light("#dbeaff", 0.12, "rgba(255,255,255,0.65)", 0.9),
    draw: (ctx, w, h, t) => {
      sky(ctx, w, h, [
        [0, "#7ec8ff"],
        [0.6, "#c9e9ff"],
        [1, "#ffe9f2"],
      ]);
      clouds(ctx, w, h, t, "rgba(255,255,255,0.95)", 6);
      floatingIsland(ctx, w * 0.18, h * 0.66 + Math.sin(t) * h * 0.008, h * 0.09);
      floatingIsland(ctx, w * 0.82, h * 0.56 + Math.sin(t + 1.6) * h * 0.008, h * 0.07);
      tree(ctx, w * 0.18, h * 0.64 + Math.sin(t) * h * 0.008, h * 0.14, "#63cd85", "#3d9c60", Math.sin(t) * 0.02);
      for (let i = 0; i < 6; i++)
        puff(ctx, ((0.1 + i * 0.19 + t * 0.004) % 1.2) * w, h * (0.84 + (i % 2) * 0.07), h * 0.07, "rgba(255,255,255,0.95)");
    },
  },
  {
    id: "classroom",
    name: "Cute Classroom",
    emoji: "🏫",
    dark: false,
    light: light("#fff0cf", 0.12, "rgba(255,240,200,0.55)", 0.85),
    draw: (ctx, w, h, t) => {
      sky(ctx, w, h, [
        [0, "#ffe9c9"],
        [0.7, "#ffdcae"],
        [1, "#f6c78d"],
      ]);
      // wall stripes
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      for (let i = 0; i < 10; i++) ctx.fillRect(w * (i * 0.1), 0, w * 0.05, h * 0.8);
      // blackboard
      ctx.fillStyle = "#8a5a3b";
      ctx.fillRect(w * 0.06, h * 0.1, w * 0.34, h * 0.34);
      ctx.fillStyle = "#2f6b4f";
      ctx.fillRect(w * 0.075, h * 0.115, w * 0.31, h * 0.31);
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = h * 0.006;
      ctx.beginPath();
      ctx.moveTo(w * 0.11, h * 0.35);
      ctx.lineTo(w * 0.2, h * 0.22);
      ctx.lineTo(w * 0.28, h * 0.35);
      ctx.closePath();
      ctx.stroke();
      // shelf with books
      ctx.fillStyle = "#c98a5a";
      ctx.fillRect(w * 0.62, h * 0.3, w * 0.3, h * 0.02);
      const bookColors = ["#ff5c7a", "#ffd166", "#4dd4ac", "#7aa2ff", "#c48bff"];
      for (let i = 0; i < 9; i++) {
        ctx.fillStyle = bookColors[i % 5]!;
        const bh = h * (0.08 + (i % 3) * 0.02);
        ctx.fillRect(w * (0.635 + i * 0.03), h * 0.3 - bh, w * 0.022, bh);
      }
      // abc cards
      ["A", "B", "C"].forEach((c, i) => {
        ctx.fillStyle = ["#ff8fab", "#ffd166", "#7aa2ff"][i]!;
        ctx.save();
        ctx.translate(w * (0.5 + i * 0.06), h * (0.14 + Math.sin(t + i) * 0.006));
        ctx.rotate((i - 1) * 0.12);
        ctx.fillRect(-w * 0.022, -h * 0.035, w * 0.044, h * 0.07);
        ctx.fillStyle = "#ffffff";
        ctx.font = `800 ${h * 0.045}px 'Baloo 2', system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(c, 0, h * 0.004);
        ctx.restore();
      });
      ground(ctx, w, h, "#e8b98a", "#c88f5e", 0.8);
    },
  },
  {
    id: "lab",
    name: "Science Lab",
    emoji: "🔬",
    dark: false,
    light: light("#d6f2ff", 0.13, "rgba(190,240,255,0.55)", 0.9),
    draw: (ctx, w, h, t) => {
      sky(ctx, w, h, [
        [0, "#dff3ff"],
        [0.7, "#bfe6f7"],
        [1, "#a5d8ef"],
      ]);
      ctx.strokeStyle = "rgba(255,255,255,0.4)";
      ctx.lineWidth = h * 0.003;
      for (let i = 0; i < 12; i++) {
        ctx.beginPath();
        ctx.moveTo(w * i * 0.09, 0);
        ctx.lineTo(w * i * 0.09, h * 0.8);
        ctx.stroke();
      }
      // atom
      ctx.save();
      ctx.translate(w * 0.2, h * 0.22);
      ctx.strokeStyle = "#7aa2ff";
      ctx.lineWidth = h * 0.006;
      for (let i = 0; i < 3; i++) {
        ctx.save();
        ctx.rotate((i / 3) * Math.PI + t * 0.3);
        ctx.beginPath();
        ctx.ellipse(0, 0, h * 0.09, h * 0.032, 0, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
      ctx.fillStyle = "#ff5c7a";
      ctx.beginPath();
      ctx.arc(0, 0, h * 0.018, 0, TAU);
      ctx.fill();
      ctx.restore();
      // beakers on bench
      const bench = h * 0.78;
      const beaker = (x: number, liquid: string, sc: number) => {
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.fillRect(x, bench - h * 0.14 * sc, w * 0.05, h * 0.14 * sc);
        ctx.fillStyle = liquid;
        ctx.fillRect(x, bench - h * 0.075 * sc, w * 0.05, h * 0.075 * sc);
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = "rgba(255,255,255,0.7)";
          ctx.beginPath();
          ctx.arc(
            x + w * 0.012 + i * w * 0.014,
            bench - h * 0.075 * sc + ((t * 0.3 + i * 0.3) % 1) * -h * 0.05,
            h * 0.005,
            0,
            TAU,
          );
          ctx.fill();
        }
      };
      beaker(w * 0.62, "#4dd4ac", 1);
      beaker(w * 0.7, "#ff8fab", 0.8);
      beaker(w * 0.78, "#ffd166", 1.15);
      ctx.fillStyle = "#cfd9e6";
      ctx.fillRect(0, bench, w, h - bench);
      ctx.fillStyle = "#b8c4d4";
      ctx.fillRect(0, bench, w, h * 0.012);
    },
  },
  {
    id: "winter",
    name: "Winter Wonderland",
    emoji: "🧊",
    dark: false,
    light: light("#d8ecff", 0.16, "rgba(210,235,255,0.6)", 0.9),
    draw: (ctx, w, h, t) => {
      sky(ctx, w, h, [
        [0, "#8ec6f0"],
        [0.55, "#cfe8fb"],
        [1, "#f2f9ff"],
      ]);
      mountains(ctx, w, h, 0.66, "#b9d4ea", true);
      ground(ctx, w, h, "#ffffff", "#d7e8f5");
      for (let i = 0; i < 5; i++) {
        const x = w * (0.08 + i * 0.22);
        const s = h * (0.24 + (i % 2) * 0.05);
        ctx.fillStyle = "#8a5a3b";
        ctx.fillRect(x - s * 0.03, h * 0.82 - s * 0.28, s * 0.06, s * 0.28);
        for (let k = 0; k < 3; k++) {
          ctx.fillStyle = k % 2 ? "#2f8f55" : "#3aa869";
          ctx.beginPath();
          ctx.moveTo(x - s * (0.2 - k * 0.045), h * 0.82 - s * (0.24 + k * 0.16));
          ctx.lineTo(x, h * 0.82 - s * (0.42 + k * 0.16));
          ctx.lineTo(x + s * (0.2 - k * 0.045), h * 0.82 - s * (0.24 + k * 0.16));
          ctx.closePath();
          ctx.fill();
        }
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.beginPath();
        ctx.ellipse(x, h * 0.82 - s * 0.58, s * 0.09, s * 0.03, 0, 0, TAU);
        ctx.fill();
      }
      snowfall(ctx, w, h, t);
    },
  },
  {
    id: "island",
    name: "Tropical Island",
    emoji: "🏝️",
    dark: false,
    light: light("#ffe0a8", 0.16, "rgba(255,225,160,0.6)", 0.9),
    draw: (ctx, w, h, t) => {
      sky(ctx, w, h, [
        [0, "#63c8ff"],
        [0.5, "#a9e6ff"],
        [1, "#ffe6b3"],
      ]);
      glow(ctx, w * 0.8, h * 0.14, h * 0.4, "rgba(255,246,190,0.8)");
      clouds(ctx, w, h, t, "rgba(255,255,255,0.75)", 3);
      // ocean
      ctx.fillStyle = "#2ba7d6";
      ctx.fillRect(0, h * 0.6, w, h * 0.2);
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = h * 0.005;
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        const y = h * (0.63 + i * 0.032);
        ctx.moveTo(0, y);
        for (let x = 0; x <= w; x += w / 12)
          ctx.lineTo(x, y + Math.sin(x / (w / 6) + t * 1.4 + i) * h * 0.006);
        ctx.stroke();
      }
      ground(ctx, w, h, "#ffe9b8", "#e8c68a");
      // palms
      for (let i = 0; i < 3; i++) {
        const x = w * (0.1 + i * 0.36);
        const s = h * (0.3 + (i % 2) * 0.06);
        ctx.save();
        ctx.translate(x, h * 0.82);
        ctx.rotate(Math.sin(t * 0.8 + i) * 0.02 - 0.06);
        ctx.strokeStyle = "#a0714a";
        ctx.lineWidth = s * 0.07;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(s * 0.1, -s * 0.5, 0, -s);
        ctx.stroke();
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * TAU;
          ctx.strokeStyle = k % 2 ? "#3aa869" : "#2f8f55";
          ctx.lineWidth = s * 0.06;
          ctx.beginPath();
          ctx.moveTo(0, -s);
          ctx.quadraticCurveTo(Math.cos(a) * s * 0.22, -s - Math.abs(Math.sin(a)) * s * 0.2, Math.cos(a) * s * 0.42, -s + Math.sin(a) * s * 0.1);
          ctx.stroke();
        }
        ctx.restore();
      }
    },
  },
  {
    id: "volcano",
    name: "Volcano Adventure",
    emoji: "🌋",
    dark: true,
    light: light("#ffb27a", 0.2, "rgba(255,150,90,0.55)", 1),
    draw: (ctx, w, h, t) => {
      sky(ctx, w, h, [
        [0, "#5b2a5f"],
        [0.5, "#c04a55"],
        [1, "#ff9f4a"],
      ]);
      glow(ctx, w * 0.5, h * 0.6, h * 0.5, "rgba(255,140,60,0.4)");
      mountains(ctx, w, h, 0.6, "#4b2f4a");
      ctx.fillStyle = "#3a2438";
      ctx.beginPath();
      ctx.moveTo(w * 0.32, h * 0.78);
      ctx.lineTo(w * 0.5, h * 0.3);
      ctx.lineTo(w * 0.68, h * 0.78);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#ff7043";
      ctx.beginPath();
      ctx.moveTo(w * 0.46, h * 0.34);
      ctx.lineTo(w * 0.5, h * 0.3);
      ctx.lineTo(w * 0.54, h * 0.34);
      ctx.quadraticCurveTo(w * 0.52, h * 0.52, w * 0.55, h * 0.66);
      ctx.lineTo(w * 0.45, h * 0.66);
      ctx.quadraticCurveTo(w * 0.48, h * 0.5, w * 0.46, h * 0.34);
      ctx.closePath();
      ctx.fill();
      for (let i = 0; i < 8; i++) {
        const p = ((t * 0.5 + i * 0.13) % 1);
        ctx.fillStyle = `rgba(255,${140 + i * 8},80,${0.9 - p * 0.9})`;
        ctx.beginPath();
        ctx.arc(w * (0.5 + Math.sin(i * 2) * 0.05 * p * 2), h * (0.3 - p * 0.18), h * 0.008, 0, TAU);
        ctx.fill();
      }
      for (let i = 0; i < 4; i++)
        puff(ctx, w * 0.5 + Math.sin(t * 0.5 + i) * w * 0.03, h * (0.24 - i * 0.05), h * 0.035, "rgba(120,100,110,0.45)");
      ground(ctx, w, h, "#5c4a52", "#33262e");
      ctx.fillStyle = "#453640";
      for (let i = 0; i < 6; i++) {
        ctx.beginPath();
        ctx.ellipse(w * (0.06 + i * 0.18), h * (0.9 + (i % 2) * 0.05), w * 0.025, h * 0.02, 0, 0, TAU);
        ctx.fill();
      }
    },
  },
  {
    id: "night",
    name: "Night Sky",
    emoji: "🌙",
    dark: true,
    light: light("#9fb8ff", 0.2, "rgba(180,200,255,0.5)", 1),
    draw: (ctx, w, h, t) => {
      sky(ctx, w, h, [
        [0, "#0d1440"],
        [0.55, "#22306e"],
        [1, "#4a4f9c"],
      ]);
      twinkles(ctx, w, h, t, 34, 0.85);
      moon(ctx, w * 0.8, h * 0.18, h * 0.075);
      for (let i = 0; i < 4; i++) {
        const cx = ((0.1 + i * 0.27 + t * 0.004) % 1.3) * w - w * 0.1;
        puff(ctx, cx, h * (0.28 + (i % 2) * 0.1), h * 0.045, "rgba(180,190,255,0.28)");
      }
      hills(ctx, w, h, 0.78, "#1c2450");
      ground(ctx, w, h, "#2b3566", "#161d3f", 0.85);
    },
  },
  {
    id: "carnival",
    name: "Fun Carnival",
    emoji: "🎪",
    dark: false,
    light: light("#ffd8e6", 0.15, "rgba(255,220,235,0.6)", 0.9),
    draw: (ctx, w, h, t) => {
      sky(ctx, w, h, [
        [0, "#6f5bd6"],
        [0.5, "#ff8fb8"],
        [1, "#ffd7a0"],
      ]);
      twinkles(ctx, w, h, t, 16, 0.5);
      // tents
      const tent = (x: number, s: number, c1: string) => {
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.moveTo(x - s, h * 0.78);
        ctx.lineTo(x, h * 0.78 - s * 1.1);
        ctx.lineTo(x + s, h * 0.78);
        ctx.closePath();
        ctx.fill();
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x - s, h * 0.78);
        ctx.lineTo(x, h * 0.78 - s * 1.1);
        ctx.lineTo(x + s, h * 0.78);
        ctx.closePath();
        ctx.clip();
        ctx.fillStyle = c1;
        for (let i = -3; i <= 3; i++) ctx.fillRect(x + i * s * 0.3, h * 0.78 - s * 1.2, s * 0.15, s * 1.3);
        ctx.restore();
        ctx.fillStyle = "#ffd166";
        ctx.beginPath();
        ctx.arc(x, h * 0.78 - s * 1.16, s * 0.08, 0, TAU);
        ctx.fill();
      };
      tent(w * 0.16, h * 0.13, "#ff5c7a");
      tent(w * 0.84, h * 0.11, "#4dd4ac");
      bunting(ctx, w, h, t);
      balloons(ctx, w, h, t, 5);
      ground(ctx, w, h, "#9ce7a8", "#48ae74");
      for (let i = 0; i < 12; i++) {
        const tw = 0.5 + 0.5 * Math.sin(t * 4 + i);
        ctx.fillStyle = `rgba(255,240,180,${0.35 + tw * 0.5})`;
        ctx.beginPath();
        ctx.arc(w * (0.04 + i * 0.085), h * 0.8, h * 0.007, 0, TAU);
        ctx.fill();
      }
    },
  },
  {
    id: "ocean",
    name: "Ocean Adventure",
    emoji: "🐠",
    dark: false,
    light: light("#a8ecff", 0.18, "rgba(160,235,255,0.6)", 0.95),
    draw: (ctx, w, h, t) => {
      sky(ctx, w, h, [
        [0, "#6fe0ff"],
        [0.5, "#39b8e8"],
        [1, "#1b83b8"],
      ]);
      glow(ctx, w * 0.35, h * 0.05, h * 0.55, "rgba(255,255,255,0.5)");
      for (let i = 0; i < 4; i++) {
        ctx.save();
        ctx.globalAlpha = 0.14 + 0.06 * Math.sin(t * 1.2 + i);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.moveTo(w * (0.12 + i * 0.24), 0);
        ctx.lineTo(w * (0.2 + i * 0.24), 0);
        ctx.lineTo(w * (0.34 + i * 0.24), h * 0.9);
        ctx.lineTo(w * (0.08 + i * 0.24), h * 0.9);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ground(ctx, w, h, "#ffeec2", "#dcc189", 0.88);
      seaweed(ctx, w, h, t);
      coral(ctx, w, h);
      fish(ctx, w, h, t, 7);
      // turtle-ish friend
      const tx = ((t * 0.02) % 1.2) * w - w * 0.1;
      ctx.fillStyle = "#3aa869";
      ctx.beginPath();
      ctx.ellipse(tx, h * 0.5 + Math.sin(t) * h * 0.01, h * 0.05, h * 0.032, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#8ce99a";
      ctx.beginPath();
      ctx.arc(tx + h * 0.055, h * 0.5 + Math.sin(t) * h * 0.01, h * 0.018, 0, TAU);
      ctx.fill();
      bubbles(ctx, w, h, t, 22);
    },
  },
];

export const DEFAULT_BACKGROUND: BackgroundId = "forest";

const SCENE_MAP = new Map(SCENES.map((s) => [s.id, s]));

export function getScene(id: BackgroundId | undefined): Scene {
  return SCENE_MAP.get(id ?? DEFAULT_BACKGROUND) ?? SCENES[0]!;
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  id: BackgroundId | undefined,
  w: number,
  h: number,
  t: number,
) {
  getScene(id).draw(ctx, w, h, t);
}
