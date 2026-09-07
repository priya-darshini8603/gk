import { drawOwl, poseToLook } from "./owl";
import type { OwlLook } from "./owl";
import type { CharacterId } from "./types";

/* ---------------------------------------------------------------------------
 * SHARED ANIMATION SIGNALS, SPECIES-SPECIFIC ANATOMY
 *
 * poseToLook(s, t) is imported UNCHANGED from owl.ts — the Owl file is never
 * opened or modified by this module. Every character reads the same generic
 * pose numbers (bounce, tilt, armL/armR, eyeOpen, pupilX/Y, browL/R, mouth,
 * mouthOpen, legPhase, shake, sweat, spin), but each of the nine characters
 * below has its own independently-modeled silhouette, proportions, posture,
 * and secondary motion — never a recolored copy of another character's body.
 * ------------------------------------------------------------------------- */
export type CharacterLook = OwlLook;
export { poseToLook };

const TAU = Math.PI * 2;

/** Draw any built-in character at (x, y) = feet position, `size` = body height. */
export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  id: CharacterId,
  x: number,
  y: number,
  size: number,
  look: CharacterLook,
) {
  switch (id) {
    case "owl":
      drawOwl(ctx, x, y, size, look); // APPROVED — never touched, never regenerated
      return;
    case "penguin":
      drawPenguin(ctx, x, y, size, look);
      return;
    case "panda":
      drawPanda(ctx, x, y, size, look);
      return;
    case "monkey":
      drawMonkey(ctx, x, y, size, look);
      return;
    case "bear":
      drawBear(ctx, x, y, size, look);
      return;
    case "bunny":
      drawBunny(ctx, x, y, size, look);
      return;
    case "brain":
      drawBrain(ctx, x, y, size, look);
      return;
    case "egg":
      drawEgg(ctx, x, y, size, look);
      return;
    case "bulb":
      drawBulb(ctx, x, y, size, look);
      return;
  }
}

/* ============================== shared render helpers ============================== */
/* Low-level drawing utilities (gradients, shadows, eye/brow rendering) only —
 * not a shared body/anatomy template. Every skeleton, silhouette, head
 * shape, and limb layout below is independently modeled per character. */

function drawGroundShadow(ctx: CanvasRenderingContext2D, w: number, h: number, alpha = 0.18) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(0, 6, 0, 0, 6, w * 0.5);
  g.addColorStop(0, "#1b1033");
  g.addColorStop(1, "rgba(27,16,51,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 6, w * 0.5, h * 0.04, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** Soft dark wash where a limb/head visually tucks behind another form. */
function contactShadow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rot = 0,
  alpha = 0.16,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
  g.addColorStop(0, "#2a1810");
  g.addColorStop(1, "rgba(42,24,16,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, rot, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function topSheen(ctx: CanvasRenderingContext2D, top: number, height: number, spanW: number, alpha = 0.22) {
  const g = ctx.createLinearGradient(0, top, 0, top + height);
  g.addColorStop(0, `rgba(255,255,255,${alpha})`);
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(-spanW, top, spanW * 2, height);
}

function furFringe(
  ctx: CanvasRenderingContext2D,
  pathFn: () => void,
  color: string,
  width: number,
) {
  ctx.save();
  pathFn();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.globalAlpha = 0.5;
  ctx.stroke();
  ctx.restore();
}

function pawPad(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(cx, cy, r * 0.55, r * 0.42, 0, 0, TAU);
  ctx.fill();
  [-1, 0, 1].forEach((i) => {
    ctx.beginPath();
    ctx.ellipse(cx + i * r * 0.42, cy - r * 0.55, r * 0.16, r * 0.13, 0, 0, TAU);
    ctx.fill();
  });
  ctx.restore();
}

function drawExpressiveEyes(
  ctx: CanvasRenderingContext2D,
  exL: number,
  exR: number,
  eyeY: number,
  discR: number,
  look: CharacterLook,
  irisLight = "#5aa0e6",
  irisDark = "#1d2b52",
) {
  [exL, exR].forEach((ex) => {
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = "#2b1f4a";
    ctx.beginPath();
    ctx.ellipse(ex, eyeY + discR * 0.15, discR * 1.05, discR * 1.05, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    const wg = ctx.createRadialGradient(ex, eyeY - discR * 0.25, discR * 0.1, ex, eyeY, discR);
    wg.addColorStop(0, "#ffffff");
    wg.addColorStop(1, "#f1ede6");
    ctx.fillStyle = wg;
    ctx.beginPath();
    ctx.arc(ex, eyeY, discR, 0, TAU);
    ctx.fill();
  });

  const eyeR = discR * 0.6 * look.eyeScale;
  [exL, exR].forEach((ex) => {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.ellipse(ex, eyeY, eyeR, eyeR * 1.05 * look.eyeOpen, 0, 0, TAU);
    ctx.fill();
    if (look.eyeOpen > 0.3) {
      const px = ex + look.pupilX * eyeR * 0.7;
      const py = eyeY + look.pupilY * eyeR * 0.7;
      const ig = ctx.createRadialGradient(px, py, eyeR * 0.05, px, py, eyeR * 0.62);
      ig.addColorStop(0, irisLight);
      ig.addColorStop(0.7, irisDark);
      ig.addColorStop(1, "#000000");
      ctx.fillStyle = ig;
      ctx.beginPath();
      ctx.arc(px, py, eyeR * 0.62, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(px - eyeR * 0.22, py - eyeR * 0.26, eyeR * 0.2, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.arc(px + eyeR * 0.24, py + eyeR * 0.2, eyeR * 0.09, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.12)";
      ctx.lineWidth = eyeR * 0.14;
      ctx.beginPath();
      ctx.arc(ex, eyeY, eyeR * 1.02, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    } else {
      ctx.strokeStyle = "#3a2a20";
      ctx.lineWidth = discR * 0.12;
      ctx.beginPath();
      ctx.arc(ex, eyeY, eyeR * 0.9, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }
  });
}

function drawBrows(
  ctx: CanvasRenderingContext2D,
  exL: number,
  exR: number,
  browY: number,
  discR: number,
  look: CharacterLook,
  color: string,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = discR * 0.16;
  ctx.lineCap = "round";
  ([[exL, look.browL, -1] as const, [exR, look.browR, 1] as const]).forEach(([ex, brow, s]) => {
    const by = browY - brow * discR * 0.35;
    ctx.save();
    ctx.translate(ex, by);
    ctx.rotate(brow * s);
    ctx.beginPath();
    ctx.moveTo(-discR * 0.55, 0);
    ctx.quadraticCurveTo(0, -discR * 0.28, discR * 0.55, 0);
    ctx.stroke();
    ctx.restore();
  });
}

function cheekBlush(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, alpha = 0.4) {
  ctx.save();
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
  g.addColorStop(0, `rgba(255,141,161,${alpha})`);
  g.addColorStop(1, "rgba(255,141,161,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function noseShine(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.save();
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.3, cy - r * 0.3, r * 0.28, r * 0.18, -0.4, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/* =============================================================================
 * 🐧 PENGUIN — upright pear-shaped body (narrow shoulders, wide base), short
 * flippers, small feet, short neck. Waddle: hips sway, body leans into step.
 * ========================================================================== */

function drawPenguin(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, look: CharacterLook) {
  const w = size * 0.58;
  const h = size;

  ctx.save();
  ctx.translate(x + look.shakeX * size, y - look.bounce * size);
  ctx.rotate(look.tilt * 0.45 + look.spin);

  drawGroundShadow(ctx, w * 0.95, h);

  const waddle = Math.sin(look.legPhase);
  const hipSway = waddle * size * 0.035;
  const bodyLean = waddle * 0.06;

  const bodyBottomY = -size * 0.12;
  const bodyTopY = -h * 0.9;

  ctx.save();
  ctx.rotate(bodyLean);

  contactShadow(ctx, hipSway, -size * 0.03, w * 0.4, size * 0.05, 0, 0.14);

  [-1, 1].forEach((s) => {
    const fg = ctx.createLinearGradient(0, -size * 0.05, 0, size * 0.02);
    fg.addColorStop(0, "#f6b544");
    fg.addColorStop(1, "#c96a18");
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.ellipse(s * w * 0.2 + hipSway * 0.6, -size * 0.01, size * 0.09, size * 0.032, s * 0.08, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#e59622";
    [-1, 0, 1].forEach((toe) => {
      ctx.beginPath();
      ctx.ellipse(
        s * w * 0.2 + hipSway * 0.6 + toe * size * 0.022,
        size * 0.018,
        size * 0.018,
        size * 0.012,
        s * 0.1,
        0,
        TAU,
      );
      ctx.fill();
    });
  });

  const bodyPath = () => {
    ctx.beginPath();
    ctx.moveTo(hipSway - w * 0.16, bodyTopY + h * 0.06);
    ctx.bezierCurveTo(
      hipSway - w * 0.46, bodyTopY + h * 0.16,
      hipSway - w * 0.58, bodyBottomY - h * 0.42,
      hipSway - w * 0.52, bodyBottomY - h * 0.1,
    );
    ctx.bezierCurveTo(hipSway - w * 0.4, bodyBottomY + h * 0.04, hipSway - w * 0.18, bodyBottomY, hipSway, bodyBottomY);
    ctx.bezierCurveTo(hipSway + w * 0.18, bodyBottomY, hipSway + w * 0.4, bodyBottomY + h * 0.04, hipSway + w * 0.52, bodyBottomY - h * 0.1);
    ctx.bezierCurveTo(
      hipSway + w * 0.58, bodyBottomY - h * 0.42,
      hipSway + w * 0.46, bodyTopY + h * 0.16,
      hipSway + w * 0.16, bodyTopY + h * 0.06,
    );
    ctx.bezierCurveTo(hipSway + w * 0.1, bodyTopY - h * 0.05, hipSway - w * 0.1, bodyTopY - h * 0.05, hipSway - w * 0.16, bodyTopY + h * 0.06);
    ctx.closePath();
  };
  const grad = ctx.createLinearGradient(-w * 0.3, bodyTopY, w * 0.2, bodyBottomY);
  grad.addColorStop(0, "#526477");
  grad.addColorStop(0.32, "#293746");
  grad.addColorStop(0.72, "#17222d");
  grad.addColorStop(1, "#090f15");
  bodyPath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.save();
  bodyPath();
  ctx.clip();
  ctx.fillStyle = "#edf1f1";
  ctx.beginPath();
  ctx.moveTo(hipSway, bodyTopY + h * 0.2);
  ctx.bezierCurveTo(hipSway - w * 0.14, bodyTopY + h * 0.2, hipSway - w * 0.28, bodyTopY + h * 0.38, hipSway - w * 0.3, bodyBottomY - h * 0.08);
  ctx.bezierCurveTo(hipSway - w * 0.18, bodyBottomY + h * 0.01, hipSway + w * 0.18, bodyBottomY + h * 0.01, hipSway + w * 0.3, bodyBottomY - h * 0.08);
  ctx.bezierCurveTo(hipSway + w * 0.28, bodyTopY + h * 0.38, hipSway + w * 0.14, bodyTopY + h * 0.2, hipSway, bodyTopY + h * 0.2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(195,207,215,0.42)";
  ctx.beginPath();
  ctx.ellipse(hipSway + w * 0.12, bodyBottomY - h * 0.2, w * 0.12, h * 0.2, 0.2, 0, TAU);
  ctx.fill();
  ctx.restore();

  // A penguin's hood wraps around the crown and leaves the white cheeks exposed.
  const headCenterY = bodyTopY + h * 0.1;
  const hood = ctx.createRadialGradient(hipSway - w * 0.18, bodyTopY - h * 0.03, 0, hipSway, headCenterY, w * 0.58);
  hood.addColorStop(0, "#66798a");
  hood.addColorStop(0.45, "#263746");
  hood.addColorStop(1, "#0b131b");
  ctx.fillStyle = hood;
  ctx.beginPath();
  ctx.ellipse(hipSway, headCenterY, w * 0.47, h * 0.29, 0, Math.PI, TAU);
  ctx.fill();
  ctx.fillStyle = "rgba(249,250,247,0.92)";
  [-1, 1].forEach((s) => {
    ctx.beginPath();
    ctx.ellipse(hipSway + s * w * 0.18, bodyTopY + h * 0.18, w * 0.125, h * 0.16, s * 0.16, 0, TAU);
    ctx.fill();
  });

  ctx.save();
  bodyPath();
  ctx.clip();
  topSheen(ctx, bodyTopY, h * 0.4, w, 0.16);
  ctx.restore();

  furFringe(ctx, bodyPath, "rgba(255,255,255,0.3)", size * 0.012);

  const flapSwing = Math.sin(look.legPhase) * 0.22;
  const drawFlipper = (side: 1 | -1, angle: number) => {
    const sx = hipSway + side * w * 0.5;
    const sy = bodyTopY + h * 0.24;
    const len = size * 0.43;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(side * (0.15 + angle * 0.55) + flapSwing * side * -1);
    contactShadow(ctx, 0, len * 0.15, size * 0.09, size * 0.12, 0, 0.2);
    const fg = ctx.createLinearGradient(-size * 0.06, 0, size * 0.06, len);
    fg.addColorStop(0, "#344655");
    fg.addColorStop(0.45, "#182630");
    fg.addColorStop(1, "#070d12");
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-size * 0.055, 0);
    ctx.bezierCurveTo(-size * 0.13, len * 0.22, -size * 0.1, len * 0.8, -size * 0.025, len);
    ctx.quadraticCurveTo(0, len * 1.04, size * 0.025, len);
    ctx.bezierCurveTo(size * 0.1, len * 0.8, size * 0.13, len * 0.22, size * 0.055, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  drawFlipper(-1, look.armL);
  drawFlipper(1, look.armR);

  ctx.restore();

  const eyeY = bodyTopY + h * 0.07;
  const discR = size * 0.135;
  const eyeDX = w * 0.17;

  contactShadow(ctx, hipSway, eyeY + discR * 1.3, w * 0.32, size * 0.07, 0, 0.14);
  cheekBlush(ctx, hipSway - w * 0.26, eyeY + discR * 0.7, w * 0.06, h * 0.028, 0.4);
  cheekBlush(ctx, hipSway + w * 0.26, eyeY + discR * 0.7, w * 0.06, h * 0.028, 0.4);

  drawExpressiveEyes(ctx, hipSway - eyeDX, hipSway + eyeDX, eyeY, discR, look);
  drawBrows(ctx, hipSway - eyeDX, hipSway + eyeDX, eyeY - discR * 0.9, discR, look, "#161f2b");

  const beakW = size * 0.042;
  const my = eyeY + discR * 0.88;
  const bg = ctx.createLinearGradient(0, my - size * 0.02, 0, my + size * 0.02);
  bg.addColorStop(0, "#ffb35c");
  bg.addColorStop(1, "#e37f1d");
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.moveTo(hipSway - beakW, my);
  ctx.quadraticCurveTo(hipSway, my + size * (0.018 + 0.05 * look.mouthOpen), hipSway + beakW, my);
  ctx.quadraticCurveTo(hipSway, my - size * 0.022, hipSway - beakW, my);
  ctx.closePath();
  ctx.fill();
  noseShine(ctx, hipSway - beakW * 0.3, my - size * 0.006, beakW * 0.6);

  ctx.restore();
}

/* =============================================================================
 * 🐼 PANDA — chunky bear-anatomy body, large round head, round ears, black
 * eye patches, black arms/legs, cream face/torso, short muzzle, short tail.
 * ========================================================================== */

function drawPanda(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, look: CharacterLook) {
  ctx.save();
  ctx.translate(x + look.shakeX * size, y - look.bounce * size);
  ctx.rotate(look.tilt * 0.35 + look.spin * 0.8);

  drawGroundShadow(ctx, size * 0.7, size);

  const bodyR = size * 0.32;
  const bodyCY = -size * 0.42;
  const headR = size * 0.29;
  const headCY = -size * 0.82;

  const legLift = Math.sin(look.legPhase) * size * 0.018;
  [-1, 1].forEach((s, i) => {
    const lift = i === 0 ? legLift : -legLift;
    const lg = ctx.createRadialGradient(s * size * 0.19 - size * 0.03, -size * 0.07, size * 0.02, s * size * 0.19, -size * 0.04, size * 0.13);
    lg.addColorStop(0, "#333333");
    lg.addColorStop(1, "#111111");
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.ellipse(s * size * 0.19, -size * 0.045 + Math.abs(lift), size * 0.115, size * 0.09, 0, 0, TAU);
    ctx.fill();
    pawPad(ctx, s * size * 0.19, -size * 0.02 + Math.abs(lift), size * 0.09, "#3a3a3a");
  });

  contactShadow(ctx, 0, bodyCY + bodyR * 0.55, bodyR * 0.85, bodyR * 0.35, 0, 0.14);

  const bg = ctx.createRadialGradient(-bodyR * 0.35, bodyCY - bodyR * 0.4, bodyR * 0.1, bodyR * 0.1, bodyCY + bodyR * 0.2, bodyR * 1.4);
  bg.addColorStop(0, "#ffffff");
  bg.addColorStop(0.6, "#f2f2f2");
  bg.addColorStop(1, "#d8d8d8");
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.ellipse(0, bodyCY, bodyR * 1.02, bodyR, 0, 0, TAU);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, bodyCY, bodyR * 1.02, bodyR, 0, 0, TAU);
  ctx.clip();
  topSheen(ctx, bodyCY - bodyR, bodyR * 1.1, bodyR, 0.2);
  furFringe(
    ctx,
    () => ctx.ellipse(0, bodyCY, bodyR * 1.0, bodyR * 0.98, 0, 0, TAU),
    "rgba(0,0,0,0.05)",
    size * 0.02,
  );
  ctx.restore();

  const tg = ctx.createRadialGradient(-size * 0.01, bodyCY + bodyR * 0.85, 0, 0, bodyCY + bodyR * 0.9, size * 0.06);
  tg.addColorStop(0, "#3a3a3a");
  tg.addColorStop(1, "#1a1a1a");
  ctx.fillStyle = tg;
  ctx.beginPath();
  ctx.ellipse(0, bodyCY + bodyR * 0.9, size * 0.055, size * 0.045, 0, 0, TAU);
  ctx.fill();

  const drawArm = (side: 1 | -1, angle: number, handUp: number) => {
    const sx = side * bodyR * 0.85;
    const sy = bodyCY - bodyR * 0.1;
    const len = size * 0.24;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(side * (angle - 0.2));
    contactShadow(ctx, 0, -size * 0.02, size * 0.1, size * 0.08, 0, 0.18);
    const ag = ctx.createLinearGradient(-size * 0.06, 0, size * 0.06, len);
    ag.addColorStop(0, "#2b2b2b");
    ag.addColorStop(1, "#101010");
    ctx.strokeStyle = ag;
    ctx.lineWidth = size * 0.13;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, len);
    ctx.stroke();
    ctx.fillStyle = "#1f1f1f";
    ctx.beginPath();
    ctx.arc(0, len, size * (0.075 + handUp * 0.02), 0, TAU);
    ctx.fill();
    pawPad(ctx, 0, len, size * 0.07, "#4a4a4a");
    ctx.restore();
  };
  drawArm(-1, look.armL, look.handLUp);
  drawArm(1, look.armR, look.handRUp);

  contactShadow(ctx, 0, headCY + headR * 0.7, headR * 0.7, headR * 0.25, 0, 0.16);

  const hg = ctx.createRadialGradient(-headR * 0.3, headCY - headR * 0.35, headR * 0.08, 0, headCY, headR * 1.2);
  hg.addColorStop(0, "#ffffff");
  hg.addColorStop(1, "#eeeeee");
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.arc(0, headCY, headR, 0, TAU);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, headCY, headR, 0, TAU);
  ctx.clip();
  topSheen(ctx, headCY - headR, headR * 1.1, headR, 0.22);
  ctx.restore();

  [-1, 1].forEach((s) => {
    const eg = ctx.createRadialGradient(s * headR * 0.72 - headR * 0.1, headCY - headR * 0.9, 0, s * headR * 0.72, headCY - headR * 0.82, headR * 0.4);
    eg.addColorStop(0, "#3a3a3a");
    eg.addColorStop(1, "#111111");
    ctx.fillStyle = eg;
    ctx.beginPath();
    ctx.arc(s * headR * 0.72, headCY - headR * 0.82, headR * 0.38, 0, TAU);
    ctx.fill();
  });

  const eyeDX = headR * 0.4;
  const eyeY = headCY + headR * 0.04;
  [-1, 1].forEach((s) => {
    const pg = ctx.createRadialGradient(s * eyeDX - headR * 0.08, eyeY - headR * 0.1, 0, s * eyeDX, eyeY, headR * 0.42);
    pg.addColorStop(0, "#2e2e2e");
    pg.addColorStop(1, "#0c0c0c");
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.ellipse(s * eyeDX, eyeY, headR * 0.33, headR * 0.42, s * 0.35, 0, TAU);
    ctx.fill();
  });

  drawExpressiveEyes(ctx, -eyeDX, eyeDX, eyeY, headR * 0.22, look, "#8a6a4a", "#241a10");
  drawBrows(ctx, -eyeDX, eyeDX, eyeY - headR * 0.32, headR * 0.28, look, "#1f1f1f");
  cheekBlush(ctx, -headR * 0.55, eyeY + headR * 0.4, headR * 0.16, headR * 0.09);
  cheekBlush(ctx, headR * 0.55, eyeY + headR * 0.4, headR * 0.16, headR * 0.09);

  const muzzleCY = eyeY + headR * 0.4;
  const mg = ctx.createRadialGradient(0, muzzleCY - headR * 0.1, 0, 0, muzzleCY, headR * 0.35);
  mg.addColorStop(0, "#ffffff");
  mg.addColorStop(1, "#e9e9e9");
  ctx.fillStyle = mg;
  ctx.beginPath();
  ctx.ellipse(0, muzzleCY, headR * 0.32, headR * 0.23, 0, 0, TAU);
  ctx.fill();
  const ng = ctx.createRadialGradient(-headR * 0.02, muzzleCY - headR * 0.07, 0, 0, muzzleCY - headR * 0.05, headR * 0.08);
  ng.addColorStop(0, "#3a3a3a");
  ng.addColorStop(1, "#0a0a0a");
  ctx.fillStyle = ng;
  ctx.beginPath();
  ctx.ellipse(0, muzzleCY - headR * 0.05, headR * 0.075, headR * 0.05, 0, 0, TAU);
  ctx.fill();
  noseShine(ctx, -headR * 0.02, muzzleCY - headR * 0.06, headR * 0.05);
  ctx.strokeStyle = "#1f1f1f";
  ctx.lineWidth = headR * 0.05;
  ctx.lineCap = "round";
  ctx.beginPath();
  const mw = headR * (0.12 + look.mouthOpen * 0.08);
  ctx.moveTo(-mw, muzzleCY + headR * 0.07);
  ctx.quadraticCurveTo(0, muzzleCY + headR * (0.14 + look.mouthOpen * 0.18), mw, muzzleCY + headR * 0.07);
  ctx.stroke();

  ctx.restore();
}

/* =============================================================================
 * 🐵 BABY MONKEY — small rounded torso, proportionally LONG arms, long
 * expressive tail (drives its own secondary motion), monkey muzzle.
 * ========================================================================== */

function drawMonkey(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, look: CharacterLook) {
  const w = size * 0.55;

  ctx.save();
  ctx.translate(x + look.shakeX * size, y - look.bounce * size);
  ctx.rotate(look.tilt * 0.65 + look.spin);

  drawGroundShadow(ctx, size * 0.55, size, 0.16);

  const bodyR = size * 0.2;
  const bodyCY = -size * 0.4;
  const headR = size * 0.24;
  const headCY = -size * 0.72;

  const legPh = look.legPhase * 1.3;
  [-1, 1].forEach((s, i) => {
    const swing = Math.sin(legPh + i * Math.PI) * size * 0.05;
    const lg = ctx.createLinearGradient(0, bodyCY, 0, 0);
    lg.addColorStop(0, "#a8703a");
    lg.addColorStop(1, "#7a5222");
    ctx.strokeStyle = lg;
    ctx.lineWidth = size * 0.06;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(s * w * 0.16, bodyCY + bodyR * 0.7);
    ctx.lineTo(s * w * 0.16 + swing, 0);
    ctx.stroke();
    ctx.fillStyle = "#e8c99e";
    ctx.beginPath();
    ctx.ellipse(s * w * 0.16 + swing, size * 0.008, size * 0.045, size * 0.024, 0, 0, TAU);
    ctx.fill();
    pawPad(ctx, s * w * 0.16 + swing, size * 0.012, size * 0.035, "#c9a876");
  });

  const tension = look.shake + look.sweat * 0.6;
  const tailSway = Math.sin(look.legPhase * 1.8 + look.spin * 6) * (0.4 + tension * 0.9);
  const tg = ctx.createLinearGradient(w * 0.18, bodyCY, w * 0.6, bodyCY - size * 0.35);
  tg.addColorStop(0, "#a8703a");
  tg.addColorStop(1, "#7a5222");
  ctx.strokeStyle = tg;
  ctx.lineWidth = size * 0.05;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(w * 0.18, bodyCY + bodyR * 0.3);
  ctx.bezierCurveTo(
    w * 0.6, bodyCY + size * (0.15 + tailSway * 0.13),
    w * 0.55, bodyCY - size * (0.15 - tailSway * 0.2),
    w * (0.32 + tailSway * 0.32), bodyCY - size * (0.35 + Math.abs(tailSway) * 0.16),
  );
  ctx.stroke();

  const drawArm = (side: 1 | -1, angle: number, handUp: number) => {
    const sx = side * bodyR * 0.95;
    const sy = bodyCY - bodyR * 0.1;
    const len = size * 0.42;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(side * (angle - 0.1));
    contactShadow(ctx, 0, -size * 0.01, size * 0.08, size * 0.06, 0, 0.15);
    const ag = ctx.createLinearGradient(-size * 0.05, 0, size * 0.05, len);
    ag.addColorStop(0, "#a8703a");
    ag.addColorStop(1, "#7a5222");
    ctx.strokeStyle = ag;
    ctx.lineWidth = size * 0.065;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, len);
    ctx.stroke();
    ctx.fillStyle = "#f6dfc0";
    ctx.beginPath();
    ctx.arc(0, len, size * (0.045 + handUp * 0.015), 0, TAU);
    ctx.fill();
    pawPad(ctx, 0, len, size * 0.04, "#d9bd91");
    ctx.restore();
  };
  drawArm(-1, look.armL, look.handLUp);
  drawArm(1, look.armR, look.handRUp);

  contactShadow(ctx, 0, bodyCY + bodyR * 0.7, bodyR * 0.7, bodyR * 0.3, 0, 0.14);
  const bg = ctx.createRadialGradient(-bodyR * 0.3, bodyCY - bodyR * 0.3, bodyR * 0.1, 0, bodyCY, bodyR * 1.3);
  bg.addColorStop(0, "#c48c4c");
  bg.addColorStop(1, "#8f5f2d");
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.ellipse(0, bodyCY, bodyR * 0.9, bodyR, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#f6dfc0";
  ctx.beginPath();
  ctx.ellipse(0, bodyCY + bodyR * 0.15, bodyR * 0.55, bodyR * 0.62, 0, 0, TAU);
  ctx.fill();

  contactShadow(ctx, 0, headCY + headR * 0.65, headR * 0.6, headR * 0.2, 0, 0.15);
  const hg = ctx.createRadialGradient(-headR * 0.3, headCY - headR * 0.3, headR * 0.08, 0, headCY, headR * 1.2);
  hg.addColorStop(0, "#c48c4c");
  hg.addColorStop(1, "#8f5f2d");
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.arc(0, headCY, headR, 0, TAU);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, headCY, headR, 0, TAU);
  ctx.clip();
  topSheen(ctx, headCY - headR, headR * 0.9, headR, 0.18);
  ctx.restore();

  [-1, 1].forEach((s) => {
    const eg = ctx.createRadialGradient(s * headR * 0.95 - headR * 0.06, headCY - headR * 0.1, 0, s * headR * 0.95, headCY - headR * 0.05, headR * 0.32);
    eg.addColorStop(0, "#e8c99e");
    eg.addColorStop(1, "#c9a876");
    ctx.fillStyle = eg;
    ctx.beginPath();
    ctx.arc(s * headR * 0.95, headCY - headR * 0.05, headR * 0.3, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#b58a58";
    ctx.beginPath();
    ctx.arc(s * headR * 0.95, headCY - headR * 0.05, headR * 0.17, 0, TAU);
    ctx.fill();
  });

  const muzzleCY = headCY + headR * 0.34;
  const mg = ctx.createRadialGradient(0, muzzleCY - headR * 0.15, 0, 0, muzzleCY, headR * 0.5);
  mg.addColorStop(0, "#fbe9cc");
  mg.addColorStop(1, "#e8c99e");
  ctx.fillStyle = mg;
  ctx.beginPath();
  ctx.ellipse(0, muzzleCY, headR * 0.48, headR * 0.34, 0, 0, TAU);
  ctx.fill();

  const eyeDX = headR * 0.34;
  const eyeY = headCY - headR * 0.03;
  drawExpressiveEyes(ctx, -eyeDX, eyeDX, eyeY, headR * 0.21, look, "#6b4226", "#241a10");
  drawBrows(ctx, -eyeDX, eyeDX, eyeY - headR * 0.3, headR * 0.26, look, "#5a3a1e");
  cheekBlush(ctx, -headR * 0.48, muzzleCY - headR * 0.02, headR * 0.13, headR * 0.08);
  cheekBlush(ctx, headR * 0.48, muzzleCY - headR * 0.02, headR * 0.13, headR * 0.08);

  const ng = ctx.createRadialGradient(-headR * 0.01, muzzleCY - headR * 0.07, 0, 0, muzzleCY - headR * 0.05, headR * 0.06);
  ng.addColorStop(0, "#9a6a44");
  ng.addColorStop(1, "#5a3a1e");
  ctx.fillStyle = ng;
  ctx.beginPath();
  ctx.ellipse(0, muzzleCY - headR * 0.05, headR * 0.055, headR * 0.04, 0, 0, TAU);
  ctx.fill();
  noseShine(ctx, -headR * 0.015, muzzleCY - headR * 0.06, headR * 0.04);
  ctx.strokeStyle = "#7a4a25";
  ctx.lineWidth = headR * 0.05;
  ctx.lineCap = "round";
  ctx.beginPath();
  const mw = headR * (0.14 + look.mouthOpen * 0.1);
  ctx.moveTo(-mw, muzzleCY + headR * 0.11);
  ctx.quadraticCurveTo(0, muzzleCY + headR * (0.18 + look.mouthOpen * 0.2), mw, muzzleCY + headR * 0.11);
  ctx.stroke();

  ctx.restore();
}

/* =============================================================================
 * 🐻 BABY BEAR — broad, heavy, wide-set body (sturdiest of all), thick short
 * arms/legs, large rounded paws, small ears, short muzzle, low bounce.
 * ========================================================================== */

function drawBear(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, look: CharacterLook) {
  ctx.save();
  ctx.translate(x + look.shakeX * size, y - look.bounce * size * 0.7);
  ctx.rotate(look.tilt * 0.3 + look.spin * 0.7);

  drawGroundShadow(ctx, size * 0.85, size, 0.2);

  const bodyRX = size * 0.37;
  const bodyRY = size * 0.34;
  const bodyCY = -size * 0.38;
  const headR = size * 0.27;
  const headCY = -size * 0.76;

  const stomp = Math.abs(Math.sin(look.legPhase * 0.8)) * size * 0.015;
  [-1, 1].forEach((s) => {
    const lg = ctx.createRadialGradient(s * size * 0.22 - size * 0.04, -size * 0.08, size * 0.02, s * size * 0.22, -size * 0.04, size * 0.15);
    lg.addColorStop(0, "#c17f4a");
    lg.addColorStop(1, "#8a5a30");
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.ellipse(s * size * 0.22, -size * 0.045 + stomp, size * 0.13, size * 0.1, 0, 0, TAU);
    ctx.fill();
    pawPad(ctx, s * size * 0.22, -size * 0.02 + stomp, size * 0.1, "#6f4423");
  });

  contactShadow(ctx, 0, bodyCY + bodyRY * 0.55, bodyRX * 0.85, bodyRY * 0.35, 0, 0.16);
  const bg = ctx.createRadialGradient(-bodyRX * 0.35, bodyCY - bodyRY * 0.4, bodyRX * 0.1, bodyRX * 0.1, bodyCY + bodyRY * 0.2, bodyRX * 1.4);
  bg.addColorStop(0, "#e0a468");
  bg.addColorStop(0.6, "#c17f4a");
  bg.addColorStop(1, "#8a5a30");
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.ellipse(0, bodyCY, bodyRX, bodyRY, 0, 0, TAU);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, bodyCY, bodyRX, bodyRY, 0, 0, TAU);
  ctx.clip();
  topSheen(ctx, bodyCY - bodyRY, bodyRY * 1.1, bodyRX, 0.2);
  ctx.restore();

  const belg = ctx.createRadialGradient(0, bodyCY + bodyRY * 0.05, 0, 0, bodyCY + bodyRY * 0.15, bodyRX * 0.6);
  belg.addColorStop(0, "#fbe6c6");
  belg.addColorStop(1, "#e6c79a");
  ctx.fillStyle = belg;
  ctx.beginPath();
  ctx.ellipse(0, bodyCY + bodyRY * 0.15, bodyRX * 0.55, bodyRY * 0.58, 0, 0, TAU);
  ctx.fill();

  const drawArm = (side: 1 | -1, angle: number, handUp: number) => {
    const sx = side * bodyRX * 0.95;
    const sy = bodyCY - bodyRY * 0.05;
    const len = size * 0.2;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(side * (angle - 0.25));
    contactShadow(ctx, 0, -size * 0.02, size * 0.11, size * 0.09, 0, 0.18);
    const ag = ctx.createLinearGradient(-size * 0.075, 0, size * 0.075, len);
    ag.addColorStop(0, "#c17f4a");
    ag.addColorStop(1, "#8a5a30");
    ctx.strokeStyle = ag;
    ctx.lineWidth = size * 0.15;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, len);
    ctx.stroke();
    ctx.fillStyle = "#a8683a";
    ctx.beginPath();
    ctx.arc(0, len, size * (0.09 + handUp * 0.02), 0, TAU);
    ctx.fill();
    pawPad(ctx, 0, len, size * 0.085, "#6f4423");
    ctx.restore();
  };
  drawArm(-1, look.armL, look.handLUp);
  drawArm(1, look.armR, look.handRUp);

  const tg = ctx.createRadialGradient(-size * 0.01, bodyCY + bodyRY * 0.8, 0, 0, bodyCY + bodyRY * 0.85, size * 0.06);
  tg.addColorStop(0, "#c17f4a");
  tg.addColorStop(1, "#8a5a30");
  ctx.fillStyle = tg;
  ctx.beginPath();
  ctx.ellipse(0, bodyCY + bodyRY * 0.85, size * 0.05, size * 0.04, 0, 0, TAU);
  ctx.fill();

  contactShadow(ctx, 0, headCY + headR * 0.7, headR * 0.65, headR * 0.24, 0, 0.16);
  const hg = ctx.createRadialGradient(-headR * 0.35, headCY - headR * 0.4, headR * 0.08, 0, headCY, headR * 1.2);
  hg.addColorStop(0, "#e0a468");
  hg.addColorStop(1, "#c17f4a");
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.arc(0, headCY, headR, 0, TAU);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, headCY, headR, 0, TAU);
  ctx.clip();
  topSheen(ctx, headCY - headR, headR * 1.1, headR, 0.2);
  ctx.restore();

  [-1, 1].forEach((s) => {
    const eg = ctx.createRadialGradient(s * headR * 0.7 - headR * 0.08, headCY - headR * 0.95, 0, s * headR * 0.7, headCY - headR * 0.85, headR * 0.28);
    eg.addColorStop(0, "#c17f4a");
    eg.addColorStop(1, "#8a5a30");
    ctx.fillStyle = eg;
    ctx.beginPath();
    ctx.arc(s * headR * 0.7, headCY - headR * 0.85, headR * 0.25, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#f0d3a8";
    ctx.beginPath();
    ctx.arc(s * headR * 0.7, headCY - headR * 0.85, headR * 0.13, 0, TAU);
    ctx.fill();
  });

  const eyeDX = headR * 0.4;
  const eyeY = headCY - headR * 0.02;
  drawExpressiveEyes(ctx, -eyeDX, eyeDX, eyeY, headR * 0.22, look, "#6b4226", "#241a10");
  drawBrows(ctx, -eyeDX, eyeDX, eyeY - headR * 0.3, headR * 0.28, look, "#5a3a22");
  cheekBlush(ctx, -headR * 0.55, eyeY + headR * 0.4, headR * 0.16, headR * 0.09);
  cheekBlush(ctx, headR * 0.55, eyeY + headR * 0.4, headR * 0.16, headR * 0.09);

  const muzzleCY = eyeY + headR * 0.42;
  const mg = ctx.createRadialGradient(0, muzzleCY - headR * 0.12, 0, 0, muzzleCY, headR * 0.38);
  mg.addColorStop(0, "#fbe6c6");
  mg.addColorStop(1, "#e6c79a");
  ctx.fillStyle = mg;
  ctx.beginPath();
  ctx.ellipse(0, muzzleCY, headR * 0.35, headR * 0.24, 0, 0, TAU);
  ctx.fill();
  const ng = ctx.createRadialGradient(-headR * 0.02, muzzleCY - headR * 0.07, 0, 0, muzzleCY - headR * 0.05, headR * 0.07);
  ng.addColorStop(0, "#7a4a2a");
  ng.addColorStop(1, "#3d2412");
  ctx.fillStyle = ng;
  ctx.beginPath();
  ctx.ellipse(0, muzzleCY - headR * 0.05, headR * 0.07, headR * 0.05, 0, 0, TAU);
  ctx.fill();
  noseShine(ctx, -headR * 0.02, muzzleCY - headR * 0.06, headR * 0.045);
  ctx.strokeStyle = "#5a3a22";
  ctx.lineWidth = headR * 0.05;
  ctx.lineCap = "round";
  ctx.beginPath();
  const mw = headR * (0.12 + look.mouthOpen * 0.08);
  ctx.moveTo(-mw, muzzleCY + headR * 0.07);
  ctx.quadraticCurveTo(0, muzzleCY + headR * (0.14 + look.mouthOpen * 0.18), mw, muzzleCY + headR * 0.07);
  ctx.stroke();

  ctx.restore();
}

/* =============================================================================
 * 🐰 BABY BUNNY — compact rabbit body, powerful hind legs, tiny front paws,
 * long expressive ears (major animation feature), hops rather than walks.
 * ========================================================================== */

function drawBunny(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, look: CharacterLook) {
  ctx.save();

  const hop = Math.max(0, Math.sin(look.legPhase)) * size * 0.06;
  ctx.translate(x + look.shakeX * size, y - look.bounce * size - hop);
  ctx.rotate(look.tilt * 0.5 + look.spin);

  const airborne = hop / (size * 0.06);
  drawGroundShadow(ctx, size * 0.4, size, 0.18 * (1 - airborne * 0.6));

  const bodyR = size * 0.24;
  const bodyCY = -size * 0.4;
  const headR = size * 0.27;
  const headCY = -size * 0.76;

  [-1, 1].forEach((s) => {
    const lg = ctx.createRadialGradient(s * size * 0.19 - size * 0.03, -size * 0.06, size * 0.02, s * size * 0.19, -size * 0.03, size * 0.15);
    lg.addColorStop(0, "#ffffff");
    lg.addColorStop(1, "#e2dde0");
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.ellipse(
      s * size * 0.19,
      -size * 0.03 * (1 - airborne * 0.5),
      size * (0.11 - airborne * 0.02),
      size * (0.15 - airborne * 0.05),
      0, 0, TAU,
    );
    ctx.fill();
  });
  [-1, 1].forEach((s) => {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.ellipse(s * size * 0.21, size * 0.02, size * 0.065, size * 0.024, 0, 0, TAU);
    ctx.fill();
    pawPad(ctx, s * size * 0.21, size * 0.024, size * 0.05, "#f0d8dd");
  });

  const drawArm = (side: 1 | -1, angle: number, handUp: number) => {
    const sx = side * bodyR * 0.85;
    const sy = bodyCY + bodyR * 0.2;
    const len = size * 0.14;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(side * (angle - 0.3));
    ctx.strokeStyle = "#f2f0f2";
    ctx.lineWidth = size * 0.06;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, len);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(0, len, size * (0.035 + handUp * 0.012), 0, TAU);
    ctx.fill();
    ctx.restore();
  };
  drawArm(-1, look.armL, look.handLUp);
  drawArm(1, look.armR, look.handRUp);

  contactShadow(ctx, 0, bodyCY + bodyR * 0.6, bodyR * 0.6, bodyR * 0.25, 0, 0.12);
  const bg = ctx.createRadialGradient(-bodyR * 0.3, bodyCY - bodyR * 0.3, bodyR * 0.1, 0, bodyCY, bodyR * 1.3);
  bg.addColorStop(0, "#ffffff");
  bg.addColorStop(1, "#e6e2e5");
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.ellipse(0, bodyCY, bodyR * 0.82, bodyR, 0, 0, TAU);
  ctx.fill();
  furFringe(
    ctx,
    () => ctx.ellipse(0, bodyCY, bodyR * 0.8, bodyR * 0.98, 0, 0, TAU),
    "rgba(255,255,255,0.7)",
    size * 0.014,
  );

  const tg = ctx.createRadialGradient(-size * 0.01, bodyCY + bodyR * 0.8, 0, 0, bodyCY + bodyR * 0.85, size * 0.06);
  tg.addColorStop(0, "#ffffff");
  tg.addColorStop(1, "#e2dde0");
  ctx.fillStyle = tg;
  ctx.beginPath();
  ctx.arc(0, bodyCY + bodyR * 0.85, size * 0.05, 0, TAU);
  ctx.fill();

  contactShadow(ctx, 0, headCY + headR * 0.65, headR * 0.55, headR * 0.2, 0, 0.13);
  const hg = ctx.createRadialGradient(-headR * 0.3, headCY - headR * 0.35, headR * 0.08, 0, headCY, headR * 1.2);
  hg.addColorStop(0, "#ffffff");
  hg.addColorStop(1, "#e9e5e8");
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.arc(0, headCY, headR, 0, TAU);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, headCY, headR, 0, TAU);
  ctx.clip();
  topSheen(ctx, headCY - headR, headR * 1.1, headR, 0.2);
  ctx.restore();

  const alarmed = look.eyeScale > 1.2;
  const unsure = look.mouth === "wavy";
  const earLift = alarmed ? 1.15 : unsure ? 0.2 : 0.75;
  [-1, 1].forEach((s) => {
    ctx.save();
    ctx.translate(s * headR * 0.48, headCY - headR * 0.68);
    const wig = Math.sin(look.legPhase * 0.4 + s) * 0.04;
    ctx.rotate(s * (0.08 - earLift * 0.2) + wig);
    contactShadow(ctx, 0, -size * 0.05, size * 0.05, size * 0.15, 0, 0.08);
    const g = ctx.createLinearGradient(-size * 0.03, 0, size * 0.03, -size * 0.55);
    g.addColorStop(0, "#f2f0f2");
    g.addColorStop(1, "#ffffff");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, -size * 0.3 * (0.5 + earLift * 0.5), size * 0.062, size * 0.32, 0, 0, TAU);
    ctx.fill();
    const ig = ctx.createLinearGradient(0, 0, 0, -size * 0.5);
    ig.addColorStop(0, "#ffc9d6");
    ig.addColorStop(1, "#ffe4ea");
    ctx.fillStyle = ig;
    ctx.beginPath();
    ctx.ellipse(0, -size * 0.3 * (0.5 + earLift * 0.5), size * 0.03, size * 0.22, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  });

  const eyeDX = headR * 0.36;
  const eyeY = headCY + headR * 0.03;
  drawExpressiveEyes(ctx, -eyeDX, eyeDX, eyeY, headR * 0.23, look, "#8a5a3a", "#2a1a10");
  drawBrows(ctx, -eyeDX, eyeDX, eyeY - headR * 0.32, headR * 0.27, look, "#c9a0aa");
  cheekBlush(ctx, -headR * 0.55, eyeY + headR * 0.4, headR * 0.16, headR * 0.09, 0.45);
  cheekBlush(ctx, headR * 0.55, eyeY + headR * 0.4, headR * 0.16, headR * 0.09, 0.45);

  const noseCY = eyeY + headR * 0.38;
  const ng = ctx.createRadialGradient(-headR * 0.01, noseCY - headR * 0.02, 0, 0, noseCY, headR * 0.06);
  ng.addColorStop(0, "#ffb0c0");
  ng.addColorStop(1, "#ff7f96");
  ctx.fillStyle = ng;
  ctx.beginPath();
  ctx.ellipse(0, noseCY, headR * 0.06, headR * 0.045, 0, 0, TAU);
  ctx.fill();
  noseShine(ctx, -headR * 0.01, noseCY - headR * 0.015, headR * 0.03);
  ctx.strokeStyle = "#ff8fa3";
  ctx.lineWidth = headR * 0.045;
  ctx.lineCap = "round";
  ctx.beginPath();
  const mw = headR * (0.1 + look.mouthOpen * 0.07);
  ctx.moveTo(-mw, noseCY + headR * 0.1);
  ctx.quadraticCurveTo(0, noseCY + headR * (0.16 + look.mouthOpen * 0.15), mw, noseCY + headR * 0.1);
  ctx.stroke();

  ctx.restore();
}

/* =============================================================================
 * 🧠 BRAIN — a stylized cerebrum silhouette (NOT a head, NOT a blob): two
 * hemispheres divided by a central longitudinal fissure, with rounded folds
 * (gyri) traced across the surface. Sits on tiny legs, gestures with small
 * arms. Thinking pose = hand to temple instead of the shared rig's default
 * point/wave gesture.
 * ========================================================================== */

function drawBrain(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, look: CharacterLook) {
  const w = size * 0.86;
  const h = size * 0.82;

  ctx.save();
  ctx.translate(x + look.shakeX * size, y - look.bounce * size);
  ctx.rotate(look.tilt * 0.4 + look.spin * 0.7);

  drawGroundShadow(ctx, w * 0.8, size, 0.16);

  const bodyCY = -size * 0.46;

  const legLift = Math.sin(look.legPhase) * size * 0.02;
  [-1, 1].forEach((s, i) => {
    const lift = i === 0 ? legLift : -legLift;
    ctx.strokeStyle = "#e8879a";
    ctx.lineWidth = size * 0.06;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(s * w * 0.18, bodyCY + h * 0.42);
    ctx.lineTo(s * w * 0.18, -size * 0.03 + Math.abs(lift));
    ctx.stroke();
    const fg = ctx.createRadialGradient(s * w * 0.18 - size * 0.02, -size * 0.05, size * 0.01, s * w * 0.18, -size * 0.02, size * 0.07);
    fg.addColorStop(0, "#ffb7c4");
    fg.addColorStop(1, "#e8879a");
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.ellipse(s * w * 0.18, -size * 0.01 + Math.abs(lift), size * 0.065, size * 0.032, 0, 0, TAU);
    ctx.fill();
  });

  contactShadow(ctx, 0, bodyCY + h * 0.5, w * 0.55, h * 0.2, 0, 0.14);

  const isThinking = look.mouth === "wavy" && look.browL > 0.15;
  const drawArm = (side: 1 | -1, angle: number, handUp: number) => {
    const sx = side * w * 0.46;
    const sy = bodyCY + h * 0.02;
    ctx.save();
    ctx.translate(sx, sy);
    if (isThinking) {
      ctx.rotate(side * 1.35);
      const len = size * 0.22;
      ctx.strokeStyle = "#e8879a";
      ctx.lineWidth = size * 0.055;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, len);
      ctx.stroke();
      ctx.fillStyle = "#ffb7c4";
      ctx.beginPath();
      ctx.arc(0, len, size * 0.045, 0, TAU);
      ctx.fill();
    } else {
      ctx.rotate(side * (angle - 0.2));
      const len = size * 0.24;
      ctx.strokeStyle = "#e8879a";
      ctx.lineWidth = size * 0.055;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, len);
      ctx.stroke();
      ctx.fillStyle = "#ffb7c4";
      ctx.beginPath();
      ctx.arc(0, len, size * (0.045 + handUp * 0.014), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  };
  drawArm(-1, look.armL, look.handLUp);
  drawArm(1, look.armR, look.handRUp);

  const brainPath = () => {
    ctx.beginPath();
    ctx.moveTo(-w * 0.035, bodyCY - h * 0.5);
    ctx.bezierCurveTo(-w * 0.2, bodyCY - h * 0.59, -w * 0.43, bodyCY - h * 0.5, -w * 0.49, bodyCY - h * 0.26);
    ctx.bezierCurveTo(-w * 0.56, bodyCY - h * 0.16, -w * 0.5, bodyCY - h * 0.02, -w * 0.43, bodyCY + h * 0.08);
    ctx.bezierCurveTo(-w * 0.51, bodyCY + h * 0.18, -w * 0.43, bodyCY + h * 0.31, -w * 0.32, bodyCY + h * 0.33);
    ctx.bezierCurveTo(-w * 0.36, bodyCY + h * 0.46, -w * 0.2, bodyCY + h * 0.51, -w * 0.065, bodyCY + h * 0.4);
    ctx.bezierCurveTo(-w * 0.03, bodyCY + h * 0.47, -w * 0.01, bodyCY + h * 0.47, 0, bodyCY + h * 0.42);
    ctx.bezierCurveTo(w * 0.06, bodyCY + h * 0.51, w * 0.23, bodyCY + h * 0.46, w * 0.31, bodyCY + h * 0.34);
    ctx.bezierCurveTo(w * 0.43, bodyCY + h * 0.3, w * 0.51, bodyCY + h * 0.17, w * 0.44, bodyCY + h * 0.07);
    ctx.bezierCurveTo(w * 0.53, bodyCY - h * 0.03, w * 0.55, bodyCY - h * 0.17, w * 0.48, bodyCY - h * 0.29);
    ctx.bezierCurveTo(w * 0.39, bodyCY - h * 0.51, w * 0.2, bodyCY - h * 0.57, w * 0.035, bodyCY - h * 0.5);
    ctx.bezierCurveTo(w * 0.015, bodyCY - h * 0.57, -w * 0.015, bodyCY - h * 0.57, -w * 0.035, bodyCY - h * 0.5);
    ctx.closePath();
  };

  const grad = ctx.createRadialGradient(-w * 0.2, bodyCY - h * 0.3, size * 0.05, w * 0.05, bodyCY + h * 0.1, w * 0.75);
  grad.addColorStop(0, "#ffb7c4");
  grad.addColorStop(0.55, "#f28aa0");
  grad.addColorStop(1, "#d85f7e");
  brainPath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.save();
  brainPath();
  ctx.clip();

  ctx.strokeStyle = "rgba(150,50,80,0.4)";
  ctx.lineWidth = size * 0.018;
  const foldSets: Array<[number, number, number, number]> = [
    [-1, -0.36, -0.08, 0.02], [-1, -0.2, 0.16, -0.03], [-1, -0.03, 0.3, 0.04],
    [-1, 0.14, 0.18, -0.04], [-1, 0.28, 0.38, 0.03],
    [1, -0.34, 0.04, -0.03], [1, -0.16, 0.2, 0.04], [1, 0.02, 0.34, -0.02],
    [1, 0.17, 0.15, 0.04], [1, 0.29, 0.36, -0.03],
  ];
  foldSets.forEach(([side, fy, curve, wave]) => {
    ctx.beginPath();
    const baseX = side * w * (0.2 + Math.abs(wave) * 0.4);
    const y0 = bodyCY + h * fy;
    ctx.moveTo(baseX - side * w * 0.16, y0 - h * 0.04);
    ctx.bezierCurveTo(
      baseX + side * w * (0.02 + wave), y0 + h * (0.08 + curve * 0.08),
      baseX + side * w * (0.12 - wave), y0 - h * (0.08 - curve * 0.04),
      baseX + side * w * 0.2, y0 - h * 0.03,
    );
    ctx.stroke();
  });

  topSheen(ctx, bodyCY - h * 0.56, h * 0.5, w * 0.6, 0.22);
  ctx.restore();

  furFringe(ctx, brainPath, "rgba(255,255,255,0.2)", size * 0.014);

  const eyeY = bodyCY + h * 0.08;
  const discR = size * 0.135;
  const eyeDX = w * 0.19;

  cheekBlush(ctx, -w * 0.32, eyeY + discR * 0.75, w * 0.06, h * 0.03, 0.4);
  cheekBlush(ctx, w * 0.32, eyeY + discR * 0.75, w * 0.06, h * 0.03, 0.4);

  drawExpressiveEyes(ctx, -eyeDX, eyeDX, eyeY, discR, look, "#6aa6e8", "#1a2c52");
  drawBrows(ctx, -eyeDX, eyeDX, eyeY - discR * 0.95, discR, look, "#b04565");

  const my = eyeY + discR * 1.05;
  ctx.strokeStyle = "#a83a58";
  ctx.lineWidth = size * 0.022;
  ctx.lineCap = "round";
  ctx.beginPath();
  const mw = size * (0.05 + look.mouthOpen * 0.03);
  ctx.moveTo(-mw, my);
  ctx.quadraticCurveTo(0, my + size * (0.04 + look.mouthOpen * 0.08), mw, my);
  ctx.stroke();
  if (look.mouthOpen > 0.3) {
    ctx.fillStyle = "#7a2842";
    ctx.beginPath();
    ctx.ellipse(0, my + size * 0.03 * look.mouthOpen, size * 0.018, size * 0.014 * look.mouthOpen, 0, 0, TAU);
    ctx.fill();
  }

  if (look.mouth === "big" && look.mouthOpen > 0.4) {
    [[-0.3, -0.5], [0.34, -0.42], [0, -0.58]].forEach(([sx, sy]) => {
      ctx.save();
      ctx.translate(w * sx, bodyCY + h * sy);
      ctx.fillStyle = "#fff6c8";
      for (let i = 0; i < 4; i++) {
        ctx.rotate((Math.PI / 2) * i + look.spin * 3);
        ctx.beginPath();
        ctx.moveTo(0, -size * 0.028);
        ctx.lineTo(size * 0.006, 0);
        ctx.lineTo(0, size * 0.028);
        ctx.lineTo(-size * 0.006, 0);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    });
  }

  ctx.restore();
}

/* =============================================================================
 * 🥚 ROUNDED EGG — a true 3D egg silhouette (narrow rounded top, wider
 * rounded base), NOT a flat oval: shading and a wide sheen band imply volume
 * the way a glossy ceramic egg would catch light.
 * ========================================================================== */

function drawEgg(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, look: CharacterLook) {
  const wTop = size * 0.42;
  const wBottom = size * 0.58;
  const h = size * 0.92;

  ctx.save();
  ctx.translate(x + look.shakeX * size, y - look.bounce * size);
  ctx.rotate(look.tilt * 0.4 + look.spin * 0.6);

  drawGroundShadow(ctx, wBottom * 1.5, size, 0.18);

  const bodyCY = -h * 0.52;
  const bottomY = -size * 0.02;
  const topY = bodyCY - h * 0.5;

  const legLift = Math.sin(look.legPhase) * size * 0.018;
  [-1, 1].forEach((s, i) => {
    const lift = i === 0 ? legLift : -legLift;
    ctx.strokeStyle = "#f0c948";
    ctx.lineWidth = size * 0.05;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(s * wBottom * 0.32, bottomY - size * 0.02);
    ctx.lineTo(s * wBottom * 0.32, -size * 0.01 + Math.abs(lift));
    ctx.stroke();
    ctx.fillStyle = "#ffdb70";
    ctx.beginPath();
    ctx.ellipse(s * wBottom * 0.32, size * 0.005 + Math.abs(lift), size * 0.06, size * 0.026, 0, 0, TAU);
    ctx.fill();
  });

  contactShadow(ctx, 0, bottomY + size * 0.02, wBottom * 0.7, size * 0.06, 0, 0.15);

  const drawArm = (side: 1 | -1, angle: number, handUp: number) => {
    const sx = side * wBottom * 0.62;
    const sy = bodyCY + h * 0.12;
    const len = size * 0.18;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(side * (angle - 0.25));
    ctx.strokeStyle = "#f0c948";
    ctx.lineWidth = size * 0.05;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, len);
    ctx.stroke();
    ctx.fillStyle = "#ffdb70";
    ctx.beginPath();
    ctx.arc(0, len, size * (0.04 + handUp * 0.012), 0, TAU);
    ctx.fill();
    ctx.restore();
  };
  drawArm(-1, look.armL, look.handLUp);
  drawArm(1, look.armR, look.handRUp);

  const eggPath = () => {
    ctx.beginPath();
    ctx.moveTo(0, topY);
    ctx.bezierCurveTo(wTop * 0.92, topY + h * 0.06, wBottom * 0.98, bodyCY + h * 0.18, wBottom, bottomY - h * 0.02);
    ctx.bezierCurveTo(wBottom * 0.98, bottomY + h * 0.14, -wBottom * 0.98, bottomY + h * 0.14, -wBottom, bottomY - h * 0.02);
    ctx.bezierCurveTo(-wBottom * 0.98, bodyCY + h * 0.18, -wTop * 0.92, topY + h * 0.06, 0, topY);
    ctx.closePath();
  };

  const grad = ctx.createRadialGradient(-wBottom * 0.25, bodyCY - h * 0.3, size * 0.04, wBottom * 0.05, bodyCY + h * 0.15, wBottom * 1.4);
  grad.addColorStop(0, "#fffdf5");
  grad.addColorStop(0.55, "#fff3d6");
  grad.addColorStop(1, "#ffe2a0");
  eggPath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.save();
  eggPath();
  ctx.clip();
  const sheen = ctx.createLinearGradient(-wBottom * 0.5, topY, wBottom * 0.1, bottomY);
  sheen.addColorStop(0, "rgba(255,255,255,0.75)");
  sheen.addColorStop(0.35, "rgba(255,255,255,0.15)");
  sheen.addColorStop(0.5, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(-wBottom, topY, wBottom * 2, h);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.beginPath();
  ctx.ellipse(-wTop * 0.35, topY + h * 0.18, wTop * 0.22, h * 0.1, -0.3, 0, TAU);
  ctx.fill();
  const baseOcc = ctx.createLinearGradient(0, bottomY - h * 0.18, 0, bottomY);
  baseOcc.addColorStop(0, "rgba(200,140,40,0)");
  baseOcc.addColorStop(1, "rgba(200,140,40,0.18)");
  ctx.fillStyle = baseOcc;
  ctx.fillRect(-wBottom, bottomY - h * 0.18, wBottom * 2, h * 0.18);
  ctx.restore();

  ctx.strokeStyle = "rgba(210,160,60,0.4)";
  ctx.lineWidth = size * 0.014;
  eggPath();
  ctx.stroke();

  const eyeY = bodyCY + h * 0.14;
  const discR = size * 0.13;
  const eyeDX = wBottom * 0.32;

  cheekBlush(ctx, -eyeDX * 1.4, eyeY + discR * 0.75, wBottom * 0.1, h * 0.03, 0.4);
  cheekBlush(ctx, eyeDX * 1.4, eyeY + discR * 0.75, wBottom * 0.1, h * 0.03, 0.4);

  drawExpressiveEyes(ctx, -eyeDX, eyeDX, eyeY, discR, look, "#7fcf8a", "#1c3d24");
  drawBrows(ctx, -eyeDX, eyeDX, eyeY - discR * 0.95, discR, look, "#d9a840");

  const my = eyeY + discR * 1.05;
  ctx.strokeStyle = "#d9873a";
  ctx.lineWidth = size * 0.02;
  ctx.lineCap = "round";
  ctx.beginPath();
  const mw = size * (0.045 + look.mouthOpen * 0.025);
  ctx.moveTo(-mw, my);
  ctx.quadraticCurveTo(0, my + size * (0.035 + look.mouthOpen * 0.07), mw, my);
  ctx.stroke();

  if (look.sweat > 0) {
    ctx.fillStyle = `rgba(96,190,255,${0.85 * look.sweat})`;
    ctx.beginPath();
    ctx.ellipse(wBottom * 0.72, bodyCY - h * 0.1, size * 0.02, size * 0.03, 0, 0, TAU);
    ctx.fill();
  }

  ctx.restore();
}

/* =============================================================================
 * 💡 BRIGHT BULB — a glossy glass bulb silhouette (rounded dome tapering to
 * a narrower neck) sitting on a metal screw-thread base, with a warm glowing
 * filament visible inside that doubles as a smiling mouth shape. Warm
 * sunshine-yellow glass, soft radiating glow, and little light-ray sparkles
 * that pulse brighter during excitement/celebration.
 * ========================================================================== */

function drawBulb(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, look: CharacterLook) {
  const w = size * 0.68;
  const h = size * 0.88;

  ctx.save();
  ctx.translate(x + look.shakeX * size, y - look.bounce * size);
  ctx.rotate(look.tilt * 0.4 + look.spin * 0.6);

  drawGroundShadow(ctx, w * 1.1, size, 0.18);

  const glowPulse = 0.6 + 0.4 * Math.sin(look.legPhase * 1.4 + look.spin * 2);

  const glowAlpha = 0.22 + glowPulse * 0.18 + (look.mouthOpen > 0.5 ? 0.15 : 0);
  ctx.save();
  ctx.globalAlpha = glowAlpha;
  const halo = ctx.createRadialGradient(0, -h * 0.35, size * 0.05, 0, -h * 0.3, w * 1.4);
  halo.addColorStop(0, "#fff3b0");
  halo.addColorStop(1, "rgba(255,243,176,0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, -h * 0.3, w * 1.4, 0, TAU);
  ctx.fill();
  ctx.restore();

  const bottomY = -size * 0.02;
  const baseTopY = bottomY - h * 0.16;
  const bodyCY = -h * 0.5;
  const topY = bodyCY - h * 0.46;

  const legLift = Math.sin(look.legPhase) * size * 0.02;
  [-1, 1].forEach((s, i) => {
    const lift = i === 0 ? legLift : -legLift;
    ctx.strokeStyle = "#c9a24a";
    ctx.lineWidth = size * 0.05;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(s * w * 0.22, bottomY);
    ctx.lineTo(s * w * 0.22, -size * 0.01 + Math.abs(lift));
    ctx.stroke();
    ctx.fillStyle = "#e8c463";
    ctx.beginPath();
    ctx.ellipse(s * w * 0.22, size * 0.005 + Math.abs(lift), size * 0.06, size * 0.026, 0, 0, TAU);
    ctx.fill();
  });

  contactShadow(ctx, 0, baseTopY + h * 0.03, w * 0.5, size * 0.05, 0, 0.16);

  const drawArm = (side: 1 | -1, angle: number, handUp: number) => {
    const sx = side * w * 0.5;
    const sy = bodyCY + h * 0.1;
    const len = size * 0.18;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(side * (angle - 0.25));
    ctx.strokeStyle = "#e8c463";
    ctx.lineWidth = size * 0.05;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, len);
    ctx.stroke();
    ctx.fillStyle = "#fff0a8";
    ctx.beginPath();
    ctx.arc(0, len, size * (0.04 + handUp * 0.012), 0, TAU);
    ctx.fill();
    ctx.restore();
  };
  drawArm(-1, look.armL, look.handLUp);
  drawArm(1, look.armR, look.handRUp);

  const baseW = w * 0.42;
  const baseH = h * 0.18;
  const baseGrad = ctx.createLinearGradient(-baseW, baseTopY, baseW, bottomY);
  baseGrad.addColorStop(0, "#b8b8bc");
  baseGrad.addColorStop(0.5, "#8a8a90");
  baseGrad.addColorStop(1, "#6a6a70");
  ctx.fillStyle = baseGrad;
  ctx.beginPath();
  ctx.moveTo(-baseW, baseTopY);
  ctx.lineTo(baseW, baseTopY);
  ctx.lineTo(baseW * 0.75, bottomY - baseH * 0.15);
  ctx.quadraticCurveTo(0, bottomY, -baseW * 0.75, bottomY - baseH * 0.15);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = size * 0.012;
  for (let i = 1; i <= 3; i++) {
    const ty = baseTopY + (baseH * i) / 4;
    const tw = baseW * (1 - i * 0.06);
    ctx.beginPath();
    ctx.moveTo(-tw, ty);
    ctx.lineTo(tw, ty);
    ctx.stroke();
  }

  const bulbPath = () => {
    ctx.beginPath();
    ctx.moveTo(-w * 0.32, baseTopY + h * 0.02);
    ctx.bezierCurveTo(-w * 0.62, baseTopY - h * 0.14, -w * 0.62, bodyCY - h * 0.1, -w * 0.5, bodyCY - h * 0.28);
    ctx.bezierCurveTo(-w * 0.36, bodyCY - h * 0.5, -w * 0.16, topY, 0, topY);
    ctx.bezierCurveTo(w * 0.16, topY, w * 0.36, bodyCY - h * 0.5, w * 0.5, bodyCY - h * 0.28);
    ctx.bezierCurveTo(w * 0.62, bodyCY - h * 0.1, w * 0.62, baseTopY - h * 0.14, w * 0.32, baseTopY + h * 0.02);
    ctx.closePath();
  };

  const glass = ctx.createRadialGradient(-w * 0.25, bodyCY - h * 0.3, size * 0.06, w * 0.05, bodyCY, w * 1.1);
  glass.addColorStop(0, "#fffde8");
  glass.addColorStop(0.45, "#fff3b0");
  glass.addColorStop(1, "#ffd75e");
  bulbPath();
  ctx.fillStyle = glass;
  ctx.fill();

  ctx.save();
  bulbPath();
  ctx.clip();
  topSheen(ctx, topY, h * 0.55, w, 0.3);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.beginPath();
  ctx.ellipse(-w * 0.28, bodyCY - h * 0.32, w * 0.16, h * 0.14, -0.3, 0, TAU);
  ctx.fill();
  ctx.save();
  ctx.globalAlpha = 0.25 + glowPulse * 0.2;
  const innerGlow = ctx.createRadialGradient(0, bodyCY + h * 0.12, size * 0.02, 0, bodyCY + h * 0.12, w * 0.55);
  innerGlow.addColorStop(0, "#ffe98a");
  innerGlow.addColorStop(1, "rgba(255,233,138,0)");
  ctx.fillStyle = innerGlow;
  ctx.beginPath();
  ctx.arc(0, bodyCY + h * 0.12, w * 0.55, 0, TAU);
  ctx.fill();
  ctx.restore();
  ctx.restore();

  furFringe(ctx, bulbPath, "rgba(255,255,255,0.25)", size * 0.012);

  ctx.save();
  ctx.globalAlpha = 0.55 + glowPulse * 0.35;
 
  ctx.lineWidth = size * 0.018;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-w * 0.12, bodyCY + h * 0.3);
  ctx.lineTo(-w * 0.04, bodyCY + h * 0.16);
  ctx.lineTo(w * 0.04, bodyCY + h * 0.3);
  ctx.lineTo(w * 0.12, bodyCY + h * 0.16);
  ctx.stroke();
  ctx.restore();

  const raysOn = look.mouth === "big" || glowPulse > 0.75;
  if (raysOn) {
    const rayAlpha = look.mouthOpen > 0.4 ? 0.85 : 0.4 + glowPulse * 0.3;
    ctx.save();
    ctx.globalAlpha = rayAlpha;
    ctx.strokeStyle = "#ffd75e";
    ctx.lineWidth = size * 0.02;
    ctx.lineCap = "round";
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + look.spin * 2;
      const r1 = w * 0.72;
      const r2 = w * 0.9;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r1, bodyCY - h * 0.1 + Math.sin(a) * r1 * 0.7);
      ctx.lineTo(Math.cos(a) * r2, bodyCY - h * 0.1 + Math.sin(a) * r2 * 0.7);
      ctx.stroke();
    }
    ctx.restore();
  }

  const eyeY = bodyCY + h * 0.02;
  const discR = size * 0.13;
  const eyeDX = w * 0.28;

  cheekBlush(ctx, -w * 0.42, eyeY + discR * 0.7, w * 0.09, h * 0.03, 0.42);
  cheekBlush(ctx, w * 0.42, eyeY + discR * 0.7, w * 0.09, h * 0.03, 0.42);

  drawExpressiveEyes(ctx, -eyeDX, eyeDX, eyeY, discR, look, "#6aa6e8", "#1a2c52");
  drawBrows(ctx, -eyeDX, eyeDX, eyeY - discR * 0.95, discR, look, "#d9a13a");

  const my = eyeY + discR * 1.02;
  ctx.strokeStyle = "#d9873a";
  ctx.lineWidth = size * 0.02;
  ctx.lineCap = "round";
  ctx.beginPath();
  const mw = size * (0.05 + look.mouthOpen * 0.03);
  ctx.moveTo(-mw, my);
  ctx.quadraticCurveTo(0, my + size * (0.04 + look.mouthOpen * 0.08), mw, my);
  ctx.stroke();
  if (look.mouthOpen > 0.3) {
    ctx.fillStyle = "#a8632a";
    ctx.beginPath();
    ctx.ellipse(0, my + size * 0.03 * look.mouthOpen, size * 0.018, size * 0.014 * look.mouthOpen, 0, 0, TAU);
    ctx.fill();
  }

  ctx.restore();
}