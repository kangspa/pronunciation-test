// Per-character timing from a word-timing Whisper model: when each lyric
// character is sung in the take versus in the original.

// Within this many seconds a character counts as on time; beyond STRONG it is drawn solid.
export const CHAR_TIMING_OK_SECONDS = 0.25;
export const CHAR_TIMING_STRONG_SECONDS = 0.5;
// The first this-many timed characters line the two up, so when the take
// starts doesn't count (same idea as the pitch timing's start anchor).
const ANCHOR_CHARS = 5;

export type Times = (number | null | undefined)[];

// Signed seconds per target character (+ = take is late), NaN where either
// side has no time. Both arrays are indexed by target character.
export function compareCharTimes(ref: Times, take: Times): number[] {
  const n = Math.min(ref.length, take.length);
  const raw: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = ref[i];
    const b = take[i];
    raw.push(a != null && b != null && Number.isFinite(a) && Number.isFinite(b) ? b - a : NaN);
  }
  const first = raw.filter((d) => !Number.isNaN(d)).slice(0, ANCHOR_CHARS).sort((a, b) => a - b);
  if (!first.length) return raw;
  const anchor = first[first.length >> 1];
  return raw.map((d) => d - anchor);
}

export type CharTimingClass = 'early-strong' | 'early' | 'late' | 'late-strong' | null;

export function charTimingClass(d: number | undefined): CharTimingClass {
  if (d === undefined || Number.isNaN(d) || Math.abs(d) <= CHAR_TIMING_OK_SECONDS) return null;
  const strong = Math.abs(d) >= CHAR_TIMING_STRONG_SECONDS;
  if (d < 0) return strong ? 'early-strong' : 'early';
  return strong ? 'late-strong' : 'late';
}

export function charTimingText(d: number | undefined): string | null {
  if (d === undefined || Number.isNaN(d)) return null;
  if (Math.abs(d) <= CHAR_TIMING_OK_SECONDS) return '원곡과 같은 타이밍에 불렀어요.';
  return `원곡보다 ${Math.abs(d).toFixed(2)}초 ${d < 0 ? '빨리' : '늦게'} 불렀어요.`;
}
