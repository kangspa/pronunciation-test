import type { PitchTrack } from './pitch';

// Which key the user sings in. Whole-octave differences (e.g. a man singing a
// woman's part) are matched automatically in every setting.
export type KeySetting =
  // Sung in the original key.
  | { kind: 'original' }
  // Sung `semitones` higher (+) or lower (-) than the original, like a karaoke key change.
  | { kind: 'shift'; semitones: number }
  // Any key: the best-fitting constant shift is found, so only the melody's
  // rises and falls (relative pitch) are scored.
  | { kind: 'relative' };

export interface PitchComparison {
  // 0..100. 100 = every voiced reference frame matched within PERFECT_SEMITONES.
  score: number;
  // Share of voiced reference frames within 50 cents.
  hitRate: number;
  // Mean signed error in cents over matched frames (+ = sharp, - = flat).
  meanCents: number;
  // Octaves added to the user's pitch before comparing (e.g. -1 = sang an octave higher).
  octaveShift: number;
  // How much later (+) or earlier (-) the user started, in seconds.
  lagSeconds: number;
  // User pitch mapped onto the reference timeline (octave-corrected), NaN where missing.
  alignedUser: Float32Array;
  // Per reference frame score 0..1, NaN where the reference is unvoiced.
  frameScores: Float32Array;
  // The rest is missing on records made before key settings and timing existed.
  key?: KeySetting;
  // Semitones taken off the user's pitch before comparing, on top of whole
  // octaves: the chosen shift, or the fitted one in relative mode.
  keyShift?: number;
  // 0..100. How close to the original's timing each note is sung, once the
  // first seconds of singing are lined up (when the user starts doesn't matter).
  // A take that is slower or faster overall drifts and loses points.
  // Measured in the best-fitting key whatever `key` is, so singing in another
  // key doesn't spoil the alignment the timing is read from.
  timingScore?: number;
  // Mean absolute timing error over sung frames, seconds.
  timingErrorSeconds?: number;
  // Take length / original length between the first and last sung notes (1.1 = 10% slower).
  tempoRatio?: number;
  // Per reference frame, how much later (+) or earlier (-) the take sings it,
  // seconds; NaN where the reference is unvoiced or the user was silent.
  timingErrors?: Float32Array;
}

// Within this many semitones a frame counts as fully in tune; at FAIL_SEMITONES it scores 0.
const PERFECT_SEMITONES = 0.5;
const FAIL_SEMITONES = 2;
const MAX_LAG_SECONDS = 2;
// DTW band half-width: a fixed slack plus a share of the length, since local
// timing differences grow with the segment (a 60 s take may drift seconds).
const BAND_SECONDS = 0.4;
const BAND_SHARE = 0.05;
// Overall tempo ratios outside this range are treated as unrelated takes.
const MIN_TEMPO = 0.7;
const MAX_TEMPO = 1.4;
const CAP = 6;

const voiced = (x: number) => !Number.isNaN(x);

function lastIndex(x: Float32Array, pred: (v: number) => boolean): number {
  for (let i = x.length - 1; i >= 0; i--) if (pred(x[i])) return i;
  return -1;
}

// Timing error up to this counts as on time; at TIMING_FAIL_SECONDS a frame scores 0.
export const TIMING_OK_SECONDS = 0.15;
const TIMING_FAIL_SECONDS = 0.6;
// The take's timing is lined up on the first this-many seconds of singing.
const ANCHOR_SECONDS = 3;

export function comparePitch(ref: PitchTrack, user: PitchTrack, key: KeySetting = { kind: 'original' }): PitchComparison {
  const fit = bestKeyFit(ref, user);
  const chosen = key.kind === 'relative' ? fit : compareAt(ref, user, key.kind === 'shift' ? key.semitones : 0);
  return {
    ...chosen,
    key,
    timingScore: fit.timingScore,
    timingErrorSeconds: fit.timingErrorSeconds,
    tempoRatio: fit.tempoRatio,
    timingErrors: fit.timingErrors,
  };
}

// Relative pitch: try every key within an octave (octaves are searched
// inside), then refine by the median remaining offset, which also absorbs a
// take that is consistently a little sharp or flat.
function bestKeyFit(ref: PitchTrack, user: PitchTrack): PitchComparison {
  let best: PitchComparison | null = null;
  for (let s = -5; s <= 6; s++) {
    const c = compareAt(ref, user, s);
    if (!best || c.score > best.score) best = c;
  }
  const residual = medianOffset(ref.midi, best!.alignedUser);
  if (Math.abs(residual) > 0.05) {
    const refined = compareAt(ref, user, best!.keyShift! + residual);
    if (refined.score > best!.score) best = refined;
  }
  return best!;
}

function medianOffset(r: Float32Array, aligned: Float32Array): number {
  const d: number[] = [];
  for (let i = 0; i < r.length; i++) if (voiced(r[i]) && voiced(aligned[i])) d.push(aligned[i] - r[i]);
  if (!d.length) return 0;
  d.sort((a, b) => a - b);
  return d[d.length >> 1];
}

// Compares with the user's pitch lowered by `shift` semitones first.
function compareAt(ref: PitchTrack, user: PitchTrack, shift: number): PitchComparison {
  const r = ref.midi;
  const u = shift ? user.midi.map((x) => x - shift) : user.midi;
  const fs = ref.frameSeconds;
  const { lag, octave } = findOffset(r, u, Math.round(MAX_LAG_SECONDS / fs));
  const shifted = u.map((x) => x + 12 * octave);

  // Centre the band on the line through both tracks' first and last voiced
  // frames, so a uniformly slower or faster take stays inside it end to end.
  const rFirst = Math.max(0, r.findIndex(voiced));
  const rLast = lastIndex(r, voiced);
  const uLast = lastIndex(u, voiced);
  const uFirst = rFirst + lag;
  const tempo = rLast > rFirst && uLast > uFirst ? (uLast - uFirst) / (rLast - rFirst) : 1;
  const slope = Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, tempo));
  const center = (i: number) => uFirst + (i - rFirst) * slope;
  const band = Math.round(BAND_SECONDS / fs + BAND_SHARE * r.length);
  const path = bandedDtw(r, shifted, center, band);

  // Each reference frame takes the median of the user frames the path pairs it with.
  const matches: number[][] = Array.from({ length: r.length }, () => []);
  const matchedAt: number[][] = Array.from({ length: r.length }, () => []);
  for (const [i, j] of path) {
    if (!voiced(shifted[j])) continue;
    matches[i].push(shifted[j]);
    matchedAt[i].push(j);
  }
  const alignedUser = new Float32Array(r.length).fill(NaN);
  for (let i = 0; i < r.length; i++) {
    const m = matches[i].sort((a, b) => a - b);
    if (m.length) alignedUser[i] = m[m.length >> 1];
  }

  // Timing: where the path puts each sung reference frame in the take, against
  // where it falls at the original tempo once the first few seconds of singing
  // are lined up. Anchoring at the start (not on the best overall offset) makes
  // a take that drags show as later and later, rather than early-then-late.
  // Reference frames the user didn't sing score 0.
  const anchorEnd = rFirst + Math.round(ANCHOR_SECONDS / fs);
  const offsets: number[] = [];
  for (let i = rFirst; i < Math.min(anchorEnd, r.length); i++) {
    const js = matchedAt[i];
    if (voiced(r[i]) && js.length) offsets.push(js[js.length >> 1] - i);
  }
  offsets.sort((a, b) => a - b);
  const anchor = offsets.length ? offsets[offsets.length >> 1] : lag;
  let timingSum = 0;
  let timingAbsSum = 0;
  let timingMatched = 0;
  let timingFrames = 0;
  const timingErrors = new Float32Array(r.length).fill(NaN);
  // Least-squares slope of take frame against reference frame = tempo ratio.
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < r.length; i++) {
    if (!voiced(r[i])) continue;
    timingFrames++;
    const js = matchedAt[i];
    if (!js.length) continue;
    const j = js[js.length >> 1];
    sx += i;
    sy += j;
    sxx += i * i;
    sxy += i * j;
    const err = (j - (i + anchor)) * fs;
    timingErrors[i] = err;
    const e = Math.abs(err);
    timingSum += e <= TIMING_OK_SECONDS ? 1 : e >= TIMING_FAIL_SECONDS ? 0 : 1 - (e - TIMING_OK_SECONDS) / (TIMING_FAIL_SECONDS - TIMING_OK_SECONDS);
    timingAbsSum += e;
    timingMatched++;
  }

  const frameScores = new Float32Array(r.length).fill(NaN);
  let refVoiced = 0;
  let scoreSum = 0;
  let hits = 0;
  let centsSum = 0;
  let matched = 0;
  for (let i = 0; i < r.length; i++) {
    if (!voiced(r[i])) continue;
    refVoiced++;
    let s = 0;
    if (voiced(alignedUser[i])) {
      const diff = alignedUser[i] - r[i];
      const d = Math.abs(diff);
      s = d <= PERFECT_SEMITONES ? 1 : d >= FAIL_SEMITONES ? 0 : 1 - (d - PERFECT_SEMITONES) / (FAIL_SEMITONES - PERFECT_SEMITONES);
      if (d <= 0.5) hits++;
      centsSum += diff * 100;
      matched++;
    }
    frameScores[i] = s;
    scoreSum += s;
  }

  return {
    score: refVoiced ? (scoreSum / refVoiced) * 100 : 0,
    hitRate: refVoiced ? (hits / refVoiced) * 100 : 0,
    meanCents: matched ? centsSum / matched : 0,
    octaveShift: octave,
    lagSeconds: lag * fs,
    alignedUser,
    frameScores,
    keyShift: shift,
    timingScore: timingFrames ? (timingSum / timingFrames) * 100 : 0,
    timingErrorSeconds: timingMatched ? timingAbsSum / timingMatched : 0,
    timingErrors,
    tempoRatio: timingMatched > 1 && timingMatched * sxx - sx * sx > 0 ? (timingMatched * sxy - sx * sy) / (timingMatched * sxx - sx * sx) : 1,
  };
}

// Coarse search for the start offset and octave that best overlay the user on the reference.
// Centred on where each track's singing starts, so an instrumental intro in
// the reference segment (or a pause before the user starts) can exceed maxLag.
function findOffset(r: Float32Array, u: Float32Array, maxLag: number): { lag: number; octave: number } {
  let refVoiced = 0;
  for (const x of r) if (voiced(x)) refVoiced++;
  const base = Math.max(0, u.findIndex(voiced)) - Math.max(0, r.findIndex(voiced));
  let best = { lag: base, octave: 0, cost: Infinity };
  for (let lag = base - maxLag; lag <= base + maxLag; lag++) {
    for (let octave = -2; octave <= 2; octave++) {
      let cost = 0;
      let n = 0;
      for (let i = 0; i < r.length; i++) {
        const j = i + lag;
        if (j < 0 || j >= u.length || !voiced(r[i]) || !voiced(u[j])) continue;
        cost += Math.min(Math.abs(r[i] - (u[j] + 12 * octave)), CAP);
        n++;
      }
      // Unmatched reference frames cost the cap, so a tiny overlap can't win.
      const total = (cost + (refVoiced - n) * CAP) / Math.max(1, refVoiced);
      if (total < best.cost) best = { lag, octave, cost: total };
    }
  }
  return best;
}

// DTW restricted to a band around j = center(i), so the user may drift in
// tempo but can't be warped onto an unrelated part of the melody.
function bandedDtw(r: Float32Array, u: Float32Array, center: (i: number) => number, band: number): [number, number][] {
  const n = r.length;
  const m = u.length;
  if (n === 0 || m === 0) return [];
  const width = 2 * band + 1;
  const INF = 1e18;
  const D = new Float64Array(n * width).fill(INF);
  const step = new Uint8Array(n * width);
  const loOf = Int32Array.from({ length: n }, (_, i) => Math.round(center(i)) - band);
  const lo = (i: number) => loOf[i];
  const cost = (i: number, j: number) => {
    const a = voiced(r[i]);
    const b = voiced(u[j]);
    if (a && b) return Math.min(Math.abs(r[i] - u[j]), CAP) / CAP;
    return a || b ? 0.5 : 0;
  };
  const get = (i: number, j: number) => {
    const k = j - lo(i);
    return i < 0 || k < 0 || k >= width ? INF : D[i * width + k];
  };

  for (let i = 0; i < n; i++) {
    for (let k = 0; k < width; k++) {
      const j = lo(i) + k;
      if (j < 0 || j >= m) continue;
      const c = cost(i, j);
      if (i === 0 && j === Math.max(0, lo(0))) {
        D[k] = c;
        continue;
      }
      // Small penalty on non-diagonal moves discourages needless warping.
      const diag = get(i - 1, j - 1);
      const up = get(i - 1, j) + 0.1;
      const left = k > 0 ? D[i * width + k - 1] + 0.1 : INF;
      let bestPrev = diag;
      let s = 0;
      if (up < bestPrev) {
        bestPrev = up;
        s = 1;
      }
      if (left < bestPrev) {
        bestPrev = left;
        s = 2;
      }
      if (bestPrev >= INF) {
        // Allow the path to start anywhere on the first reachable row/column.
        if (i === 0 || j === 0) bestPrev = 0;
        else continue;
      }
      D[i * width + k] = bestPrev + c;
      step[i * width + k] = s;
    }
  }

  // Open end: the path may finish on the last reference frame or the last
  // user frame, whichever the band reaches. A user take shorter than the
  // reference otherwise leaves the last row unreachable.
  let endI = -1;
  let endJ = -1;
  let endCost = INF;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < width; k++) {
      const j = lo(i) + k;
      if (j < 0 || j >= m || (i !== n - 1 && j !== m - 1)) continue;
      const v = D[i * width + k];
      // Normalise by progress through the reference so ending early isn't free.
      const norm = v + (n - 1 - i) * 0.5;
      if (norm < endCost) {
        endCost = norm;
        endI = i;
        endJ = j;
      }
    }
  }
  if (endI < 0) return [];
  const path: [number, number][] = [];
  let i = endI;
  let j = endJ;
  while (i >= 0 && j >= 0) {
    path.push([i, j]);
    const k = j - lo(i);
    const s = step[i * width + k];
    if (i === 0) break;
    if (s === 0) {
      if (get(i - 1, j - 1) >= INF) break;
      i--;
      j--;
    } else if (s === 1) {
      i--;
    } else {
      j--;
    }
  }
  return path.reverse();
}
