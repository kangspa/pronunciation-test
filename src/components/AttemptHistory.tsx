import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Attempt } from '../lib/attemptStore';
import { grade } from '../lib/scoring';

interface Props {
  // null while loading.
  attempts: Attempt[] | null;
  // The attempt just recorded on this page, already shown in full above the list.
  latestId: string | null;
  tag?: (a: Attempt) => string | null;
  summary: (a: Attempt) => string;
  renderDetail: (a: Attempt) => ReactNode;
  onDelete: (a: Attempt) => void;
}

const PAGE = 10;

const when = (ts: number) =>
  new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function AttemptHistory({ attempts, latestId, tag, summary, renderDetail, onDelete }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);

  if (attempts === null) return null;

  return (
    <div className="result history">
      <h3>
        연습 기록 <span className="muted small">{attempts.length}회</span>
      </h3>
      {attempts.length === 0 ? (
        <p className="muted small">아직 기록이 없어요. 녹음할 때마다 결과가 여기에 쌓여요.</p>
      ) : (
        <ul className="history-list">
          {attempts.slice(0, shown).map((a) => {
            const isOpen = open === a.id;
            const t = tag?.(a);
            return (
              <li key={a.id} className={isOpen ? 'open' : ''}>
                <button className="history-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : a.id)}>
                  <span className={`history-score tone-${grade(a.score).tone}`}>{a.score.toFixed(0)}</span>
                  <span className="history-main">
                    <span className="history-meta">
                      {when(a.createdAt)}
                      {t && <span className="tag">{t}</span>}
                      {a.id === latestId && <span className="tag tag-accent">방금</span>}
                    </span>
                    <span className="history-summary">{summary(a)}</span>
                  </span>
                  <span className="history-caret" aria-hidden>
                    {isOpen ? '▲' : '▼'}
                  </span>
                </button>
                {isOpen && (
                  <div className="history-detail">
                    {renderDetail(a)}
                    <button
                      className="link-button danger small"
                      onClick={() => {
                        if (window.confirm('이 기록을 삭제할까요?')) onDelete(a);
                      }}
                    >
                      이 기록 삭제
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {attempts.length > shown && (
        <button className="button history-more" onClick={() => setShown((n) => n + PAGE)}>
          이전 기록 더 보기 ({attempts.length - shown}개 남음)
        </button>
      )}
    </div>
  );
}
