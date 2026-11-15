// Whole songs (several minutes) don't fit the one-shot model runs that a 30 s
// segment does: a 4-minute Spleeter input alone is hundreds of MB. These
// wrappers run the same models over 30 s pieces with some context on each
// side and stitch the results.
import type { PitchRunner } from './pitch';
import { separateVocals } from './separation';
import type { StemRunner } from './separation';

export type PieceProgress = (index: number, total: number) => void;

const SEPARATION_PIECE_SECONDS = 30;
// Audio on both sides of a piece that the model sees but whose output is
// dropped (or cross-faded), so piece edges don't click or lose context.
const SEPARATION_CONTEXT_SECONDS = 1;

// Spleeter vocals for audio of any length. Pieces overlap by the context on
// each side; the overlap is cross-faded linearly.
export async function separateLong(
  left: Float32Array,
  right: Float32Array,
  rate: number,
  vocals: StemRunner,
  accompaniment: StemRunner,
  onPiece?: PieceProgress,
): Promise<Float32Array> {
  const n = left.length;
  const piece = Math.round(SEPARATION_PIECE_SECONDS * rate);
  if (n <= piece * 1.5) {
    onPiece?.(0, 1);
    return separateVocals(left, right, vocals, accompaniment);
  }
  const ctx = Math.round(SEPARATION_CONTEXT_SECONDS * rate);
  const count = Math.ceil(n / piece);
  const out = new Float32Array(n);
  const weight = new Float32Array(n);
  for (let k = 0; k < count; k++) {
    onPiece?.(k, count);
    const from = Math.max(0, k * piece - ctx);
    const to = Math.min(n, (k + 1) * piece + ctx);
    const v = await separateVocals(left.slice(from, to), right.slice(from, to), vocals, accompaniment);
    for (let i = 0; i < v.length; i++) {
      const g = from + i;
      // Triangular weight over the context: 1 inside the piece, fading to 0 at the padded ends.
      const w = Math.min(1, (i + 1) / (2 * ctx), (v.length - i) / (2 * ctx));
      out[g] += v[i] * w;
      weight[g] += w;
    }
  }
  for (let i = 0; i < n; i++) if (weight[i] > 0) out[i] /= weight[i];
  return out;
}

const PITCH_HOP = 256;
// Multiples of the hop, so piece frames line up with whole-track frames.
const PITCH_PIECE_SAMPLES = PITCH_HOP * 1875; // 30 s at 16 kHz
const PITCH_CONTEXT_SAMPLES = PITCH_HOP * 64; // ~1 s

// SwiftF0 over audio of any length. Frame f of a run covers samples around
// f * 256 + 128, so each piece's frames map back by its start sample / 256;
// only the frames inside the piece's own range are kept.
export function piecewisePitchRunner(run: PitchRunner, onPiece?: PieceProgress): PitchRunner {
  return async (audio) => {
    const n = audio.length;
    if (n <= PITCH_PIECE_SAMPLES * 1.5) return run(audio);
    const count = Math.ceil(n / PITCH_PIECE_SAMPLES);
    const hz: number[] = [];
    const confidence: number[] = [];
    for (let k = 0; k < count; k++) {
      onPiece?.(k, count);
      const coreFrom = k * PITCH_PIECE_SAMPLES;
      const coreTo = Math.min(n, coreFrom + PITCH_PIECE_SAMPLES);
      const from = Math.max(0, coreFrom - PITCH_CONTEXT_SAMPLES);
      const to = Math.min(n, coreTo + PITCH_CONTEXT_SAMPLES);
      const r = await run(audio.slice(from, to));
      const offset = from / PITCH_HOP;
      const firstKeep = coreFrom / PITCH_HOP;
      const lastKeep = k === count - 1 ? Infinity : coreTo / PITCH_HOP;
      for (let f = 0; f < r.hz.length; f++) {
        const g = offset + f;
        if (g < firstKeep || g >= lastKeep) continue;
        hz[g] = r.hz[f];
        confidence[g] = r.confidence[f];
      }
    }
    // Any frame a piece didn't produce counts as unvoiced.
    return { hz: Float32Array.from(hz, (v) => v ?? 0), confidence: Float32Array.from(confidence, (v) => v ?? 0) };
  };
}
