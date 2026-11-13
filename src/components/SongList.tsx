import { useEffect, useState } from 'react';
import { bestOf, deleteSong, listSongs } from '../lib/songStore';
import type { PracticeMode, Song } from '../lib/songStore';

const BEST_LABELS: [PracticeMode, string][] = [
  ['pronunciation', '발음'],
  ['pitch', '음정'],
  ['total', '종합'],
];

const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;

export function SongList() {
  const [songs, setSongs] = useState<Song[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listSongs()
      .then((s) => {
        if (!cancelled) setSongs(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const remove = async (song: Song) => {
    if (!window.confirm(`「${song.title}」을(를) 삭제할까요?`)) return;
    try {
      await deleteSong(song.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setVersion((v) => v + 1);
  };

  return (
    <section>
      <div className="hero">
        <h1>노래로 발음과 음정을 연습해요</h1>
        <p>
          노래 파일에서 구간을 골라 저장해 두면, 따라 부른 녹음의 발음(가사)과 음정을 원곡 보컬과 비교해 점수를 알려줘요.
        </p>
        <a className="button button-primary" href="#/songs/new">
          + 노래 추가
        </a>
      </div>
      {error && <p className="error">{error}</p>}
      {songs && songs.length === 0 && <p className="muted">아직 저장된 노래가 없어요.</p>}
      <ul className="card-grid">
        {songs?.map((s) => (
          <li key={s.id}>
            <div className="card song-card">
              <a href={`#/s/${s.id}`} className="card-link">
                <div className="card-head">
                  <span className="tag">
                    {fmt(s.start)}–{fmt(s.end)}
                  </span>
                </div>
                <h2>{s.title}</h2>
                <p className="clamp">{s.lyrics || '(가사 없음 · 음정만 평가)'}</p>
                <p className="best-row">
                  {BEST_LABELS.map(([mode, label]) => {
                    const b = bestOf(s, mode);
                    return (
                      <span key={mode} className="tag">
                        {label} {b !== undefined ? `${b.toFixed(0)}점` : '–'}
                      </span>
                    );
                  })}
                </p>
              </a>
              <button className="link-button danger small" onClick={() => void remove(s)}>
                삭제
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
