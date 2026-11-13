import { istft, stft } from './fft';
import type { Spectrogram } from './fft';

export const SEPARATION_RATE = 44100;
const N_FFT = 4096;
const HOP = 1024;
const MODEL_BINS = 1024;
const SPLIT = 512;

// Runs one Spleeter stem model: input/output are [2, splits, 512, 1024] magnitudes.
export type StemRunner = (input: Float32Array, dims: number[]) => Promise<Float32Array>;

// Spleeter 2-stem vocal extraction, following sherpa-onnx's reference
// pipeline (scripts/spleeter/separate_onnx.py): both stem models predict
// magnitudes, and the vocal mask is v^2 / (v^2 + a^2) applied to the
// original complex STFT. Returns mono vocals at 44.1 kHz.
export async function separateVocals(
  left: Float32Array,
  right: Float32Array,
  vocals: StemRunner,
  accompaniment: StemRunner,
): Promise<Float32Array> {
  // Only the 1024 modelled bins (~11 kHz) are kept; the rest are dropped from the vocals anyway.
  const specs = [stft(left, N_FFT, HOP, MODEL_BINS), stft(right, N_FFT, HOP, MODEL_BINS)];
  const frames = specs[0].frames;
  if (frames === 0) return new Float32Array(left.length);
  const splits = Math.ceil(frames / SPLIT);
  const padded = splits * SPLIT;

  const input = new Float32Array(2 * padded * MODEL_BINS);
  specs.forEach((s, c) => {
    for (let f = 0; f < frames; f++) {
      for (let k = 0; k < MODEL_BINS; k++) {
        const i = f * s.bins + k;
        input[(c * padded + f) * MODEL_BINS + k] = Math.hypot(s.re[i], s.im[i]);
      }
    }
  });
  const dims = [2, splits, SPLIT, MODEL_BINS];
  const v = await vocals(input, dims);
  const a = await accompaniment(input, dims);

  const out = new Float32Array(left.length);
  specs.forEach((s: Spectrogram, c) => {
    // Masked in place: the original spectrogram isn't needed afterwards.
    for (let f = 0; f < frames; f++) {
      for (let k = 0; k < MODEL_BINS; k++) {
        const m = (c * padded + f) * MODEL_BINS + k;
        const v2 = v[m] * v[m];
        const mask = (v2 + 5e-11) / (v2 + a[m] * a[m] + 1e-10);
        const i = f * s.bins + k;
        s.re[i] *= mask;
        s.im[i] *= mask;
      }
    }
    const wav = istft(s, N_FFT, HOP, left.length);
    for (let i = 0; i < out.length; i++) out[i] += wav[i] / 2;
  });
  return out;
}
