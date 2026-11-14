import { useEffect, useState } from 'react';
import { LANGUAGES } from '../data/languages';
import { LEVEL_LABEL, TWISTERS } from '../data/twisters';
import { listAllAttempts } from '../lib/attemptStore';
import type { Attempt } from '../lib/attemptStore';
import { grade } from '../lib/scoring';
import { listSongs } from '../lib/songStore';
import type { PracticeMode, Song } from '../lib/songStore';

type Filter = 'all' | 'twister' | 'song';

interface Row {
  key: string;
  kind: 'twister' | 'song';
  title: string;
  href: string;
  tags: string[];
  // Newest first.
  attempts: Attempt[];
}

const MODE_LABEL: Record<PracticeMode, string> = { pronunciation: '발음', pitch: '음정', total: '종합' };
const languageLabel = (code: string) => LANGUAGES.find((l) => l.code === code)?.label ?? code;
const DAY = 24 * 60 * 60 * 1000;

const when = (ts: number) =>
  new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function buildRows(attempts: Attempt[], songs: Song[]): Row[] {
  const byItem = new Map<string, Attempt[]>();
  for (const a of attempts) byItem.set(a.item, [...(byItem.get(a.item) ?? []), a]);
  const rows: Row[] = [];
  for (const [item, list] of byItem) {
    const [kind, id] = [item.slice(0, 1), item.slice(2)];
    if (kind === 't') {
      const t = TWISTERS.find((x) => x.id === id);
      if (!t) continue;
      rows.push({
        key: item,
        kind: 'twister',
        title: t.title,
        href: `#/t/${encodeURIComponent(id)}`,
        tags: [languageLabel(t.language), LEVEL_LABEL[t.level]],
        attempts: list,
      });
    } else {
      const s = songs.find((x) => x.id === id);
      if (!s) continue;
      rows.push({
        key: item,
        kind: 'song',
        title: s.title,
        href: `#/s/${encodeURIComponent(id)}`,
        tags: [languageLabel(s.language)],
        attempts: list,
      });
    }
  }
  return rows.sort((a, b) => b.attempts[0].createdAt - a.attempts[0].createdAt);
}

// Scores of the last attempts, oldest on the left.
function Sparkline({ attempts }: { attempts: Attempt[] }) {
  const pts = attempts.slice(0, 20).reverse();
  if (pts.length < 2) return null;
  const W = 120;
  const H = 32;
  const x = (i: number) => 2 + (i / (pts.length - 1)) * (W - 4);
  const y = (s: number) => 2 + (1 - Math.max(0, Math.min(100, s)) / 100) * (H - 4);
  const d = pts.map((a, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(a.score).toFixed(1)}`).join('');
  const last = pts[pts.length - 1];
  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`최근 ${pts.length}회 점수 추이`}>
      <path d={d} />
      <circle cx={x(pts.length - 1)} cy={y(last.score)} r="2.5" />
    </svg>
  );
}

export function RecordsPage() {
  const [data, setData] = useState<{ attempts: Attempt[]; songs: Song[]; loadedAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAllAttempts(), listSongs()])
      .then(([attempts, songs]) => {
        if (!cancelled) setData({ attempts, songs, loadedAt: Date.now() });
      })
      .catch(() => {
        if (!cancelled) setError('이 브라우저에서는 기록을 불러올 수 없어요.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = data ? buildRows(data.attempts, data.songs) : [];
  const shown = rows.filter((r) => filter === 'all' || r.kind === filter);
  const total = data?.attempts.length ?? 0;
  const week = data?.attempts.filter((a) => data.loadedAt - a.createdAt < 7 * DAY).length ?? 0;
  const days = new Set(data?.attempts.map((a) => new Date(a.createdAt).toDateString())).size;

  return (
    <section>
      <div className="hero">
        <h1>연습 기록</h1>
        <p>이 브라우저에 저장된 연습 기록이에요. 항목을 누르면 시도별 결과를 자세히 볼 수 있어요.</p>
      </div>
      {error && <p className="error">{error}</p>}
      {data && (
        <div className="record-stats">
          <div>
            <strong>{total}</strong>
            <span>전체 연습</span>
          </div>
          <div>
            <strong>{week}</strong>
            <span>최근 7일</span>
          </div>
          <div>
            <strong>{days}</strong>
            <span>연습한 날</span>
          </div>
        </div>
      )}

      <div className="filter-chips" role="tablist" aria-label="기록 종류">
        {(
          [
            ['all', '전체'],
            ['twister', '발음'],
            ['song', '노래'],
          ] as [Filter, string][]
        ).map(([f, label]) => (
          <button key={f} role="tab" aria-selected={filter === f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {label}
          </button>
        ))}
      </div>

      {data && shown.length === 0 && <p className="muted">아직 기록이 없어요. 발음이나 노래 탭에서 연습하면 여기에 쌓여요.</p>}
      <ul className="record-list">
        {shown.map((r) => {
          const latest = r.attempts[0];
          const best = Math.max(...r.attempts.map((a) => a.score));
          return (
            <li key={r.key}>
              <a className="card record-card" href={r.href}>
                <div className="record-head">
                  <span className="tag">{r.kind === 'twister' ? '발음' : '노래'}</span>
                  {r.tags.map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                  <span className="muted small record-when">{when(latest.createdAt)}</span>
                </div>
                <h2>{r.title}</h2>
                <div className="record-body">
                  <div className="record-numbers">
                    <span>
                      <b>{r.attempts.length}</b>회
                    </span>
                    {r.kind === 'twister' ? (
                      <>
                        <span>
                          최고 <b className={`tone-text-${grade(best).tone}`}>{best.toFixed(0)}</b>
                        </span>
                        <span>
                          최근 <b className={`tone-text-${grade(latest.score).tone}`}>{latest.score.toFixed(0)}</b>
                        </span>
                      </>
                    ) : (
                      // Bests come from the attempts themselves, so they always
                      // match the list on the song page.
                      (['pronunciation', 'pitch', 'total'] as PracticeMode[]).map((m) => {
                        const ofMode = r.attempts.filter((a) => a.mode === m);
                        const b = ofMode.length ? Math.max(...ofMode.map((a) => a.score)) : undefined;
                        const timed = ofMode.filter((a) => a.scoreWithTiming !== undefined).map((a) => a.scoreWithTiming!);
                        const bt = timed.length ? Math.max(...timed) : undefined;
                        return (
                          <span key={m}>
                            {MODE_LABEL[m]} <b>{b !== undefined ? b.toFixed(0) : '–'}</b>
                            {bt !== undefined && <span className="muted small"> (타이밍 포함 {bt.toFixed(0)})</span>}
                          </span>
                        );
                      })
                    )}
                  </div>
                  {r.kind === 'twister' && <Sparkline attempts={r.attempts} />}
                </div>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
