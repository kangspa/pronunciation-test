import type { KeySetting, PitchComparison } from '../audio/pitchCompare';
import type { Analysis } from './scoring';
import type { PracticeMode } from './songStore';

// Each test's score is the plain average of its parts. "With timing" adds the
// timing score as one more equal part:
//   pronunciation: pron            / (pron + timing) ÷ 2
//   pitch:         pitch           / (pitch + timing) ÷ 2
//   total:         (pron + pitch) ÷ 2 / (pron + pitch + timing) ÷ 3
export function songScores(
  mode: PracticeMode,
  pronunciation: Analysis | undefined,
  pitch: PitchComparison | undefined,
): { score: number; scoreWithTiming?: number } {
  const parts =
    mode === 'pronunciation' ? [pronunciation!.overall] : mode === 'pitch' ? [pitch!.score] : [pronunciation!.overall, pitch!.score];
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const timing = pitch?.timingScore;
  return { score: avg(parts), scoreWithTiming: timing === undefined ? undefined : avg([...parts, timing]) };
}

export function timingFormula(mode: PracticeMode): string {
  if (mode === 'pronunciation') return '(발음 + 타이밍) ÷ 2';
  if (mode === 'pitch') return '(음정 + 타이밍) ÷ 2';
  return '(발음 + 음정 + 타이밍) ÷ 3';
}

// <select> values for the key setting.
export const KEY_OPTIONS: { value: string; label: string }[] = [
  { value: 'original', label: '원래 키' },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ value: `+${n}`, label: `키 +${n} (원곡보다 ${n}반음 높게)` })),
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ value: `-${n}`, label: `키 -${n} (원곡보다 ${n}반음 낮게)` })),
  { value: 'relative', label: '상대 음정 (키 자동 맞춤)' },
];

export function keyToValue(key: KeySetting | undefined): string {
  if (!key || key.kind === 'original') return 'original';
  if (key.kind === 'relative') return 'relative';
  return key.semitones > 0 ? `+${key.semitones}` : String(key.semitones);
}

export function valueToKey(value: string): KeySetting {
  if (value === 'relative') return { kind: 'relative' };
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? { kind: 'shift', semitones: n } : { kind: 'original' };
}

const signed = (n: number, digits = 0) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;

// e.g. "원래 키", "키 +2", "상대 음정 (원곡보다 2.3반음 높게 부름)".
export function keyLabel(pitch: PitchComparison): string {
  const key = pitch.key;
  if (!key || key.kind === 'original') return '원래 키';
  if (key.kind === 'shift') return `키 ${signed(key.semitones)}`;
  const s = pitch.keyShift ?? 0;
  if (Math.abs(s) < 0.25) return '상대 음정 (원래 키로 부름)';
  return `상대 음정 (원곡보다 ${Math.abs(s).toFixed(1)}반음 ${s > 0 ? '높게' : '낮게'} 부름)`;
}

// e.g. "평균 0.12초 어긋남 · 원곡보다 8% 느리게".
export function timingDetail(pitch: PitchComparison): string {
  const parts: string[] = [];
  if (pitch.timingErrorSeconds !== undefined) parts.push(`평균 ${pitch.timingErrorSeconds.toFixed(2)}초 어긋남`);
  const t = pitch.tempoRatio;
  if (t !== undefined && Math.abs(t - 1) >= 0.03) {
    parts.push(`원곡보다 ${Math.round(Math.abs(t - 1) * 100)}% ${t > 1 ? '느리게' : '빠르게'}`);
  }
  return parts.join(' · ');
}
