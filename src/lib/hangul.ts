const SYLLABLE_BASE = 0xac00;
const SYLLABLE_END = 0xd7a3;

export interface Jamo {
  cho: number;
  jung: number;
  jong: number;
}

export function decompose(ch: string): Jamo | null {
  const code = ch.codePointAt(0) ?? 0;
  if (code < SYLLABLE_BASE || code > SYLLABLE_END) return null;
  const idx = code - SYLLABLE_BASE;
  return { cho: Math.floor(idx / 588), jung: Math.floor((idx % 588) / 28), jong: idx % 28 };
}

// 0..1 similarity. Hangul syllables get partial credit per matching jamo
// (initial / medial / final), so "장" vs "정" scores 2/3 instead of 0.
export function charSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const ja = decompose(a);
  const jb = decompose(b);
  if (ja && jb) {
    return ((ja.cho === jb.cho ? 1 : 0) + (ja.jung === jb.jung ? 1 : 0) + (ja.jong === jb.jong ? 1 : 0)) / 3;
  }
  return a.toLowerCase() === b.toLowerCase() ? 1 : 0;
}

const SKIP = /[\s\p{P}\p{S}]/u;

export function isContentChar(ch: string): boolean {
  return !SKIP.test(ch);
}
