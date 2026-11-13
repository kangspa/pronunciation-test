export const PITCH_RATE = 16000;
// SwiftF0 hops 256 samples at 16 kHz.
export const FRAME_SECONDS = 256 / PITCH_RATE;
// Measured on a vocal mixed with a synthetic band: a 20 dB gate cut false
// voicing on Spleeter output from 65% to 5% while keeping 82% of the clean
// vocal's pitch frames within 50 cents.
export const REFERENCE_GATE_DB = 20;
const F_MIN = 46.875;
const F_MAX = 2093.75;

export type PitchRunner = (audio: Float32Array) => Promise<{ hz: Float32Array; confidence: Float32Array }>;

export interface PitchTrack {
  // MIDI note number per 16 ms frame (fractional = cents), NaN where unvoiced.
  midi: Float32Array;
  frameSeconds: number;
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function midiName(midi: number): string {
  const n = Math.round(midi);
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

export interface TrackOptions {
  // SwiftF0 voicing confidence threshold (upstream default 0.9).
  threshold?: number;
  // Frames quieter than this many dB below the loud passages count as unvoiced.
  // Separated vocals keep faint accompaniment bleed in the gaps, and SwiftF0
  // happily reports a pitch for it.
  gateDb?: number;
}

export async function trackPitch(
  audio16k: Float32Array,
  run: PitchRunner,
  // 30 dB suits clean mic takes; separated references use ~20 dB (see REFERENCE_GATE_DB).
  { threshold = 0.75, gateDb = 30 }: TrackOptions = {},
): Promise<PitchTrack> {
  const padded = audio16k.length >= 256 ? audio16k : (() => {
    const p = new Float32Array(256);
    p.set(audio16k);
    return p;
  })();
  const { hz, confidence } = await run(padded);
  const energy = frameEnergyDb(padded, hz.length);
  const sorted = Array.from(energy).sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const raw = new Float32Array(hz.length);
  for (let i = 0; i < hz.length; i++) {
    const ok = confidence[i] > threshold && hz[i] >= F_MIN && hz[i] <= F_MAX && energy[i] > loud - gateDb;
    raw[i] = ok ? hzToMidi(hz[i]) : NaN;
  }
  return { midi: removeBlips(medianSmooth(raw, 2), 4), frameSeconds: FRAME_SECONDS };
}

// RMS in dB over SwiftF0's 1024-sample window for each 256-sample hop.
function frameEnergyDb(audio: Float32Array, frames: number): Float32Array {
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const center = f * 256 + 128;
    const start = Math.max(0, center - 512);
    const end = Math.min(audio.length, center + 512);
    let s = 0;
    for (let i = start; i < end; i++) s += audio[i] * audio[i];
    out[f] = 10 * Math.log10(s / Math.max(1, end - start) + 1e-12);
  }
  return out;
}

function medianSmooth(x: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(x.length);
  const buf: number[] = [];
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(x[i])) {
      out[i] = NaN;
      continue;
    }
    buf.length = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(x.length - 1, i + radius); j++) {
      if (!Number.isNaN(x[j])) buf.push(x[j]);
    }
    buf.sort((a, b) => a - b);
    out[i] = buf[buf.length >> 1];
  }
  return out;
}

// Drops voiced runs shorter than minFrames (~64 ms): usually consonant noise or bleed.
function removeBlips(x: Float32Array, minFrames: number): Float32Array {
  const out = x.slice();
  let i = 0;
  while (i < out.length) {
    if (Number.isNaN(out[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && !Number.isNaN(out[j])) j++;
    if (j - i < minFrames) out.fill(NaN, i, j);
    i = j;
  }
  return out;
}

export function voicedRatio(track: PitchTrack): number {
  let v = 0;
  for (const m of track.midi) if (!Number.isNaN(m)) v++;
  return track.midi.length ? v / track.midi.length : 0;
}
