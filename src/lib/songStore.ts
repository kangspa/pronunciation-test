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
  original: Blob;
  vocals: Blob;
  best?: Partial<Record<PracticeMode, number>>;
  // Combined best saved before per-mode scores existed.
  bestScore?: number;
}

export type PracticeMode = 'pronunciation' | 'pitch' | 'total';

export function bestOf(song: Song, mode: PracticeMode): number | undefined {
  return song.best?.[mode] ?? (mode === 'total' ? song.bestScore : undefined);
}

export function withBest(song: Song, mode: PracticeMode, score: number): Song {
  const prev = bestOf(song, mode);
  if (prev !== undefined && prev >= score) return song;
  return { ...song, best: { ...song.best, [mode]: score } };
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

export function newSongId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
