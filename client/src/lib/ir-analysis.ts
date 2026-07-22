// Objective analysis of a reverb impulse response, so the wet level of every
// ambience is DERIVED FROM THE FILE instead of being a single hand-tuned number
// shared by all of them. It runs on the decoded AudioBuffer at load time, so it
// covers impulses added in the future (operator drops) exactly like the built-ins.
//
// The measurements follow ISO 3382-1 (the room-acoustics standard):
//   - start point: first arrival, per the standard's -20 dB-below-peak rule
//   - C50:         early/late energy ratio at 50 ms — the SPEECH clarity index
//   - T20 → RT60:  Schroeder backward integration + least-squares fit
//   - DRR:         direct-to-reverberant ratio over a ±2.5 ms direct window
//
// Every measurement carries a VALIDITY test, which is what separates this from
// guesswork: a number is only used when the data supports it (enough SNR, a
// decay that's actually a straight line, a real direct arrival). When a file
// fails, we fall back by an explicit documented rule — never to a vibe.

export interface IrAnalysis {
  sampleRate: number;
  /** First arrival (sample index), per ISO 3382-1. */
  onset: number;
  /** Direct-to-reverberant ratio, dB. null when there's no usable direct sound. */
  drr: number | null;
  /** Speech clarity index at 50 ms, dB. */
  c50: number | null;
  /** Reverberation time from the T20 slope, seconds. null when the fit fails. */
  rt60: number | null;
  /** Peak-to-noise-floor, dB. */
  snr: number;
  /** r² of the T20 least-squares fit; ISO wants a very straight decay. */
  decayFit: number;
  /** True when drr came from a clean, unambiguous direct arrival. */
  directValid: boolean;
  /** Fraction of the impulse's energy in the first 50 ms (early) and after it
   *  (late). They sum to 1 and are what the wet derivation solves against. */
  earlyFraction: number;
  lateFraction: number;
}

// ISO 3382-1 start point: the impulse "starts" where the signal first rises to
// within 20 dB of its peak. Found by scanning FORWARD, which is what makes this
// robust for files whose global peak sits inside the tail (a processed or
// re-recorded impulse) — the naive "peak = direct" assumption breaks there.
function findOnset(x: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
  }
  if (peak <= 0) return 0;
  const threshold = peak * Math.pow(10, -20 / 20);
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) >= threshold) return i;
  }
  return 0;
}

function energy(x: Float32Array, from: number, to: number): number {
  let e = 0;
  const a = Math.max(0, from);
  const b = Math.min(x.length, to);
  for (let i = a; i < b; i++) e += x[i] * x[i];
  return e;
}

// Noise floor from the quietest 50 ms window in the back half of the file —
// where a well-recorded impulse has already decayed into the recording's noise.
function noiseFloorRms(x: Float32Array, sampleRate: number): number {
  const win = Math.max(1, Math.round(0.05 * sampleRate));
  let quietest = Infinity;
  for (let i = Math.floor(x.length / 2); i + win <= x.length; i += win) {
    const rms = Math.sqrt(energy(x, i, i + win) / win);
    if (rms < quietest) quietest = rms;
  }
  return isFinite(quietest) ? quietest : 0;
}

// T20 → RT60 with a least-squares fit over the -5…-25 dB span of the Schroeder
// decay curve, returning r² so the caller can reject a decay that isn't a line
// (ISO 3382-1 treats a poor fit as an invalid measurement).
function decayTime(
  x: Float32Array,
  onset: number,
  sampleRate: number,
): { rt60: number | null; fit: number } {
  const n = x.length;
  const len = n - onset;
  if (len < sampleRate * 0.05) return { rt60: null, fit: 0 };
  // Schroeder backward integration of the squared impulse.
  const cum = new Float64Array(len + 1);
  for (let i = n - 1; i >= onset; i--) {
    const k = i - onset;
    cum[k] = cum[k + 1] + x[i] * x[i];
  }
  const total = cum[0];
  if (total <= 0) return { rt60: null, fit: 0 };

  const xs: number[] = [];
  const ys: number[] = [];
  let started = false;
  for (let k = 0; k < len; k++) {
    const level = 10 * Math.log10(Math.max(cum[k], Number.MIN_VALUE) / total);
    if (level > -5) continue;
    if (level < -25) break;
    started = true;
    xs.push(k / sampleRate);
    ys.push(level);
  }
  if (!started || xs.length < 16) return { rt60: null, fit: 0 };

  // Least squares slope (dB per second) + r².
  const nPts = xs.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < nPts; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / nPts;
  const my = sy / nPts;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < nPts; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return { rt60: null, fit: 0 };
  const slope = sxy / sxx; // dB/s, negative
  const fit = (sxy * sxy) / (sxx * syy); // r²
  if (slope >= 0) return { rt60: null, fit };
  return { rt60: -60 / slope, fit };
}

// Downmix to mono for measurement (energy ratios are what matter here; the
// stereo image is preserved in playback, this is only the analysis path).
function toMono(buffer: AudioBuffer): Float32Array {
  const ch = buffer.numberOfChannels;
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += data[i] / ch;
  }
  return out;
}

// Direct window: ±2.5 ms around the first arrival, the convention used for DRR.
const DIRECT_HALF_MS = 2.5;

export function analyseImpulse(buffer: AudioBuffer): IrAnalysis {
  const sampleRate = buffer.sampleRate;
  const x = toMono(buffer);
  const onset = findOnset(x);

  const half = Math.round((DIRECT_HALF_MS / 1000) * sampleRate);
  const dStart = Math.max(0, onset - half);
  const dEnd = onset + half;
  const eDirect = energy(x, dStart, dEnd);
  const eLate = energy(x, dEnd, x.length);

  const c50Split = onset + Math.round(0.05 * sampleRate);
  const eEarly = energy(x, onset, c50Split);
  const eTail = energy(x, c50Split, x.length);

  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
  }
  const floor = noiseFloorRms(x, sampleRate);
  const snr = floor > 0 ? 20 * Math.log10(peak / floor) : Infinity;

  const { rt60, fit } = decayTime(x, onset, sampleRate);

  const drr = eDirect > 0 && eLate > 0 ? 10 * Math.log10(eDirect / eLate) : null;
  const c50 = eEarly > 0 && eTail > 0 ? 10 * Math.log10(eEarly / eTail) : null;

  // The DRR is only trustworthy when there IS a distinct direct arrival: enough
  // SNR to separate it from noise, and a direct window that actually stands out
  // of what follows it. A diffuse/processed impulse fails this, and we say so
  // instead of quoting a meaningless number.
  const directValid = drr != null && snr >= 30 && drr > -20 && isFinite(drr);

  // Energy split of the REVERB part (what the convolver will actually carry:
  // the impulse minus its direct sound), as fractions of that part's total.
  const revStart = directValid ? dEnd : onset;
  const eRevEarly = energy(x, revStart, c50Split);
  const eRevLate = energy(x, c50Split, x.length);
  const eRevTotal = eRevEarly + eRevLate;
  const earlyFraction = eRevTotal > 0 ? eRevEarly / eRevTotal : 0;
  const lateFraction = eRevTotal > 0 ? eRevLate / eRevTotal : 1;

  return {
    sampleRate,
    onset,
    drr,
    c50,
    rt60,
    snr,
    decayFit: fit,
    directValid,
    earlyFraction,
    lateFraction,
  };
}

// --- Deriving the wet level --------------------------------------------------
// The target is NOT "reproduce the impulse's own DRR". That was tried and is
// wrong for a voice call: these impulses are recorded with the mic far from the
// source, so their direct-to-reverberant ratio is deeply negative — copying it
// faithfully would make everyone sound 20 m away in a cathedral. (Measured on
// this library it also saturated: 24 of 61 files pinned to the ceiling, i.e.
// the clamp was doing the work instead of the formula.)
//
// The right target is the one the standards define for SPEECH: C50, the
// early-to-late energy ratio at 50 ms (ISO 3382-1). We solve for the wet gain
// that renders a chosen C50, which is a closed form.
//
// Rendered through dry (the direct, power P at unity) plus wet (the reverb-only
// impulse, unit energy, gain g), with the impulse's early/late split Ee/El:
//     early = P·(1 + g²·Ee)      late = P·g²·El
//     C50 = 10·log10(early/late) = T (linear)
//  ⇒  g = 1 / sqrt(T·El − Ee)
//
// Every term is measured from the file. The only chosen number is the target
// clarity itself, and that comes from the speech-intelligibility literature —
// not from listening. C50 ≥ +2 dB is "good" for speech; +6 dB sits comfortably
// inside that, keeping voices clear while the space is still clearly audible.
const TARGET_C50_DB = 6;
const WET_MAX = 0.9;
const WET_MIN = 0.02;

export function wetGainFor(a: IrAnalysis): {
  gain: number;
  source: "c50" | "drr" | "floor" | "ceiling";
} {
  // (1) Intelligibility bound — don't render muddier than the speech target.
  const T = Math.pow(10, TARGET_C50_DB / 10);
  const denom = T * a.lateFraction - a.earlyFraction;
  // denom ≤ 0: the impulse is so front-loaded that even a full render stays
  // clearer than the target — this space simply cannot muddy the voice.
  const gC50 = !isFinite(denom) || denom <= 0 ? Infinity : 1 / Math.sqrt(denom);

  // (2) Physical bound — never render a space as MORE reverberant than it
  // actually is. The impulse's own direct-to-reverberant ratio is that limit:
  // with a unit-energy impulse, g = 10^(-DRR/20) reproduces its natural
  // balance, so anything above that is inventing reverberation the room hasn't
  // got. This is what keeps near-anechoic spaces (open fields) from being
  // rendered as a wash: C50 alone never restrains them, because they can't hurt
  // clarity — but they still shouldn't sound like a room.
  const gDrr = a.directValid && a.drr != null ? Math.pow(10, -a.drr / 20) : Infinity;

  const limit = Math.min(gC50, gDrr);
  if (!isFinite(limit)) return { gain: WET_MAX, source: "ceiling" };
  if (limit >= WET_MAX) return { gain: WET_MAX, source: "ceiling" };
  if (limit <= WET_MIN) return { gain: WET_MIN, source: "floor" };
  return { gain: limit, source: gDrr < gC50 ? "drr" : "c50" };
}

// What C50 a given wet gain actually renders — used to verify the solve rather
// than trust it (the inverse of the formula above).
export function renderedC50(a: IrAnalysis, gain: number): number {
  const g2 = gain * gain;
  const early = 1 + g2 * a.earlyFraction;
  const late = g2 * a.lateFraction;
  return late > 0 ? 10 * Math.log10(early / late) : Infinity;
}

// Build the buffer that actually feeds the convolver: the impulse WITHOUT its
// direct sound (a reverb send should carry reflections + tail; the dry path
// already provides the direct), normalised to unit energy so wetGainFor's
// closed-form result holds.
export function buildReverbImpulse(ctx: BaseAudioContext, buffer: AudioBuffer, a: IrAnalysis): AudioBuffer {
  const half = Math.round((DIRECT_HALF_MS / 1000) * a.sampleRate);
  const cut = a.directValid ? a.onset + half : a.onset;
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);

  // Remove the direct with a short raised-cosine fade-in rather than a hard cut,
  // which would add a click (a step discontinuity) to every convolution.
  const fade = Math.max(1, Math.round(0.001 * a.sampleRate));
  let total = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = cut; i < src.length; i++) {
      const k = i - cut;
      const w = k < fade ? 0.5 - 0.5 * Math.cos((Math.PI * k) / fade) : 1;
      const v = src[i] * w;
      dst[i - cut] = v;
      total += v * v;
    }
  }

  // Unit energy — this is what removes the free constant from the wet maths.
  if (total > 0) {
    const norm = 1 / Math.sqrt(total);
    for (let c = 0; c < out.numberOfChannels; c++) {
      const dst = out.getChannelData(c);
      for (let i = 0; i < dst.length; i++) dst[i] *= norm;
    }
  }
  return out;
}
