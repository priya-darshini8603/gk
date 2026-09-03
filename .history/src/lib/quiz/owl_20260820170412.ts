import type { RenderState } from "./timeline";

/* Stylized realistic owl with a graduation cap, drawn procedurally so that
 * preview and export share one character definition. */

export interface OwlLook {
  bounce: number;
  tilt: number;
  armL: number; // shoulder angle in radians (0 = down)
  armR: number;
  handLUp: number;
  handRUp: number;
  eyeOpen: number;
  eyeScale: number;
  pupilX: number;
  pupilY: number;
  browL: number;
  browR: number;
  mouth: "smile" | "big" | "o" | "small" | "wavy" | "grin";
  mouthOpen: number;
  sweat: number;
  shakeX: number;
  legPhase: number;
  spin: number;
}

const TAU = Math.PI * 2;

export function poseToLook(s: RenderState, t: number): OwlLook {
  const idleB = Math.sin(t * 3.1) * 0.5 + 0.5;
  const blink = Math.sin(t * 1.7) > 0.985 || Math.sin(t * 2.9 + 1.3) > 0.99 ? 0.1 : 1;
  const look: OwlLook = {
    bounce: idleB * 0.02,
    tilt: Math.sin(t * 1.4) * 0.03,
    armL: 0.25 + Math.sin(t * 2.4) * 0.06,
    armR: 0.25 + Math.sin(t * 2.4 + 1) * 0.06,
    handLUp: 0,
    handRUp: 0,
    eyeOpen: blink,
    eyeScale: 1,
    pupilX: 0,
    pupilY: 0,
    browL: 0,
    browR: 0,
    mouth: "smile",
    mouthOpen: 0,
    sweat: s.sweat,
    shakeX: s.shake ? Math.sin(t * 34) * s.shake * 0.012 : 0,
    legPhase: 0,
    spin: 0,
  };

  switch (s.lookAt) {
    case "viewer":
      look.pupilX = Math.sin(t * 0.7) * 0.08;
      break;
    case "board":
      look.pupilX = -0.45;
      break;
    case "up":
      look.pupilY = -0.4;
      look.pupilX = -0.2;
      break;
    case "A":
      look.pupilX = -0.5;
      look.pupilY = -0.15;
      break;
    case "B":
      look.pupilX = -0.3;
      look.pupilY = -0.15;
      break;
    case "C":
      look.pupilX = -0.5;
      look.pupilY = 0.25;
      break;
    case "D":
      look.pupilX = -0.3;
      look.pupilY = 0.25;
      break;
  }

  switch (s.pose) {
    case "walk":
      look.legPhase = t * 9;
      look.bounce = Math.abs(Math.sin(t * 9)) * 0.05;
      look.armL = 0.5 + Math.sin(t * 9) * 0.5;
      look.armR = 0.5 - Math.sin(t * 9) * 0.5;
      break;
    case "wave":
      look.armR = 2.3 + Math.sin(t * 9) * 0.35;
      look.handRUp = 1;
      look.mouth = "big";
      look.bounce = Math.abs(Math.sin(t * 4)) * 0.035;
      break;
    case "point-board":
    case "point-option":
      look.armR = 1.75;
      look.handRUp = 1;
      look.mouth = "small";
      look.browL = -0.1;
      look.bounce = Math.abs(Math.sin(t * 4.2)) * 0.02;
      break;
    case "think":
      look.armR = 2.05;
      look.handRUp = 1;
      look.browL = 0.28;
      look.browR = 0.14;
      look.mouth = "wavy";
      look.pupilY = -0.35;
      break;
    case "confident":
      look.armL = 1.35;
      look.armR = 1.35;
      look.mouth = "grin";
      look.tilt = 0.09;
      look.bounce = Math.abs(Math.sin(t * 3.4)) * 0.03;
      break;
    case "unsure":
      look.browL = -0.26;
      look.browR = -0.26;
      look.eyeScale = 1.12;
      look.mouth = "wavy";
      look.legPhase = t * 12;
      break;
    case "nervous":
      look.armL = 1.9;
      look.armR = 1.9;
      look.handLUp = 1;
      look.handRUp = 1;
      look.browL = -0.3;
      look.browR = -0.3;
      look.eyeScale = 1.2;
      look.mouth = "wavy";
      break;
    case "shocked":
      look.armL = 2.7;
      look.armR = 2.7;
      look.handLUp = 1;
      look.handRUp = 1;
      look.eyeScale = 1.6;
      look.browL = -0.45;
      look.browR = -0.45;
      look.mouth = "o";
      look.mouthOpen = 1;
      look.bounce = Math.abs(Math.sin(t * 12)) * 0.05;
      break;
    case "celebrate":
      look.armL = 2.55 + Math.sin(t * 10) * 0.25;
      look.armR = 2.55 - Math.sin(t * 10) * 0.25;
      look.handLUp = 1;
      look.handRUp = 1;
      look.mouth = "big";
      look.mouthOpen = 0.6;
      look.bounce = Math.abs(Math.sin(t * 7)) * 0.1;
      look.spin = Math.sin(t * 3) * 0.08;
      break;
    case "clap": {
      const c = Math.abs(Math.sin(t * 11));
      look.armL = 1.5 + c * 0.4;
      look.armR = 1.5 + c * 0.4;
      look.handLUp = 1;
      look.handRUp = 1;
      look.mouth = "big";
      look.bounce = Math.abs(Math.sin(t * 5.5)) * 0.05;
      break;
    }
    default:
      look.mouth = "smile";
  }

  if (s.speaking) {
    const v = (Math.sin(t * 17) + Math.sin(t * 26.4) * 0.6) * 0.5 + 0.5;
    look.mouthOpen = Math.max(look.mouthOpen, 0.15 + v * 0.75);
    look.mouth = look.mouth === "smile" ? "big" : look.mouth;
    look.browL += Math.sin(t * 5) * 0.06;
    look.browR += Math.sin(t * 5 + 0.7) * 0.06;
  }

  if (s.reaction === "curious") look.tilt += 0.13;
  if (s.reaction === "shy") look.tilt -= 0.1;
  if (s.reaction === "sleepy") look.eyeOpen = Math.min(look.eyeOpen, 0.5);
  return look;
}


/** Draw the owl. (x, y) is the point where the feet touch the floor. */
export function drawOwl(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number, // body height
  look: OwlLook,
) {
  const w = size * 0.8;
  const h = size;
  ctx.save();
  ctx.translate(x + look.shakeX * size, y - look.bounce * size);
  ctx.rotate(look.tilt * 0.6 + look.spin);

  // ground shadow
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = "#1b1033";
  ctx.beginPath();
  ctx.ellipse(0, 6, w * 0.55, h * 0.05, 0, 0, TAU);
  ctx.fill();
  ctx.restore();

  const bodyCY = -h * 0.5 - size * 0.09;
  const legLen = size * 0.11;
  const legSwing = Math.sin(look.legPhase) * size * 0.05;

  /* ---------------------------- legs and feet ---------------------------- */
  const drawLeg = (dx: number, swing: number) => {
    ctx.strokeStyle = "#f5a623";
    ctx.lineWidth = size * 0.045;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(dx, -legLen);
    ctx.lineTo(dx + swing * 0.5, 0);
    ctx.stroke();
    // three toes
    ctx.strokeStyle = "#ffb03a";
    ctx.lineWidth = size * 0.032;
    const fx = dx + swing * 0.8;
    [-1, 0, 1].forEach((i) => {
      ctx.beginPath();
      ctx.moveTo(fx, -size * 0.008);
      ctx.lineTo(fx + i * size * 0.055, size * 0.004);
      ctx.stroke();
    });
  };
  drawLeg(-w * 0.17, legSwing);
  drawLeg(w * 0.17, -legSwing);

  /* -------------------------------- wings -------------------------------- */
  // Wings hug the body's curve instead of sticking out as flat panels.
  const drawWing = (side: 1 | -1, angle: number) => {
    const sx = side * w * 0.42;
    const sy = bodyCY - h * 0.06;
    const len = size * 0.36;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(side * (angle - 0.1));
    const g = ctx.createLinearGradient(-side * len * 0.1, 0, side * len * 0.35, len);
    g.addColorStop(0, "#a9825c");
    g.addColorStop(0.55, "#76543e");
    g.addColorStop(1, "#3f2d25");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -len * 0.1);
    // outer edge bulges away from the body, then curls back in at the tip
    ctx.bezierCurveTo(
      side * len * 0.46,
      len * 0.1,
      side * len * 0.4,
      len * 0.62,
      side * len * 0.13,
      len * 0.95,
    );
    // inner edge follows the body contour back up to the shoulder
    ctx.bezierCurveTo(
      -side * len * 0.02,
      len * 0.7,
      -side * len * 0.12,
      len * 0.32,
      0,
      -len * 0.1,
    );
    ctx.closePath();
    ctx.fill();
    // soft layered flight feathers
    ctx.strokeStyle = "rgba(232,205,163,0.4)";
    ctx.lineWidth = size * 0.007;
    ctx.lineCap = "round";
    for (let i = 0; i < 3; i++) {
      const f = 0.42 + i * 0.16;
      ctx.beginPath();
      ctx.moveTo(side * len * 0.06, len * f);
      ctx.quadraticCurveTo(side * len * 0.26, len * (f + 0.1), side * len * 0.14, len * (f + 0.24));
      ctx.stroke();
    }
    // top shoulder highlight blends the wing into the body
    ctx.fillStyle = "rgba(224,194,148,0.2)";
    ctx.beginPath();
    ctx.ellipse(side * len * 0.12, len * 0.12, len * 0.14, len * 0.2, side * 0.5, 0, TAU);
    ctx.fill();
    ctx.restore();
  };

  /* -------------------------------- body --------------------------------- */
  // One cohesive silhouette: rounded head flowing into a fuller chest that
  // tapers toward the feet, with a touch of asymmetry so it never reads flat.
  const bodyPath = () => {
    const top = bodyCY - h * 0.5;
    ctx.beginPath();
    ctx.moveTo(0, top);
    // left: head -> chest -> taper
    ctx.bezierCurveTo(-w * 0.34, top, -w * 0.47, bodyCY - h * 0.24, -w * 0.5, bodyCY - h * 0.02);
    ctx.bezierCurveTo(-w * 0.53, bodyCY + h * 0.2, -w * 0.42, bodyCY + h * 0.4, -w * 0.24, bodyCY + h * 0.47);
    ctx.bezierCurveTo(-w * 0.14, bodyCY + h * 0.51, w * 0.14, bodyCY + h * 0.51, w * 0.26, bodyCY + h * 0.46);
    // right: taper -> chest -> head
    ctx.bezierCurveTo(w * 0.45, bodyCY + h * 0.38, w * 0.55, bodyCY + h * 0.18, w * 0.51, bodyCY - h * 0.03);
    ctx.bezierCurveTo(w * 0.48, bodyCY - h * 0.26, w * 0.35, top, 0, top);
    ctx.closePath();
  };

  const grad = ctx.createRadialGradient(
    -w * 0.22,
    bodyCY - h * 0.26,
    size * 0.05,
    w * 0.04,
    bodyCY + h * 0.1,
    h * 0.68,
  );
  grad.addColorStop(0, "#b99a73");
  grad.addColorStop(0.45, "#806148");
  grad.addColorStop(1, "#3e2b24");
  ctx.save();
  bodyPath();
  ctx.fillStyle = grad;
  ctx.fill();

  // soft layered feather bands (clipped to the body so nothing floats outside)
  ctx.clip();
  ctx.strokeStyle = "rgba(235,213,178,0.22)";
  ctx.lineWidth = size * 0.012;
  ctx.lineCap = "round";
  for (let row = 0; row < 5; row++) {
    const ry = bodyCY - h * 0.08 + row * h * 0.11;
    const off = row % 2 ? w * 0.11 : 0;
    for (let c = -3; c <= 3; c++) {
      ctx.beginPath();
      ctx.arc(c * w * 0.22 + off, ry, size * 0.07, Math.PI * 1.08, Math.PI * 1.92);
      ctx.stroke();
    }
  }
  // head shading so the head reads as a separate volume on one body
  const headShade = ctx.createLinearGradient(0, bodyCY - h * 0.5, 0, bodyCY - h * 0.04);
  headShade.addColorStop(0, "rgba(255,255,255,0.18)");
  headShade.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = headShade;
  ctx.fillRect(-w, bodyCY - h * 0.55, w * 2, h * 0.55);
  // gentle occlusion under the head/chest transition
  const neckShade = ctx.createLinearGradient(0, bodyCY - h * 0.14, 0, bodyCY + h * 0.06);
  neckShade.addColorStop(0, "rgba(70,40,110,0.22)");
  neckShade.addColorStop(1, "rgba(70,40,110,0)");
  ctx.fillStyle = neckShade;
  ctx.fillRect(-w, bodyCY - h * 0.14, w * 2, h * 0.22);
  ctx.restore();

  // belly patch — teardrop chest that follows the body taper
  const belly = ctx.createLinearGradient(0, bodyCY - h * 0.06, 0, bodyCY + h * 0.44);
  belly.addColorStop(0, "#eee0c4");
  belly.addColorStop(1, "#b99a70");
  ctx.fillStyle = belly;
  ctx.beginPath();
  ctx.moveTo(0, bodyCY - h * 0.16);
  ctx.bezierCurveTo(-w * 0.33, bodyCY - h * 0.08, -w * 0.36, bodyCY + h * 0.26, -w * 0.12, bodyCY + h * 0.42);
  ctx.bezierCurveTo(-w * 0.03, bodyCY + h * 0.47, w * 0.05, bodyCY + h * 0.47, w * 0.14, bodyCY + h * 0.41);
  ctx.bezierCurveTo(w * 0.37, bodyCY + h * 0.24, w * 0.34, bodyCY - h * 0.08, 0, bodyCY - h * 0.16);
  ctx.closePath();
  ctx.save();
  ctx.fill();
  ctx.clip();
  // soft overlapping belly feather scallops
  ctx.strokeStyle = "rgba(92,61,40,0.35)";
  ctx.lineWidth = size * 0.008;
  for (let r = 0; r < 5; r++) {
    const ry = bodyCY - h * 0.04 + r * h * 0.09;
    const off = r % 2 ? w * 0.08 : 0;
    for (let c = -2; c <= 2; c++) {
      ctx.beginPath();
      ctx.arc(c * w * 0.16 + off, ry, size * 0.055, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    }
  }
  ctx.restore();

  // rim light along the upper-left silhouette
  ctx.save();
  bodyPath();
  ctx.clip();
  ctx.strokeStyle = "rgba(239,218,183,0.42)";
  ctx.lineWidth = size * 0.02;
  bodyPath();
  ctx.stroke();
  ctx.restore();

  drawWing(-1, look.armL);
  drawWing(1, look.armR);

  // ear tufts — soft feathered peaks that sit on the head curve
  [-1, 1].forEach((s) => {
    const tg = ctx.createLinearGradient(0, bodyCY - h * 0.58, 0, bodyCY - h * 0.34);
    tg.addColorStop(0, "#493329");
    tg.addColorStop(1, "#896849");
    ctx.fillStyle = tg;
    ctx.beginPath();
    ctx.moveTo(s * w * 0.3, bodyCY - h * 0.35);
    ctx.quadraticCurveTo(s * w * 0.44, bodyCY - h * 0.56, s * w * 0.2, bodyCY - h * 0.45);
    ctx.quadraticCurveTo(s * w * 0.24, bodyCY - h * 0.39, s * w * 0.3, bodyCY - h * 0.35);
    ctx.closePath();
    ctx.fill();
  });


  /* --------------------------------- face -------------------------------- */
  const eyeY = bodyCY - h * 0.11;
  const discR = size * 0.17;
  const eyeDX = w * 0.2;
  // The broad, heart-like facial disk is the strongest owl silhouette cue.
  const face = ctx.createRadialGradient(0, eyeY - discR * 0.35, discR * 0.2, 0, eyeY, discR * 2.4);
  face.addColorStop(0, "#f3e6ca");
  face.addColorStop(0.72, "#c9ad7f");
  face.addColorStop(1, "#806047");
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.moveTo(0, eyeY + discR * 2.1);
  ctx.bezierCurveTo(-w * 0.43, eyeY + discR * 1.2, -w * 0.4, eyeY - discR * 1.1, -w * 0.08, eyeY - discR * 1.65);
  ctx.quadraticCurveTo(0, eyeY - discR * 1.45, w * 0.08, eyeY - discR * 1.65);
  ctx.bezierCurveTo(w * 0.4, eyeY - discR * 1.1, w * 0.43, eyeY + discR * 1.2, 0, eyeY + discR * 2.1);
  ctx.fill();
  ctx.strokeStyle = "rgba(74,48,35,0.42)";
  ctx.lineWidth = size * 0.012;
  ctx.stroke();
  ctx.save();
  ctx.strokeStyle = "rgba(103,73,49,0.36)";
  ctx.lineWidth = size * 0.008;
  for (let i = -4; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(i * size * 0.055, eyeY - discR * 1.18);
    ctx.quadraticCurveTo(i * size * 0.07, eyeY, i * size * 0.035, eyeY + discR * 1.55);
    ctx.stroke();
  }
  ctx.restore();

  // cheeks
  ctx.fillStyle = "rgba(190,116,91,0.24)";
  [-1, 1].forEach((s) => {
    ctx.beginPath();
    ctx.ellipse(s * w * 0.34, eyeY + discR * 0.85, w * 0.08, h * 0.04, 0, 0, TAU);
    ctx.fill();
  });

  // eyes
  const eyeR = size * 0.095 * look.eyeScale;
  [-1, 1].forEach((s) => {
    const ex = s * eyeDX;
    ctx.fillStyle = "#f5ead4";
    ctx.beginPath();
    ctx.ellipse(ex, eyeY, eyeR, eyeR * 1.05 * look.eyeOpen, 0, 0, TAU);
    ctx.fill();
    if (look.eyeOpen > 0.3) {
      const px = ex + look.pupilX * eyeR * 0.7;
      const py = eyeY + look.pupilY * eyeR * 0.7;
      const ig = ctx.createRadialGradient(px, py, eyeR * 0.05, px, py, eyeR * 0.62);
      ig.addColorStop(0, "#f5d875");
      ig.addColorStop(0.55, "#b36a24");
      ig.addColorStop(1, "#3b2118");
      ctx.fillStyle = ig;
      ctx.beginPath();
      ctx.arc(px, py, eyeR * 0.62, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(px - eyeR * 0.2, py - eyeR * 0.24, eyeR * 0.2, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.arc(px + eyeR * 0.22, py + eyeR * 0.22, eyeR * 0.1, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      ctx.strokeStyle = "#634530";
      ctx.lineWidth = size * 0.012;
      ctx.beginPath();
      ctx.arc(ex, eyeY, eyeR * 0.9, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }
  });

  // eyebrows
  ctx.strokeStyle = "#4b3327";
  ctx.lineWidth = size * 0.02;
  ctx.lineCap = "round";
  [-1, 1].forEach((s) => {
    const ex = s * eyeDX;
    const brow = s === -1 ? look.browL : look.browR;
    const by = eyeY - discR * 0.95 - brow * size * 0.03;
    ctx.save();
    ctx.translate(ex, by);
    ctx.rotate(brow * s);
    ctx.beginPath();
    ctx.moveTo(-discR * 0.6, 0);
    ctx.quadraticCurveTo(0, -discR * 0.3, discR * 0.6, 0);
    ctx.stroke();
    ctx.restore();
  });

  // beak — the only mouth. Expression comes from its shape, never from extra
  // drawn lines around it.
  const my = eyeY + discR * 0.9;
  const open = look.mouthOpen;
  const beakW = size * 0.065;
  const wide = look.mouth === "big" || look.mouth === "grin" ? 1.12 : 1;
  const drop = look.mouth === "wavy" ? size * 0.006 : 0;

  // upper mandible
  const bg = ctx.createLinearGradient(0, my - size * 0.03, 0, my + size * 0.05);
  bg.addColorStop(0, "#d59b4a");
  bg.addColorStop(1, "#70401f");
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.moveTo(-beakW * wide, my - size * 0.01 + drop);
  ctx.quadraticCurveTo(0, my - size * 0.032 + drop, beakW * wide, my - size * 0.01 + drop);
  ctx.quadraticCurveTo(beakW * 0.4, my + size * 0.024 + drop, 0, my + size * 0.046 + drop);
  ctx.quadraticCurveTo(-beakW * 0.4, my + size * 0.024 + drop, -beakW * wide, my - size * 0.01 + drop);
  ctx.closePath();
  ctx.fill();
  // tiny top highlight for the 3D look
  ctx.fillStyle = "rgba(255,232,176,0.35)";
  ctx.beginPath();
  ctx.ellipse(-beakW * 0.22, my + drop, beakW * 0.28, size * 0.008, -0.35, 0, TAU);
  ctx.fill();

  if (look.mouth === "o" || open > 0.4) {
    // open beak: lower mandible drops
    ctx.fillStyle = "#4a2519";
    ctx.beginPath();
    ctx.moveTo(-beakW * 0.8, my + size * 0.008);
    ctx.quadraticCurveTo(0, my + size * (0.03 + 0.08 * open), beakW * 0.8, my + size * 0.008);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#d97762";
    ctx.beginPath();
    ctx.ellipse(0, my + size * 0.03 * open, size * 0.02, size * 0.015 * open, 0, 0, TAU);
    ctx.fill();
  }


  /* ----------------------------- graduation cap --------------------------- */
  ctx.save();
  ctx.translate(0, bodyCY - h * 0.4);
  ctx.fillStyle = "#3b2f63";
  ctx.beginPath();
  ctx.ellipse(0, 0, w * 0.28, h * 0.05, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#2c2350";
  ctx.beginPath();
  ctx.moveTo(-w * 0.44, -h * 0.03);
  ctx.lineTo(0, -h * 0.09);
  ctx.lineTo(w * 0.44, -h * 0.03);
  ctx.lineTo(0, h * 0.03);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#ffd166";
  ctx.lineWidth = size * 0.012;
  ctx.beginPath();
  ctx.moveTo(w * 0.18, -h * 0.045);
  ctx.quadraticCurveTo(w * 0.4, 0, w * 0.38, h * 0.09);
  ctx.stroke();
  ctx.fillStyle = "#ffd166";
  ctx.beginPath();
  ctx.arc(w * 0.38, h * 0.1, size * 0.022, 0, TAU);
  ctx.fill();
  ctx.restore();

  /* ------------------------------ sweat drops ----------------------------- */
  if (look.sweat > 0) {
    ctx.fillStyle = `rgba(96,190,255,${0.85 * look.sweat})`;
    [-1, 1].forEach((s, i) => {
      const dy = ((look.legPhase + i) % 1) * size * 0.05;
      ctx.beginPath();
      ctx.ellipse(
        s * w * 0.44,
        bodyCY - h * 0.22 + dy + i * size * 0.06,
        size * 0.022,
        size * 0.032,
        0,
        0,
        TAU,
      );
      ctx.fill();
    });
  }
  ctx.restore();
}
