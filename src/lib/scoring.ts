import { alignChars } from './align';
import { isContentChar } from './hangul';
import type { ScoreOutput } from '../asr/whisperScorer';

export interface CharResult {
  target: string;
  // What the model heard in this slot; null when the character was dropped.
  heard: string | null;
  // 0..1, how close the heard character is to the target (jamo-level for Hangul).
  accuracy: number;
  // 0..1, model's probability that the target character was spoken.
  confidence: number;
  heardConfidence: number | null;
  // accuracy * confidence
  score: number;
}

export interface Insertion {
  // Index into `chars` of the character this extra sound follows (-1 = before the first).
  after: number;
  char: string;
}

export interface Analysis {
  // 0..100. Equals 100 only when every character has accuracy 1 and confidence 1
  // and nothing extra was heard.
  overall: number;
  accuracy: number;
  confidence: number;
  words: CharResult[][];
  chars: CharResult[];
  insertions: Insertion[];
  heardText: string;
}

export function analyze(targetText: string, output: ScoreOutput): Analysis {
  const words = targetText.trim().split(/\s+/).map((w) => Array.from(w).filter(isContentChar));
  const targetChars = words.flat();

  // Teacher-forced probabilities come back in the same order as the target's
  // content characters. If tokenisation ever drifts, fall back to 0 rather than misattribute.
  const aligned = output.target.length === targetChars.length;
  const confidenceAt = (i: number) => (aligned ? output.target[i].prob : 0);

  const heardChars = output.heard.map((c) => c.char);
  const ops = alignChars(targetChars, heardChars);

  const chars: CharResult[] = targetChars.map((target, i) => ({
    target,
    heard: null,
    accuracy: 0,
    confidence: confidenceAt(i),
    heardConfidence: null,
    score: 0,
  }));
  const insertions: Insertion[] = [];
  let lastTarget = -1;
  for (const op of ops) {
    if (op.kind === 'match') {
      const c = chars[op.t];
      c.heard = heardChars[op.h];
      c.accuracy = op.similarity;
      c.heardConfidence = output.heard[op.h].prob;
      lastTarget = op.t;
    } else if (op.kind === 'delete') {
      lastTarget = op.t;
    } else {
      insertions.push({ after: lastTarget, char: heardChars[op.h] });
    }
  }
  for (const c of chars) c.score = c.accuracy * c.confidence;

  const n = chars.length || 1;
  const sum = (f: (c: CharResult) => number) => chars.reduce((s, c) => s + f(c), 0);
  // Extra sounds count as zero-score slots, so saying more than the phrase can't reach 100.
  const overall = (sum((c) => c.score) / (n + insertions.length)) * 100;

  let k = 0;
  const grouped = words.map((w) => w.map(() => chars[k++]));

  return {
    overall,
    accuracy: (sum((c) => c.accuracy) / n) * 100,
    confidence: (sum((c) => c.confidence) / n) * 100,
    words: grouped,
    chars,
    insertions,
    heardText: output.heardText,
  };
}

export function grade(score: number): { label: string; tone: 'great' | 'good' | 'ok' | 'low' } {
  if (score >= 95) return { label: '완벽해요', tone: 'great' };
  if (score >= 85) return { label: '아주 좋아요', tone: 'great' };
  if (score >= 70) return { label: '좋아요', tone: 'good' };
  if (score >= 50) return { label: '조금 더 연습해요', tone: 'ok' };
  return { label: '다시 도전해요', tone: 'low' };
}
