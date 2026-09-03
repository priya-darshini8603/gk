import { drawOwl, poseToLook } from "./owl";
import { getScene } from "./backgrounds";
import { OPTION_KEYS, type Quiz } from "./types";
import type { RenderState } from "./timeline";

const TAU = Math.PI * 2;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const OPTION_COLORS = ["#ff8fab", "#4dd4ac", "#ffc75f", "#7aa2ff"];

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxW && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  maxH: number,
  startSize: number,
  weight = "800",
  family = "'Baloo 2', 'Nunito', system-ui, sans-serif",
) {
  let size = startSize;
  let lines: string[] = [];
  for (; size > 8; size -= 1) {
    ctx.font = `${weight} ${size}px ${family}`;
    lines = wrapLines(ctx, text, maxW);
    if (lines.length * size * 1.22 <= maxH) break;
  }
  return { size, lines };
}

interface Layout {
  board: { x: number; y: number; w: number; h: number };
  options: { x: number; y: number; w: number; h: number }[];
  egg: { x: number; y: number; size: number };
  portrait: boolean;
}

export function computeLayout(w: number, h: number): Layout {
  const portrait = h > w;
  if (!portrait) {
    const board = { x: w * 0.045, y: h * 0.07, w: w * 0.63, h: h * 0.82 };
    const pad = board.w * 0.05;
    const ow = (board.w - pad * 3) / 2;
    const oh = board.h * 0.19;
    const oy = board.y + board.h * 0.5;
    const options = OPTION_KEYS.map((_, i) => ({
      x: board.x + pad + (i % 2) * (ow + pad),
      y: oy + Math.floor(i / 2) * (oh + board.h * 0.045),
      w: ow,
      h: oh,
    }));
    return { board, options, owl: { x: w * 0.845, y: h * 0.93, size: h * 0.46 }, portrait };
  }
  const board = { x: w * 0.05, y: h * 0.06, w: w * 0.9, h: h * 0.56 };
  const pad = board.w * 0.05;
  const ow = (board.w - pad * 3) / 2;
  const oh = board.h * 0.17;
  const oy = board.y + board.h * 0.52;
  const options = OPTION_KEYS.map((_, i) => ({
    x: board.x + pad + (i % 2) * (ow + pad),
    y: oy + Math.floor(i / 2) * (oh + board.h * 0.05),
    w: ow,
    h: oh,
  }));
  return { board, options, owl: { x: w * 0.5, y: h * 0.97, size: h * 0.3 }, portrait };
}

/* -------------------------------- scene --------------------------------- */

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
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

function drawBoard(
  ctx: CanvasRenderingContext2D,
  quiz: Quiz,
  s: RenderState,
  l: Layout,
  t: number,
  needsScrim = false,
) {
  const b = l.board;
  const inP = clamp01(s.boardIn);
  const yOff = (1 - inP) * -l.board.h * 1.3 + Math.sin(inP * Math.PI) * -l.board.h * 0.04;
  ctx.save();
  ctx.globalAlpha = Math.min(1, inP * 1.5);
  ctx.translate(0, yOff);

  if (needsScrim) {
    // contrast plate so the question stays readable on dark scenes
    ctx.save();
    ctx.globalAlpha = 0.38;
    ctx.fillStyle = "#120a26";
    ctx.filter = "blur(0px)";
    roundRect(ctx, b.x - b.w * 0.03, b.y - b.h * 0.09, b.w * 1.06, b.h * 1.18, b.h * 0.12);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  ctx.shadowColor = "rgba(40,20,70,0.35)";
  ctx.shadowBlur = b.h * 0.06;
  ctx.shadowOffsetY = b.h * 0.02;
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, b.x, b.y, b.w, b.h, b.h * 0.08);
  ctx.fill();
  ctx.restore();

  // frame
  ctx.strokeStyle = "#7c5cff";
  ctx.lineWidth = b.h * 0.014;
  roundRect(ctx, b.x, b.y, b.w, b.h, b.h * 0.08);
  ctx.stroke();

  // header ribbon
  const hh = b.h * 0.13;
  const hg = ctx.createLinearGradient(b.x, b.y, b.x + b.w, b.y + hh);
  hg.addColorStop(0, "#132a5c");
  hg.addColorStop(1, "#0b1a3d");
  ctx.fillStyle = hg;
  roundRect(ctx, b.x + b.w * 0.06, b.y - hh * 0.42, b.w * 0.88, hh, hh * 0.5);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `800 ${hh * 0.52}px 'Baloo 2', 'Nunito', system-ui, sans-serif`;
  ctx.fillText("GK QUIZ", b.x + b.w * 0.5, b.y + hh * 0.08);

  // question
  const qArea = { x: b.x + b.w * 0.06, y: b.y + b.h * 0.16, w: b.w * 0.88, h: b.h * 0.28 };
  const qIn = clamp01(s.questionIn);
  if (qIn > 0) {
    ctx.save();
    const pop = 0.85 + qIn * 0.15 + Math.sin(qIn * Math.PI) * 0.05;
    ctx.translate(qArea.x + qArea.w / 2, qArea.y + qArea.h / 2);
    ctx.scale(pop, pop);
    ctx.globalAlpha = qIn;
    const { size, lines } = fitText(ctx, quiz.question, qArea.w, qArea.h, b.h * 0.13);
    ctx.fillStyle = "#2b1f4a";
    ctx.textAlign = "center";
    lines.forEach((ln, i) => {
      ctx.fillText(ln, 0, (i - (lines.length - 1) / 2) * size * 1.2);
    });
    ctx.restore();
  }

  // options
  OPTION_KEYS.forEach((key, i) => {
    const o = l.options[i]!;
    const p = clamp01(s.optionsIn[i]!);
    if (p <= 0) return;
    const isCorrect = key === quiz.correct;
    const revealed = s.reveal > 0;
    const highlighted = s.highlight === key;
    const glow = highlighted ? 0.5 + 0.5 * Math.sin(t * 6) : 0;
    ctx.save();
    ctx.globalAlpha = revealed && !isCorrect ? 0.45 : 1;
    const scale = (0.7 + p * 0.3) * (revealed && isCorrect ? 1 + 0.06 * Math.min(1, s.reveal) + Math.sin(t * 7) * 0.015 : 1);
    ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
    ctx.scale(scale, scale);
    ctx.translate(-(o.x + o.w / 2), -(o.y + o.h / 2));

    if (glow > 0 || (revealed && isCorrect)) {
      ctx.shadowColor = revealed && isCorrect ? "rgba(48,209,88,0.95)" : "rgba(255,209,102,0.95)";
      ctx.shadowBlur = o.h * (0.35 + glow * 0.35);
    }
    const cg = ctx.createLinearGradient(o.x, o.y, o.x, o.y + o.h);
    const base = revealed && isCorrect ? "#38d97a" : OPTION_COLORS[i]!;
    cg.addColorStop(0, base);
    cg.addColorStop(1, shade(base, -0.18));
    ctx.fillStyle = cg;
    roundRect(ctx, o.x, o.y, o.w, o.h, o.h * 0.32);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = revealed && isCorrect ? "#0f8f45" : "rgba(255,255,255,0.85)";
    ctx.lineWidth = o.h * (revealed && isCorrect ? 0.07 : 0.04);
    roundRect(ctx, o.x, o.y, o.w, o.h, o.h * 0.32);
    ctx.stroke();

    // letter badge
    const br = o.h * 0.3;
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.beginPath();
    ctx.arc(o.x + o.h * 0.42, o.y + o.h / 2, br, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#2b1f4a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `800 ${br * 1.05}px 'Baloo 2', system-ui, sans-serif`;
    ctx.fillText(key, o.x + o.h * 0.42, o.y + o.h / 2 + br * 0.04);

    // label
    const tx = o.x + o.h * 0.82;
    const tw = o.w - o.h * 1.15 - (revealed && isCorrect ? o.h * 0.5 : 0);
    const { size, lines } = fitText(ctx, quiz.options[key] || "—", tw, o.h * 0.8, o.h * 0.42);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    lines.forEach((ln, li) => {
      ctx.fillText(ln, tx, o.y + o.h / 2 + (li - (lines.length - 1) / 2) * size * 1.15);
    });

    if (revealed && isCorrect) {
      const cx = o.x + o.w - o.h * 0.42;
      const cy = o.y + o.h / 2;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(cx, cy, o.h * 0.26, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = "#0f8f45";
      ctx.lineWidth = o.h * 0.075;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(cx - o.h * 0.13, cy);
      ctx.lineTo(cx - o.h * 0.03, cy + o.h * 0.1);
      ctx.lineTo(cx + o.h * 0.14, cy - o.h * 0.12);
      ctx.stroke();
    }
    ctx.restore();
  });
  ctx.restore();
}

function shade(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amt * 255));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt * 255));
  const b = Math.max(0, Math.min(255, (n & 255) + amt * 255));
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function drawCountdown(ctx: CanvasRenderingContext2D, s: RenderState, w: number, h: number, l: Layout) {
  if (s.countdown == null || s.countdown <= 0) return;
  const cx = l.portrait ? w * 0.5 : (l.board.x + l.board.w + w) / 2;
  const cy = l.portrait ? h * 0.68 : h * 0.24;
  const pulse = s.countdownPulse;
  const scale = 1.35 - Math.min(1, pulse * 1.6) * 0.35 + (s.countdown === 1 ? Math.sin(pulse * 12) * 0.05 : 0);
  const size = Math.min(w, h) * (l.portrait ? 0.2 : 0.19);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = "rgba(43,31,74,0.35)";
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.72, 0, TAU);
  ctx.fill();
  ctx.font = `900 ${size}px 'Baloo 2', system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = size * 0.09;
  ctx.strokeStyle = "#ffffff";
  ctx.strokeText(String(s.countdown), 0, size * 0.05);
  const g = ctx.createLinearGradient(0, -size * 0.5, 0, size * 0.5);
  g.addColorStop(0, s.countdown === 1 ? "#ff5c7a" : "#ffd166");
  g.addColorStop(1, s.countdown === 1 ? "#c9184a" : "#ff9f1c");
  ctx.fillStyle = g;
  ctx.fillText(String(s.countdown), 0, size * 0.05);
  ctx.restore();
}

interface Confetti {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  color: string;
  shape: number;
}
let confetti: Confetti[] = [];
let confettiKey = -1;

function drawCelebration(ctx: CanvasRenderingContext2D, s: RenderState, w: number, h: number, key: number) {
  if (s.celebrate <= 0 && s.reveal <= 0) {
    confetti = [];
    confettiKey = -1;
    return;
  }
  if (confettiKey !== key) {
    confettiKey = key;
    confetti = Array.from({ length: 110 }, (_, i) => ({
      x: Math.random() * w,
      y: -Math.random() * h * 0.6,
      vx: (Math.random() - 0.5) * w * 0.05,
      vy: h * (0.12 + Math.random() * 0.22),
      rot: Math.random() * TAU,
      color: ["#ff6fb5", "#ffd166", "#4dd4ac", "#7aa2ff", "#ff9f1c"][i % 5]!,
      shape: i % 3,
    }));
  }
  const dt = 1 / 60;
  ctx.save();
  for (const c of confetti) {
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    c.vy += h * 0.12 * dt;
    c.rot += dt * 4;
    if (c.y > h + 20) {
      c.y = -20;
      c.vy = h * 0.12;
      c.x = Math.random() * w;
    }
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.rot);
    ctx.fillStyle = c.color;
    const sz = h * 0.014;
    if (c.shape === 0) ctx.fillRect(-sz / 2, -sz / 2, sz, sz * 1.6);
    else if (c.shape === 1) {
      ctx.beginPath();
      ctx.arc(0, 0, sz * 0.6, 0, TAU);
      ctx.fill();
    } else drawStar(ctx, 0, 0, sz * 0.9, c.color);
    ctx.restore();
  }
  ctx.restore();
}

function drawThoughtBubble(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, t: number) {
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = "#ffffff";
  [0.28, 0.45, 1].forEach((f, i) => {
    ctx.beginPath();
    ctx.arc(x - (1 - f) * r * 1.4, y + (1 - f) * r * 1.6 + Math.sin(t * 3 + i) * r * 0.05, r * f, 0, TAU);
    ctx.fill();
  });
  ctx.fillStyle = "#2b1f4a";
  ctx.font = `800 ${r * 0.9}px 'Baloo 2', system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("?", x, y + r * 0.05);
  ctx.restore();
}

function drawCaption(ctx: CanvasRenderingContext2D, text: string, w: number, h: number) {
  if (!text) return;
  ctx.save();
  ctx.font = `800 ${h * 0.038}px 'Baloo 2', system-ui, sans-serif`;
  const lines = wrapLines(ctx, text, w * 0.7);
  const lh = h * 0.048;
  const boxH = lines.length * lh + h * 0.03;
  const boxW = Math.min(w * 0.78, Math.max(...lines.map((l) => ctx.measureText(l).width)) + w * 0.06);
  const bx = (w - boxW) / 2;
  const by = h - boxH - h * 0.03;
  ctx.fillStyle = "rgba(43,31,74,0.78)";
  roundRect(ctx, bx, by, boxW, boxH, boxH * 0.35);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((ln, i) => ctx.fillText(ln, w / 2, by + boxH / 2 + (i - (lines.length - 1) / 2) * lh));
  ctx.restore();
}

function drawEndCard(ctx: CanvasRenderingContext2D, p: number, w: number, h: number, t: number) {
  if (p <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, p) * 0.9;
  ctx.fillStyle = "rgba(43,31,74,0.72)";
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = Math.min(1, p);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const s = Math.min(w, h) * 0.09 * (0.9 + Math.sin(t * 3) * 0.03);
  ctx.font = `900 ${s}px 'Baloo 2', system-ui, sans-serif`;
  const g = ctx.createLinearGradient(0, h * 0.4, 0, h * 0.6);
  g.addColorStop(0, "#ffd166");
  g.addColorStop(1, "#ff8fab");
  ctx.fillStyle = g;
  ctx.fillText("Can you get", w / 2, h * 0.44);
  ctx.fillText("the next one?", w / 2, h * 0.56);
  ctx.restore();
}

let litCanvas: HTMLCanvasElement | null = null;

/** Draw the owl, then wash it with the scene's light colour so it sits in the world. */
function drawOwlLit(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  look: ReturnType<typeof poseToLook>,
  tint: string,
  tintAlpha: number,
  w: number,
  h: number,
) {
  if (tintAlpha <= 0 || typeof document === "undefined") {
    drawOwl(ctx, x, y, size, look);
    return;
  }
  if (!litCanvas) litCanvas = document.createElement("canvas");
  if (litCanvas.width !== w || litCanvas.height !== h) {
    litCanvas.width = w;
    litCanvas.height = h;
  }
  const lc = litCanvas.getContext("2d");
  if (!lc) {
    drawOwl(ctx, x, y, size, look);
    return;
  }
  lc.setTransform(1, 0, 0, 1, 0, 0);
  lc.clearRect(0, 0, w, h);
  lc.globalCompositeOperation = "source-over";
  drawOwl(lc, x, y, size, look);
  lc.globalCompositeOperation = "source-atop";
  lc.globalAlpha = tintAlpha;
  lc.fillStyle = tint;
  lc.fillRect(0, 0, w, h);
  lc.globalAlpha = 1;
  lc.globalCompositeOperation = "source-over";
  ctx.drawImage(litCanvas, 0, 0);
}

/** Draw one full frame. */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  quiz: Quiz,
  s: RenderState,
  w: number,
  h: number,
  runKey = 0,
) {
  const t = s.t;
  const l = computeLayout(w, h);
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  if (s.cameraZoom !== 1) {
    ctx.translate(w / 2, h / 2);
    ctx.scale(s.cameraZoom, s.cameraZoom);
    ctx.translate(-w / 2, -h / 2);
  }
  const scene = getScene(quiz.background);
  scene.draw(ctx, w, h, t);
  drawBoard(ctx, quiz, s, l, t, scene.dark);

  const eggX = l.egg.x + s.eggX * (l.portrait ? w * 0.22 : w * 0.12);
  ctx.save();
  ctx.globalAlpha = clamp01(s.eggEnter * 1.4);
  // environment key light behind the owl keeps it readable on every scene
  const rim = ctx.createRadialGradient(
    eggX,
    l.egg.y - l.egg.size * 0.45,
    l.egg.size * 0.1,
    eggX,
    l.egg.y - l.egg.size * 0.45,
    l.egg.size * 0.85,
  );
  rim.addColorStop(0, scene.light.rim);
  rim.addColorStop(1, "rgba(255,255,255,0)");
  ctx.save();
  ctx.globalAlpha *= scene.light.rimAlpha;
  ctx.fillStyle = rim;
  ctx.beginPath();
  ctx.arc(owlX, l.owl.y - l.owl.size * 0.45, l.owl.size * 0.85, 0, TAU);
  ctx.fill();
  ctx.restore();
  drawOwlLit(ctx, owlX, l.owl.y, l.owl.size, poseToLook(s, t), scene.light.tint, scene.light.tintAlpha, w, h);
  ctx.restore();

  if (s.pose === "think" || s.reaction === "thinking") {
    drawThoughtBubble(ctx, owlX - l.owl.size * 0.42, l.owl.y - l.owl.size * 1.05, l.owl.size * 0.11, t);
  }

  drawCountdown(ctx, s, w, h, l);
  drawCelebration(ctx, s, w, h, runKey);
  drawCaption(ctx, s.caption, w, h);
  drawEndCard(ctx, s.endCard, w, h, t);
  ctx.restore();
}
