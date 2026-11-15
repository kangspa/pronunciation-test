import { isContentChar } from './hangul';

// Gaps shorter than this between voiced frames are treated as one sung stretch.
const JOIN_SECONDS = 0.08;

// When each lyric character is sung in the reference, estimated from the
// reference pitch alone: the characters are spread evenly over the time the
// original singer is voiced (roughly one syllable per stretch of singing).
// Good enough to follow along; a word-timing model gives the real times.
export function estimateCharTimes(refMidi: Float32Array, frameSeconds: number, lyrics: string): number[] {
  const n = Array.from(lyrics).filter(isContentChar).length;
  if (n === 0) return [];
  const join = Math.round(JOIN_SECONDS / frameSeconds);
  // Voiced frames, with short gaps filled so a syllable isn't split in two.
  const voicedAt: number[] = [];
  let lastVoiced = -Infinity;
  for (let i = 0; i < refMidi.length; i++) {
    if (Number.isNaN(refMidi[i])) continue;
    if (i - lastVoiced > 1 && i - lastVoiced <= join) for (let g = lastVoiced + 1; g < i; g++) voicedAt.push(g);
    voicedAt.push(i);
    lastVoiced = i;
  }
  if (voicedAt.length === 0) return Array.from({ length: n }, (_, k) => (k / n) * refMidi.length * frameSeconds);
  return Array.from({ length: n }, (_, k) => voicedAt[Math.floor((k / n) * voicedAt.length)] * frameSeconds);
}

// Index of the character being sung at `t` seconds: the last one whose time
// has come, or -1 before the first.
export function charAt(times: (number | null)[], t: number): number {
  let current = -1;
  for (let k = 0; k < times.length; k++) {
    const s = times[k];
    if (s == null) continue;
    if (s <= t) current = k;
    else break;
  }
  return current;
}
