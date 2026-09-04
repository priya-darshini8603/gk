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
  const lines: string[] = [];
  const paragraphs = text.split(/\r?\n/);

  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= maxW) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      for (const character of word) {
        const part = line + character;
        if (line && ctx.measureText(part).width > maxW) {
          lines.push(line);
          line = character;
        } else line = part;
      }
    }
    if (line) lines.push(line);
    if (!words.length) lines.push("");
  }
  return lines.length ? lines : [""];
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
  const minSize = Math.min(12, startSize);
  let size = startSize;
  let lines: string[] = [];
  for (; size >= minSize; size -= 1) {
    ctx.font = `${weight} ${size}px ${family}`;
    lines = wrapLines(ctx, text, maxW);
    if (lines.length * size * 1.22 <= maxH) break;
  }
  while (size > 4) {
    ctx.font = `${weight} ${size}px ${family}`;
    lines = wrapLines(ctx, text, maxW);
    if (lines.length * size * 1.22 <= maxH) break;
    size -= 0.5;
  }
  ctx.font = `${weight} ${size}px ${family}`;
  lines = wrapLines(ctx, text, maxW);
  return { size, lines };
}

/* ---------------------------------------------------------------------------
 * PERF: fitText is deterministic given (text, maxW, maxH, startSize, weight,
 * family) — the font metrics don't depend on animation time. Without this
 * cache, drawFrame() re-ran the whole font-size search + word-wrap loop for
 * the question AND all 4 options on every single rendered frame (up to
 * 30x/sec for the full video length), which was the single biggest cost in
 * export. Same text/box -> same result, so we memoize it.
 * ------------------------------------------------------------------------- */
const fitTextCache = new Map<string, { size: number; lines: string[] }>();

function fitTextCached(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  maxH: number,
  startSize: number,
  weight = "800",
  family = "'Baloo 2', 'Nunito', system-ui, sans-serif",
) {
  const key = `${text}|${Math.round(maxW)}|${Math.round(maxH)}|${Math.round(startSize)}|${weight}|${family}`;
  const cached = fitTextCache.get(key);
  if (cached) {
    ctx.font = `${weight} ${cached.size}px ${family}`;
    return cached;
  }
  const result = fitText(ctx, text, maxW, maxH, startSize, weight, family);
  fitTextCache.set(key, result);
  return result;
}

interface Layout {
  board: { x: number; y: number; w: number; h: number };
  options: { x: number; y: number; w: number; h: number }[];
  owl: { x: number; y: number; size: number };
  /**
   * Fraction of frame width used for the owl's entrance-walk slide and its
   * small idle wobble (`state.owlX` in timeline.ts is in units of this
   * fraction). Derived from the actual margin outside the whiteboard so the
   * owl can never animate into the board's bounding box, regardless of how
   * BOARD_WIDTH_FRACTION below is tuned.
   */
  owlWalkFrac: number;
  portrait: boolean;
}

/* PERF: pure function of (w, h) — cache the last result so we don't
 * reallocate a fresh layout object (and 4 option-rect objects) every frame. */
let layoutCache: { key: string; layout: Layout } | null = null;

/**
 * MOBILE-SAFE FRAMING
 *
 * The whiteboard is always centered inside this fraction of the frame
 * width (0.62 sits inside the requested 60–70% band, biased toward the
 * lower end for extra margin). That guarantees:
 *   - equal, generous margins on both left and right (never near an edge)
 *   - the board's horizontal center always sits exactly at w/2, so the
 *     countdown "zoom in" effect (which scales from canvas center) zooms
 *     into the board's own center instead of dragging it sideways
 *   - survives reasonably aggressive responsive re-crops without losing
 *     any part of the board
 */
const BOARD_WIDTH_FRACTION = 0.62;

export function computeLayout(w: number, h: number): Layout {
  const key = `${w}x${h}`;
  if (layoutCache && layoutCache.key === key) return layoutCache.layout;

  const portrait = h > w;
  const boardMarginX = (1 - BOARD_WIDTH_FRACTION) / 2;
  let layout: Layout;

  if (!portrait) {
    const board = { x: w * boardMarginX, y: h * 0.07, w: w * BOARD_WIDTH_FRACTION, h: h * 0.82 };
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

    // The owl lives entirely in the right-hand margin outside the centered
    // whiteboard. Its size is derived from that margin (capped to the
    // original artistic size so it never grows huge on wider margins) so it
    // physically cannot overlap the board.
    const rightMarginW = w - (board.x + board.w); // == w * boardMarginX
    const boardGap = w * 0.018; // gap kept clear next to the board edge
    const edgeGap = w * 0.018; // gap kept clear next to the frame edge
    const owlWidthCap = h * 0.368; // ~ 0.8 * original 0.46h owl height
    const owlWidth = Math.max(
      w * 0.06,
      Math.min(rightMarginW - boardGap - edgeGap, owlWidthCap),
    );
    const owlSize = owlWidth / 0.8;
    const owlX = board.x + board.w + boardGap + owlWidth / 2;

    // Safe horizontal travel for the owl's walk-in / idle wobble: at its
    // most extreme (start of the "enter" beat, offset factor -1.1) the owl
    // must still sit to the right of the board's edge plus a buffer.
    const buffer = w * 0.01;
    const maxLeftTravel = Math.max(0, owlX - (board.x + board.w) - buffer);
    const owlWalkFrac = Math.min(0.12, maxLeftTravel / (1.1 * w));

    layout = {
      board,
      options,
      owl: { x: owlX, y: h * 0.93, size: owlSize },
      owlWalkFrac,
      portrait,
    };
  } else {
    const board = { x: w * boardMarginX, y: h * 0.06, w: w * BOARD_WIDTH_FRACTION, h: h * 0.56 };
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
    // The owl stands centered underneath the whiteboard — its top is always
    // well below the board's bottom edge, so horizontal margin size doesn't
    // affect overlap safety here; only the board needed re-centering.
    layout = {
      board,
      options,
      owl: { x: w * 0.5, y: h * 0.97, size: h * 0.3 },
      owlWalkFrac: 0.22,
      portrait,
    };
  }

  layoutCache = { key, layout };
  return layout;
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

/* ---------------------------------------------------------------------------
 * PERF: static board background cache.
 *
 * The white card, its drop shadow, the purple border, the header ribbon
 * gradient, and the "GK QUIZ" label never change once the layout (w, h) and
 * `needsScrim` flag are fixed for a render — but the original code redrew
 * all of it, including a `ctx.shadowBlur` fill, on every single frame.
 * shadowBlur is one of the most expensive Canvas2D operations, and here it
 * was being paid 30x/sec for a shape that's static for the whole video.
 *
 * We now render this once to an offscreen canvas (padded so the blurred
 * shadow isn't clipped) and just `drawImage` it every frame — a cheap
 * bitmap blit instead of a shadowed fill + gradient + text layout.
 * ------------------------------------------------------------------------- */
interface CachedBoardBg {
  key: string;
  canvas: HTMLCanvasElement;
  padX: number;
  padY: number;
}

let boardBgCache: CachedBoardBg | null = null;

function getBoardBackground(l: Layout, needsScrim: boolean): CachedBoardBg {
  const b = l.board;
  const key = `${b.x}|${b.y}|${b.w}|${b.h}|${needsScrim}`;

  if (boardBgCache && boardBgCache.key === key) return boardBgCache;

  const padX = b.w * 0.12;
  const padY = b.h * 0.28;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(b.w + padX * 2));
  canvas.height = Math.max(1, Math.ceil(b.h + padY * 2));

  const c = canvas.getContext("2d")!;
  c.translate(padX, padY);

  if (needsScrim) {
    c.save();
    c.globalAlpha = 0.38;
    c.fillStyle = "#120a26";
    roundRect(c, -b.w * 0.03, -b.h * 0.09, b.w * 1.06, b.h * 1.18, b.h * 0.12);
    c.fill();
    c.restore();
  }

  c.save();
  c.shadowColor = "rgba(40,20,70,0.35)";
  c.shadowBlur = b.h * 0.06;
  c.shadowOffsetY = b.h * 0.02;
  c.fillStyle = "#ffffff";
  roundRect(c, 0, 0, b.w, b.h, b.h * 0.08);
  c.fill();
  c.restore();

  c.strokeStyle = "#7c5cff";
  c.lineWidth = b.h * 0.014;
  roundRect(c, 0, 0, b.w, b.h, b.h * 0.08);
  c.stroke();

  const hh = b.h * 0.13;
  const hg = c.createLinearGradient(b.w * 0.06, -hh * 0.42, b.w * 0.94, hh * 0.58);
  hg.addColorStop(0, "#132a5c");
  hg.addColorStop(1, "#0b1a3d");
  c.fillStyle = hg;
  roundRect(c, b.w * 0.06, -hh * 0.42, b.w * 0.88, hh, hh * 0.5);
  c.fill();

  c.fillStyle = "#ffffff";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.font = `800 ${hh * 0.52}px 'Baloo 2', 'Nunito', system-ui, sans-serif`;
  c.fillText("GK QUIZ", b.w * 0.5, hh * 0.08);

  boardBgCache = { key, canvas, padX, padY };
  return boardBgCache;
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

  // PERF: one cheap bitmap blit instead of shadowed fill + gradient + text
  // layout every frame.
  const bg = getBoardBackground(l, needsScrim);
  ctx.drawImage(bg.canvas, b.x - bg.padX, b.y - bg.padY);

  // question
  const qArea = { x: b.x + b.w * 0.06, y: b.y + b.h * 0.16, w: b.w * 0.88, h: b.h * 0.28 };
  const qIn = clamp01(s.questionIn);
  if (qIn > 0) {
    ctx.save();
    const pop = 0.85 + qIn * 0.15 + Math.sin(qIn * Math.PI) * 0.05;
    ctx.translate(qArea.x + qArea.w / 2, qArea.y + qArea.h / 2);
    ctx.scale(pop, pop);
    ctx.globalAlpha = qIn;
    ctx.beginPath();
    ctx.rect(-qArea.w / 2, -qArea.h / 2, qArea.w, qArea.h);
    ctx.clip();
    const { size, lines } = fitTextCached(ctx, quiz.question, qArea.w, qArea.h, b.h * 0.13);
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

    // PERF: shadowBlur is only ever active while a specific option is
    // highlighted/correct, so this stays off (and cheap) for the vast
    // majority of the video's frames.
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
    ctx.save();
    ctx.beginPath();
    ctx.rect(tx, o.y + o.h * 0.1, tw, o.h * 0.8);
    ctx.clip();
    const { size, lines } = fitTextCached(ctx, quiz.options[key] || "—", tw, o.h * 0.8, o.h * 0.42);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    lines.forEach((ln, li) => {
      ctx.fillText(ln, tx, o.y + o.h / 2 + (li - (lines.length - 1) / 2) * size * 1.15);
    });
    ctx.restore();

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

  // owlWalkFrac replaces the old fixed (portrait ? w*0.22 : w*0.12) — it's
  // now sized per-layout so the walk-in/wobble offset can never carry the
  // owl into the whiteboard's bounding box.
  const owlX = l.owl.x + s.owlX * w * l.owlWalkFrac;
  ctx.save();
  ctx.globalAlpha = clamp01(s.owlEnter * 1.4);
  // environment key light behind the owl keeps it readable on every scene
  const rim = ctx.createRadialGradient(
    owlX,
    l.owl.y - l.owl.size * 0.45,
    l.owl.size * 0.1,
    owlX,
    l.owl.y - l.owl.size * 0.45,
    l.owl.size * 0.85,
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
  ctx.restore();
}