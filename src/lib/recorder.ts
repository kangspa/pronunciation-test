export const SAMPLE_RATE = 16000;
// Whisper sees at most 30 s per window.
export const MAX_SECONDS = 30;

export interface Recording {
  samples: Float32Array;
  url: string;
  seconds: number;
}

export interface ActiveRecording {
  stop: () => Promise<Recording>;
  cancel: () => void;
  // 0..1 current input level, for a live meter.
  level: () => number;
}

export async function startRecording(): Promise<ActiveRecording> {
  // Browser voice processing ramps in over the first few hundred ms and
  // smears consonants, which is exactly what we're trying to measure.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });

  let meterCtx: AudioContext | null = null;
  const release = () => {
    stream.getTracks().forEach((t) => t.stop());
    if (meterCtx && meterCtx.state !== 'closed') void meterCtx.close();
  };

  let recorder: MediaRecorder;
  let analyser: AnalyserNode;
  const chunks: Blob[] = [];
  try {
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    meterCtx = new AudioContext();
    analyser = meterCtx.createAnalyser();
    analyser.fftSize = 1024;
    meterCtx.createMediaStreamSource(stream).connect(analyser);
    recorder.start();
  } catch (err) {
    // Don't leave the mic on if setup fails after permission was granted.
    release();
    throw err;
  }
  const buf = new Float32Array(analyser.fftSize);

  // Settles whenever the recorder stops, including on its own (device
  // unplugged, track ended), so stop() can never hang waiting for an onstop
  // that already fired.
  // cancel() can land while onstop is already decoding; nulling the handler
  // doesn't stop that run, so it checks this flag before creating a blob URL.
  let cancelled = false;
  const stopped = new Promise<Recording>((resolve, reject) => {
    recorder.onstop = async () => {
      release();
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const samples = await decodeTo16k(blob);
        if (cancelled) {
          reject(new Error('녹음이 취소됐어요.'));
          return;
        }
        resolve({ samples, url: URL.createObjectURL(blob), seconds: samples.length / SAMPLE_RATE });
      } catch (err) {
        reject(err);
      }
    };
    recorder.onerror = () => {
      release();
      reject(new Error('녹음 중 오류가 발생했어요.'));
    };
  });
  // cancel() discards the result; keep its rejection from surfacing as unhandled.
  stopped.catch(() => {});

  return {
    level() {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      return Math.min(1, Math.sqrt(sum / buf.length) * 6);
    },
    cancel() {
      cancelled = true;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
    stop() {
      if (recorder.state !== 'inactive') recorder.stop();
      return stopped;
    },
  };
}

async function decodeTo16k(blob: Blob): Promise<Float32Array> {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const out = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const ch = decoded.getChannelData(c);
      for (let i = 0; i < ch.length; i++) out[i] += ch[i] / decoded.numberOfChannels;
    }
    return out;
  } finally {
    void ctx.close();
  }
}

const FRAME = SAMPLE_RATE / 50; // 20 ms

// Voicing via YIN's cumulative mean normalised difference (de Cheveigné &
// Kawahara 2002). A plain autocorrelation peak is fooled by low-frequency
// noise, which is self-similar at small lags without repeating; the
// cumulative-mean normalisation cancels that bias, so only a real repeat at a
// pitch period (70–800 Hz) dips below the threshold.
// Runs at 8 kHz (every other sample) to keep the cost low on long takes.
const APERIODIC_MAX = 0.3;
const STEP = 2;
const WINDOW = 320 / STEP; // 40 ms
const MIN_LAG = Math.floor(SAMPLE_RATE / 800 / STEP);
const MAX_LAG = Math.ceil(SAMPLE_RATE / 70 / STEP);

// Lowest normalised difference in the pitch range: ~0 for a clean periodic
// sound, around 1 or above for noise.
function aperiodicity(x: Float32Array, start: number): number {
  if (start + (WINDOW + MAX_LAG) * STEP > x.length) return 1;
  let running = 0;
  let best = Infinity;
  for (let lag = 1; lag <= MAX_LAG; lag++) {
    let d = 0;
    for (let i = 0; i < WINDOW; i++) {
      const delta = x[start + i * STEP] - x[start + (i + lag) * STEP];
      d += delta * delta;
    }
    running += d;
    if (lag >= MIN_LAG && running > 0) best = Math.min(best, (d * lag) / running);
  }
  return best;
}

// Trims leading/trailing silence and peak-normalises. Returns null when there
// is no clear voice, because Whisper hallucinates text ("MBC 뉴스…") on silence.
export function prepareSpeech(samples: Float32Array): Float32Array | null {
  const frames = Math.floor(samples.length / FRAME);
  if (frames === 0) return null;
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) s += samples[i] * samples[i];
    rms[f] = Math.sqrt(s / FRAME);
  }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(frames * 0.1)];
  const loud = sorted[Math.floor(frames * 0.95)];
  // Capped relative to the loud passages: in a take that is almost all
  // sustained singing, the "noise floor" percentile lands on the voice itself
  // and 3x of it would reject everything.
  const threshold = Math.max(0.01, Math.min(noiseFloor * 3, loud * 0.25));

  // Energy alone can't separate a held note from steady background noise
  // (both are flat over time), so a frame also has to be periodic.
  let first = -1;
  let last = -1;
  let voiced = 0;
  for (let f = 0; f < frames; f++) {
    if (rms[f] > threshold && aperiodicity(samples, f * FRAME) < APERIODIC_MAX) {
      voiced++;
      if (first < 0) first = f;
      last = f;
    }
  }
  // Need at least ~0.3 s of voice.
  if (voiced < 15) return null;

  const pad = 15; // 300 ms
  const start = Math.max(0, first - pad) * FRAME;
  const end = Math.min(frames, last + pad + 1) * FRAME;
  const out = samples.slice(start, end);
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) {
    const gain = 0.9 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= gain;
  }
  return out;
}
