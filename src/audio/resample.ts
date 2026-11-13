// Windowed-sinc resampler. Workers have no OfflineAudioContext, so the
// 44.1 kHz separation output is brought down to 16 kHz here.
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice();
  const ratio = toRate / fromRate;
  const outLength = Math.floor(input.length * ratio);
  const out = new Float32Array(outLength);
  // Low-pass at the lower Nyquist to avoid aliasing when downsampling.
  const cutoff = Math.min(1, ratio) * 0.95;
  const halfTaps = 16;
  const radius = halfTaps / cutoff;
  for (let i = 0; i < outLength; i++) {
    const center = i / ratio;
    const start = Math.max(0, Math.ceil(center - radius));
    const end = Math.min(input.length - 1, Math.floor(center + radius));
    let sum = 0;
    let wsum = 0;
    for (let j = start; j <= end; j++) {
      const x = (j - center) * cutoff;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const win = 0.5 + 0.5 * Math.cos((Math.PI * (j - center)) / radius);
      const w = sinc * win;
      sum += input[j] * w;
      wsum += w;
    }
    out[i] = wsum > 0 ? sum / wsum : 0;
  }
  return out;
}
