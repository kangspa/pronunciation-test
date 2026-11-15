import type { PitchComparison } from '../audio/pitchCompare';
import { ATTEMPTS, tx } from './db';
import type { FullSongInfo } from './fullSong';
import { isMismatch } from './scoring';
import type { Analysis } from './scoring';
import type { PracticeMode } from './songStore';

// One record per practice attempt. Results only, no audio: a twister attempt
// is a few KB, a song attempt a few tens of KB (two pitch tracks).
export interface Attempt {
  id: string;
  // `twisterKey(id)` or `songKey(id)`.
  item: string;
  createdAt: number;
  // Song attempts only; twister attempts are always pronunciation.
  mode?: PracticeMode;
  // The score that counts for this attempt's mode, 0..100, without timing.
  score: number;
  // Song attempts: the same with the timing score averaged in (see songScores).
  scoreWithTiming?: number;
  // Text that was scored, kept because song lyrics can be edited later.
  target: string;
  modelId?: string;
  analysisMs: number;
  pronunciation?: Analysis;
  pitch?: PitchComparison;
  // Pitch was measured for display only and is not part of `score`.
  pitchForReference?: boolean;
  // Signed seconds per lyric character versus the original (word-timing model only).
  charTiming?: number[];
  // Full-song tests (item `fullKey(id)`): everything else the result page needs.
  full?: FullSongInfo;
}

// One line for a history row: what was heard and how many places differed.
export function pronunciationSummary(analysis: Analysis | undefined): string {
  if (!analysis) return '';
  const wrong = analysis.chars.filter(isMismatch).length + analysis.insertions.length;
  const heard = analysis.heardText.trim() || '(인식된 문장 없음)';
  return wrong === 0 ? `「${heard}」 · 모두 원문대로` : `「${heard}」 · 다르게 들린 곳 ${wrong}개`;
}

export const twisterKey = (id: string) => `t:${id}`;
export const songKey = (id: string) => `s:${id}`;
// Each full-song test is its own item, keyed by its attempt id.
export const fullKey = (id: string) => `f:${id}`;

export function newAttemptId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function addAttempt(attempt: Attempt): Promise<void> {
  await tx(ATTEMPTS, 'readwrite', (t) => t.objectStore(ATTEMPTS).put(attempt));
}

// Newest first.
export async function listAttempts(item: string): Promise<Attempt[]> {
  const all = await tx<Attempt[]>(ATTEMPTS, 'readonly', (t) =>
    t.objectStore(ATTEMPTS).index('item').getAll(item) as IDBRequest<Attempt[]>,
  );
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export function getAttempt(id: string): Promise<Attempt | undefined> {
  return tx<Attempt | undefined>(ATTEMPTS, 'readonly', (t) => t.objectStore(ATTEMPTS).get(id) as IDBRequest<Attempt | undefined>);
}

export async function listAllAttempts(): Promise<Attempt[]> {
  const all = await tx<Attempt[]>(ATTEMPTS, 'readonly', (t) => t.objectStore(ATTEMPTS).getAll() as IDBRequest<Attempt[]>);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function clearAttempts(): Promise<void> {
  await tx(ATTEMPTS, 'readwrite', (t) => t.objectStore(ATTEMPTS).clear());
}

export async function deleteAttempt(id: string): Promise<void> {
  await tx(ATTEMPTS, 'readwrite', (t) => t.objectStore(ATTEMPTS).delete(id));
}

// Deletes every attempt of `item` inside an existing readwrite transaction.
export function deleteAttemptsIn(t: IDBTransaction, item: string) {
  const store = t.objectStore(ATTEMPTS);
  const req = store.index('item').getAllKeys(item);
  req.onsuccess = () => {
    for (const key of req.result) store.delete(key);
  };
}
