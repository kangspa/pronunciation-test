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

const KATAKANA_FIRST = 0x30a1;
const KATAKANA_LAST = 0x30f6;

// Folds spellings that sound the same: case, full-/half-width forms (NFKC),
// and katakana vs hiragana (カ = か).
function fold(ch: string): string {
  const s = ch.normalize('NFKC').toLowerCase();
  const code = s.codePointAt(0) ?? 0;
  return s.length === 1 && code >= KATAKANA_FIRST && code <= KATAKANA_LAST ? String.fromCodePoint(code - 0x60) : s;
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
  return fold(a) === fold(b) ? 1 : 0;
}

const SKIP = /[\s\p{P}\p{S}]/u;

export function isContentChar(ch: string): boolean {
  return !SKIP.test(ch);
}
