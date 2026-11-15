import { alignChars } from './align';
import { isContentChar } from './hangul';
import type { Analysis } from './scoring';

// What a full-song test keeps besides the usual attempt fields. No audio.
export interface FullSongInfo {
  title: string;
  originalName: string;
  takeName: string;
  language: string;
  takeHasAccompaniment: boolean;
  durationSeconds: number;
  // Reference pitch of the original vocals, decimated for the whole-song chart.
  refMidi: Float32Array;
  frameSeconds: number;
  // Where the scored lyrics came from.
  lyricsSource: 'uploaded' | 'recognized' | 'edited' | 'none';
  // Whisper's transcription of the original vocals, before any correction.
  recognizedLyrics?: string;
  // The original vocals scored against the same lyrics: the baseline.
  refPronunciation?: Analysis;
  // Take's pronunciation relative to the original, 0..100, and per character 0..1.
  relativePronunciation?: number;
  relativeChars?: number[];
}

// .lrc lines look like "[01:23.45]가사"; metadata lines like "[ar:Artist]".
const LRC_TIME = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g;
const LRC_META = /^\[[a-z]+:.*\]$/i;

// Plain lyrics from a pasted text or an uploaded .txt / .lrc file: timestamps
// and metadata removed, blank lines collapsed.
export function cleanLyrics(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !LRC_META.test(l))
    .map((l) => l.replace(LRC_TIME, '').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Added to both sides of the ratio so characters the original itself is
// barely heard on neither blow the ratio up nor make full marks impossible.
const SMOOTHING = 0.1;

// The take's character scores measured against the original singer's on the
// same lyrics: (take + 0.1) / (original + 0.1), capped at 1. A character
// heard at least as clearly as in the original scores 1, so singing exactly
// like the original gives 100. Extra sounds count as zero slots, as in the
// absolute score, but only those beyond the original's own: Whisper hears
// the same extra syllables in both when the take matches the original.
export function relativePronunciation(take: Analysis, ref: Analysis): { overall: number; chars: number[] } {
  const chars = take.chars.map((c, i) => Math.min(1, (c.score + SMOOTHING) / ((ref.chars[i]?.score ?? 1) + SMOOTHING)));
  const n = chars.length + Math.max(0, take.insertions.length - ref.insertions.length);
  return { overall: n ? (chars.reduce((a, b) => a + b, 0) / n) * 100 : 0, chars };
}

export interface LyricsLine {
  text: string;
  // Indices into Analysis.chars for this line's content characters, in order.
  chars: number[];
}

// Splits the lyrics into their lines and gives each the analysis characters
// it owns. Analysis.chars lists the content characters of the whole text in
// order, so lines simply take them in turn.
export function lyricsLines(lyrics: string): LyricsLine[] {
  let next = 0;
  return lyrics
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text) => {
      const count = Array.from(text).filter(isContentChar).length;
      const chars = Array.from({ length: count }, (_, k) => next + k);
      next += count;
      return { text, chars };
    });
}

// Median of every `factor` frames, NaN when fewer than half are voiced. Keeps
// whole-song DTW and charts small (a 4-minute track: 15,000 → 5,000 frames).
export function decimateTrack(midi: Float32Array, factor: number): Float32Array {
  const out = new Float32Array(Math.ceil(midi.length / factor));
  const buf: number[] = [];
  for (let k = 0; k < out.length; k++) {
    buf.length = 0;
    for (let i = k * factor; i < Math.min(midi.length, (k + 1) * factor); i++) if (!Number.isNaN(midi[i])) buf.push(midi[i]);
    if (buf.length * 2 < factor) {
      out[k] = NaN;
      continue;
    }
    buf.sort((a, b) => a - b);
    out[k] = buf[buf.length >> 1];
  }
  return out;
}

// How many characters the recognised text and the final lyrics differ in.
export function countLyricDifferences(recognized: string, lyrics: string): number {
  const a = Array.from(lyrics).filter(isContentChar);
  const b = Array.from(recognized).filter(isContentChar);
  return alignChars(a, b).filter((op) => op.kind !== 'match' || op.similarity < 1).length;
}
