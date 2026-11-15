import type { CSSProperties, ReactNode } from 'react';
import { grade } from '../lib/scoring';

export function ScoreHeader({ score, caption, children }: { score: number; caption: string; children: ReactNode }) {
  const g = grade(score);
  return (
    <div className="score-row">
      <div className={`score-ring tone-${g.tone}`} style={{ '--p': score } as CSSProperties}>
        <div className="score-ring-inner">
          <strong>{score.toFixed(1)}</strong>
          <span>{caption}</span>
        </div>
      </div>
      <div className="score-summary">
        <p className={`grade tone-${g.tone}`}>{g.label}</p>
        <dl>{children}</dl>
      </div>
    </div>
  );
}
