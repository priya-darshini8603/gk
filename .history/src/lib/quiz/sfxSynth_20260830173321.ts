/**
 * Pure oscillator/noise SFX scheduling, shared between:
 *  - AudioEngine.sfx() — live playback during preview & narration capture
 *  - export.ts's offline renderer — instant SFX synthesis for beats that
 *    carry no narration, so export doesn't have to sit through a real-time
 *    wait just to "hear" a beep.
 *
 * Both call the same code against a BaseAudioContext (AudioContext and
 * OfflineAudioContext both implement it), so the sound is guaranteed
 * identical in both places.
 */

export type SfxName =
  | "board"
  | "pop"
  | "point"
  | "tick"
  | "final"
  | "correct"
  | "confetti"
  | "cheer";

interface ToneSpec {
  freq: number;
  dur: number;
  type: OscillatorType;
  gain: number;
  delay: number;
  slideTo?: number;
}

interface NoiseSpec {
  dur: number;
  gain: number;
  delay: number;
}

function spec(name: SfxName): { tones: ToneSpec[]; noises: NoiseSpec[] } {
  switch (name) {
    case "board":
      return {
        tones: [{ freq: 320, dur: 0.25, type: "sine", gain: 0.4, delay: 0, slideTo: 780 }],
        noises: [],
      };
    case "pop":
      return {
        tones: [{ freq: 660, dur: 0.12, type: "triangle", gain: 0.35, delay: 0, slideTo: 980 }],
        noises: [],
      };
    case "point":
      return {
        tones: [{ freq: 880, dur: 0.09, type: "sine", gain: 0.3, delay: 0, slideTo: 1240 }],
        noises: [],
      };
    case "tick":
      return {
        tones: [{ freq: 520, dur: 0.09, type: "square", gain: 0.18, delay: 0 }],
        noises: [],
      };
    case "final":
      return {
        tones: [{ freq: 300, dur: 0.4, type: "sawtooth", gain: 0.28, delay: 0, slideTo: 120 }],
        noises: [],
      };
    case "correct":
      return {
        tones: [523, 659, 784, 1046].map((f, i) => ({
          freq: f,
          dur: 0.28,
          type: "triangle" as OscillatorType,
          gain: 0.36,
          delay: i * 0.09,
        })),
        noises: [],
      };
    case "confetti":
      return { tones: [], noises: [{ dur: 0.5, gain: 0.18, delay: 0 }] };
    case "cheer":
      return {
        tones: [784, 988, 1175].map((f, i) => ({
          freq: f,
          dur: 0.5,
          type: "sine" as OscillatorType,
          gain: 0.24,
          delay: i * 0.12,
        })),
        noises: [{ dur: 0.7, gain: 0.1, delay: 0 }],
      };
  }
}

function scheduleTone(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t: ToneSpec,
  timeOffset: number,
  volume: number,
) {
  const t0 = timeOffset + t.delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();

  osc.type = t.type;
  osc.frequency.setValueAtTime(t.freq, t0);
  if (t.slideTo) osc.frequency.exponentialRampToValueAtTime(t.slideTo, t0 + t.dur);

  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, t.gain * volume), t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + t.dur);

  osc.connect(g).connect(dest);
  osc.start(t0);
  osc.stop(t0 + t.dur + 0.05);
}

function scheduleNoise(
  ctx: BaseAudioContext,
  dest: AudioNode,
  n: NoiseSpec,
  timeOffset: number,
  volume: number,
) {
  const frames = Math.max(1, Math.round(ctx.sampleRate * n.dur));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const d = buf.getChannelData(0);

  for (let i = 0; i < d.length; i++) {
    d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  }

  const src = ctx.createBufferSource();
  src.buffer = buf;

  const g = ctx.createGain();
  g.gain.value = n.gain * volume;

  src.connect(g).connect(dest);
  src.start(timeOffset + n.delay);
}

/**
 * Schedule one named SFX onto `dest`, starting at `timeOffset` — either a
 * real ctx.currentTime-relative offset for live playback, or an arbitrary
 * timestamp inside an OfflineAudioContext buffer for offline rendering.
 */
export function scheduleSfx(
  ctx: BaseAudioContext,
  dest: AudioNode,
  name: SfxName,
  timeOffset: number,
  volume = 1,
) {
  const { tones, noises } = spec(name);
  tones.forEach((t) => scheduleTone(ctx, dest, t, timeOffset, volume));
  noises.forEach((n) => scheduleNoise(ctx, dest, n, timeOffset, volume));
}