// In-place iterative radix-2 complex FFT. n must be a power of two.
export function fft(re: Float32Array, im: Float32Array, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

export function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

export interface Spectrogram {
  frames: number;
  bins: number;
  // Row-major [frames][bins]
  re: Float32Array;
  im: Float32Array;
}

// center=false STFT, matching what the Spleeter export was run with.
// keepBins stores only the lowest bins; istft treats the rest as zero. A
// 60 s stereo segment needs ~45 MB at 1024 bins instead of ~85 MB at 2049.
export function stft(signal: Float32Array, nFft: number, hop: number, keepBins = nFft / 2 + 1): Spectrogram {
  const frames = signal.length >= nFft ? 1 + Math.floor((signal.length - nFft) / hop) : 0;
  const bins = Math.min(keepBins, nFft / 2 + 1);
  const window = hann(nFft);
  const out: Spectrogram = { frames, bins, re: new Float32Array(frames * bins), im: new Float32Array(frames * bins) };
  const re = new Float32Array(nFft);
  const im = new Float32Array(nFft);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < nFft; i++) {
      re[i] = signal[off + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    out.re.set(re.subarray(0, bins), f * bins);
    out.im.set(im.subarray(0, bins), f * bins);
  }
  return out;
}

// Weighted overlap-add inverse, normalised by the summed squared window.
export function istft(spec: Spectrogram, nFft: number, hop: number, length: number): Float32Array {
  const window = hann(nFft);
  const out = new Float32Array(length);
  const norm = new Float32Array(length);
  const re = new Float32Array(nFft);
  const im = new Float32Array(nFft);
  const { bins } = spec;
  const half = nFft / 2;
  for (let f = 0; f < spec.frames; f++) {
    for (let k = 0; k <= half; k++) {
      re[k] = k < bins ? spec.re[f * bins + k] : 0;
      im[k] = k < bins ? spec.im[f * bins + k] : 0;
    }
    // Hermitian mirror for a real signal.
    for (let k = 1; k < half; k++) {
      re[nFft - k] = re[k];
      im[nFft - k] = -im[k];
    }
    fft(re, im, true);
    const off = f * hop;
    for (let i = 0; i < nFft && off + i < length; i++) {
      out[off + i] += re[i] * window[i];
      norm[off + i] += window[i] * window[i];
    }
  }
  for (let i = 0; i < length; i++) if (norm[i] > 1e-8) out[i] /= norm[i];
  return out;
}
