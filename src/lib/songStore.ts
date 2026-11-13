// Analysed song segments live in IndexedDB: each holds a pitch track and two
// short WAV clips (a few MB), too much for localStorage.
const DB_NAME = 'pronunciation-test';
const STORE = 'songs';

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

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB를 열 수 없어요.'));
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error ?? req.error ?? new Error('저장소 작업에 실패했어요.'));
      t.onabort = () => reject(t.error ?? new Error('저장소 작업이 취소됐어요.'));
    });
  } finally {
    db.close();
  }
}

export async function listSongs(): Promise<Song[]> {
  const all = await tx<Song[]>('readonly', (s) => s.getAll() as IDBRequest<Song[]>);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export function getSong(id: string): Promise<Song | undefined> {
  return tx<Song | undefined>('readonly', (s) => s.get(id) as IDBRequest<Song | undefined>);
}

export async function putSong(song: Song): Promise<void> {
  await tx('readwrite', (s) => s.put(song));
}

export async function deleteSong(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

export function newSongId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
