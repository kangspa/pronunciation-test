import { useCallback, useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { formatBytes } from '../asr/modelStore';
import { clearAttempts, listAllAttempts } from '../lib/attemptStore';
import { clearBestScores } from '../lib/settings';
import { clearSongBests, deleteAllSongs, listSongs, removeAllSongAudio } from '../lib/songStore';
import { ModelManager } from './ModelManager';

interface DataView {
  songs: number;
  songAudioBytes: number;
  songsWithAudio: number;
  attempts: number;
  twisterAttempts: number;
}

async function scanData(): Promise<DataView> {
  const [songs, attempts] = await Promise.all([listSongs(), listAllAttempts()]);
  let songAudioBytes = 0;
  let songsWithAudio = 0;
  for (const s of songs) {
    const bytes = (s.original?.size ?? 0) + (s.vocals?.size ?? 0);
    songAudioBytes += bytes;
    if (bytes) songsWithAudio++;
  }
  return {
    songs: songs.length,
    songAudioBytes,
    songsWithAudio,
    attempts: attempts.length,
    twisterAttempts: attempts.filter((a) => a.item.startsWith('t:')).length,
  };
}

function DataManager({ onBestReset }: { onBestReset: () => void }) {
  const [data, setData] = useState<DataView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await scanData());
    } catch {
      setError('이 브라우저에서는 저장된 데이터를 읽을 수 없어요.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    scanData()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError('이 브라우저에서는 저장된 데이터를 읽을 수 없어요.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (question: string, action: () => Promise<void>) => {
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      await refresh();
      setBusy(false);
    }
  };

  return (
    <div className="settings-box data-box">
      <h2>연습 데이터</h2>
      {data && (
        <ul className="data-list">
          <li>
            <span>
              <b>연습 기록</b> {data.attempts}개 (발음 {data.twisterAttempts} · 노래 {data.attempts - data.twisterAttempts})
            </span>
            <button
              className="button button-small danger-outline"
              disabled={busy || data.attempts === 0}
              onClick={() =>
                void run('모든 연습 기록과 최고 점수를 삭제할까요?\n저장한 노래(가사·음정)는 남아요.', async () => {
                  await clearAttempts();
                  await clearSongBests();
                  clearBestScores();
                  onBestReset();
                })
              }
            >
              기록 전체 삭제
            </button>
          </li>
          <li>
            <span>
              <b>노래 음원</b> {data.songsWithAudio}곡 · {formatBytes(data.songAudioBytes)}
              <span className="muted small"> 원곡 구간·보컬 재생용 파일이에요. 지워도 가사, 원곡 음정, 기록은 남아요.</span>
            </span>
            <button
              className="button button-small"
              disabled={busy || data.songsWithAudio === 0}
              onClick={() => void run('모든 노래의 음원 파일만 삭제할까요?\n가사, 원곡 음정, 기록은 그대로 남아요.', removeAllSongAudio)}
            >
              음원만 삭제
            </button>
          </li>
          <li>
            <span>
              <b>저장한 노래</b> {data.songs}곡
            </span>
            <button
              className="button button-small danger-outline"
              disabled={busy || data.songs === 0}
              onClick={() => void run('저장한 모든 노래와 노래 연습 기록을 삭제할까요?', deleteAllSongs)}
            >
              노래 전체 삭제
            </button>
          </li>
        </ul>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

export function LocalPage({
  onBestReset,
  ...modelProps
}: ComponentProps<typeof ModelManager> & { onBestReset: () => void }) {
  return (
    <section>
      <div className="hero">
        <h1>로컬 관리</h1>
        <p>
          모든 데이터는 이 브라우저에만 저장돼요. 다른 기기나 브라우저와 공유되지 않고, 브라우저의 사이트 데이터를
          지우면 함께 사라져요.
        </p>
      </div>
      <DataManager onBestReset={onBestReset} />
      <ModelManager {...modelProps} />
    </section>
  );
}
