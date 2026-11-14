import type { KeySetting } from '../audio/pitchCompare';
import { deleteAttemptsIn, songKey } from './attemptStore';
import { ATTEMPTS, SONGS, tx } from './db';

// Analysed song segments live in IndexedDB: each holds a pitch track and two
// short WAV clips (a few MB), too much for localStorage.

export interface Song {
  id: string;
  title: string;
  sourceName: string;
  language: string;
  lyrics: string;
  // Segment bounds within the uploaded file, seconds.
  start: number;
  end: number;
  createdAt: number;
  // Reference MIDI pitch per frame (Float32Array buffer), NaN = unvoiced.
  refMidi: ArrayBuffer;
  frameSeconds: number;
  // Audio clips of the segment. Missing once removed in 로컬 관리 to free
  // space; lyrics, reference pitch and records stay usable without them.
  original?: Blob;
  vocals?: Blob;
  // Best scores without timing.
  best?: Partial<Record<PracticeMode, number>>;
  bestWithTiming?: Partial<Record<PracticeMode, number>>;
  // Combined best saved before per-mode scores existed.
  bestScore?: number;
  // Key the user sings this song in; original key when missing.
  key?: KeySetting;
  // When each lyric character is sung in the original vocals, from a
  // word-timing model; recomputed when the lyrics or the model change.
  refCharTimes?: { lyrics: string; modelId: string; times: (number | null)[] };
}

export type PracticeMode = 'pronunciation' | 'pitch' | 'total';

export function bestOf(song: Song, mode: PracticeMode): number | undefined {
  return song.best?.[mode] ?? (mode === 'total' ? song.bestScore : undefined);
}

// Returns `song` itself when neither best improved, so callers can skip saving.
export function withBest(song: Song, mode: PracticeMode, score: number, scoreWithTiming?: number): Song {
  let next = song;
  const prev = bestOf(song, mode);
  if (prev === undefined || score > prev) next = { ...next, best: { ...next.best, [mode]: score } };
  const prevTiming = song.bestWithTiming?.[mode];
  if (scoreWithTiming !== undefined && (prevTiming === undefined || scoreWithTiming > prevTiming)) {
    next = { ...next, bestWithTiming: { ...next.bestWithTiming, [mode]: scoreWithTiming } };
  }
  return next;
}

export async function listSongs(): Promise<Song[]> {
  const all = await tx<Song[]>(SONGS, 'readonly', (t) => t.objectStore(SONGS).getAll() as IDBRequest<Song[]>);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export function getSong(id: string): Promise<Song | undefined> {
  return tx<Song | undefined>(SONGS, 'readonly', (t) => t.objectStore(SONGS).get(id) as IDBRequest<Song | undefined>);
}

export async function putSong(song: Song): Promise<void> {
  await tx(SONGS, 'readwrite', (t) => t.objectStore(SONGS).put(song));
}

// The song's attempt records go with it: without the reference pitch they
// can't be redrawn.
export async function deleteSong(id: string): Promise<void> {
  await tx([SONGS, ATTEMPTS], 'readwrite', (t) => {
    t.objectStore(SONGS).delete(id);
    deleteAttemptsIn(t, songKey(id));
  });
}

// Drops the audio clips of every song, keeping everything else.
export async function removeAllSongAudio(): Promise<void> {
  const songs = await listSongs();
  await tx(SONGS, 'readwrite', (t) => {
    const store = t.objectStore(SONGS);
    for (const s of songs) {
      if (!s.original && !s.vocals) continue;
      const rest = { ...s };
      delete rest.original;
      delete rest.vocals;
      store.put(rest);
    }
  });
}

// Clears every song's best scores (used when all records are deleted).
export async function clearSongBests(): Promise<void> {
  const songs = await listSongs();
  await tx(SONGS, 'readwrite', (t) => {
    const store = t.objectStore(SONGS);
    for (const s of songs) {
      const rest = { ...s };
      delete rest.best;
      delete rest.bestWithTiming;
      delete rest.bestScore;
      store.put(rest);
    }
  });
}

// Deletes every song and every song attempt.
export async function deleteAllSongs(): Promise<void> {
  await tx([SONGS, ATTEMPTS], 'readwrite', (t) => {
    t.objectStore(SONGS).clear();
    const attempts = t.objectStore(ATTEMPTS);
    // Primary keys of the attempts whose item is any song (songKey prefix).
    const req = attempts.index('item').getAllKeys(IDBKeyRange.bound('s:', 's:\uffff'));
    req.onsuccess = () => {
      for (const key of req.result) attempts.delete(key);
    };
  });
}

export function newSongId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
