import type { PitchTrack } from './pitch';

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

export function comparePitch(ref: PitchTrack, user: PitchTrack): PitchComparison {
  const r = ref.midi;
  const u = user.midi;
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
  for (const [i, j] of path) if (voiced(shifted[j])) matches[i].push(shifted[j]);
  const alignedUser = new Float32Array(r.length).fill(NaN);
  for (let i = 0; i < r.length; i++) {
    const m = matches[i].sort((a, b) => a - b);
    if (m.length) alignedUser[i] = m[m.length >> 1];
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
