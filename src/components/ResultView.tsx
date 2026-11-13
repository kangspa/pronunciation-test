import { useState } from 'react';
import { grade } from '../lib/scoring';
import type { Analysis, CharResult } from '../lib/scoring';

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

function tone(score: number) {
  if (score >= 0.9) return 'great';
  if (score >= 0.7) return 'good';
  if (score >= 0.4) return 'ok';
  return 'low';
}

export function ResultView({ analysis, elapsedMs }: { analysis: Analysis; elapsedMs: number }) {
  const [selected, setSelected] = useState<number | null>(null);
  const g = grade(analysis.overall);
  const ring = Math.max(0, Math.min(100, analysis.overall));

  const insertionsAfter = new Map<number, string[]>();
  for (const ins of analysis.insertions) {
    insertionsAfter.set(ins.after, [...(insertionsAfter.get(ins.after) ?? []), ins.char]);
  }

  let index = -1;
  const detail: CharResult | null = selected !== null ? analysis.chars[selected] : null;

  return (
    <div className="result">
      <div className="score-row">
        <div className={`score-ring tone-${g.tone}`} style={{ '--p': ring } as React.CSSProperties}>
          <div className="score-ring-inner">
            <strong>{analysis.overall.toFixed(1)}</strong>
            <span>/ 100</span>
          </div>
        </div>
        <div className="score-summary">
          <p className={`grade tone-${g.tone}`}>{g.label}</p>
          <dl>
            <div>
              <dt>평균 정확도</dt>
              <dd>{analysis.accuracy.toFixed(1)}%</dd>
            </div>
            <div>
              <dt>평균 신뢰도</dt>
              <dd>{analysis.confidence.toFixed(1)}%</dd>
            </div>
            {analysis.insertions.length > 0 && (
              <div>
                <dt>추가로 들린 글자</dt>
                <dd>{analysis.insertions.length}개</dd>
              </div>
            )}
          </dl>
          <p className="muted small">분석 {(elapsedMs / 1000).toFixed(1)}초</p>
        </div>
      </div>

      <div className="heard">
        <span className="label">모델이 들은 문장</span>
        <p>{analysis.heardText || '(인식된 문장 없음)'}</p>
      </div>

      <div className="tiles" aria-label="글자별 결과">
        {insertionsAfter.get(-1)?.map((c, i) => (
          <span key={`ins--1-${i}`} className="insertion" title="원문에 없는데 들린 소리">
            +{c}
          </span>
        ))}
        {analysis.words.map((word, wi) => (
          <div className="word" key={wi}>
            {word.map((c) => {
              index++;
              const i = index;
              const mismatch = c.heard !== c.target;
              return (
                <span className="tile-wrap" key={i}>
                  <button
                    className={`tile tone-${tone(c.score)} ${selected === i ? 'selected' : ''}`}
                    onClick={() => setSelected(selected === i ? null : i)}
                    title={`정확도 ${pct(c.accuracy)} · 신뢰도 ${pct(c.confidence)}`}
                  >
                    <span className="tile-target">{c.target}</span>
                    <span className={`tile-heard ${mismatch ? 'mismatch' : ''}`}>{c.heard ?? '–'}</span>
                    <span className="tile-score">{pct(c.score)}</span>
                  </button>
                  {insertionsAfter.get(i)?.map((x, k) => (
                    <span key={`ins-${i}-${k}`} className="insertion" title="원문에 없는데 들린 소리">
                      +{x}
                    </span>
                  ))}
                </span>
              );
            })}
          </div>
        ))}
      </div>

      {detail ? (
        <div className="detail">
          <strong className="detail-char">{detail.target}</strong>
          <div>
            <p>
              {detail.heard === null
                ? '이 글자는 들리지 않았어요.'
                : detail.heard === detail.target
                  ? `「${detail.heard}」로 정확히 들렸어요.`
                  : `「${detail.heard}」처럼 들렸어요.`}
            </p>
            <p className="muted small">
              정확도 {pct(detail.accuracy)} × 신뢰도 {pct(detail.confidence)} = 점수 {pct(detail.score)}
              {detail.heardConfidence !== null && ` · 들린 글자 확신도 ${pct(detail.heardConfidence)}`}
            </p>
          </div>
        </div>
      ) : (
        <p className="muted small">글자를 누르면 자세한 점수를 볼 수 있어요.</p>
      )}

      <details className="explain">
        <summary>점수는 어떻게 계산되나요?</summary>
        <ul>
          <li>
            <b>정확도</b>: 모델이 들은 글자가 원문 글자와 얼마나 같은지예요. 한글은 초성·중성·종성을 따로 비교해서
            「장」을 「정」으로 읽으면 67%가 돼요.
          </li>
          <li>
            <b>신뢰도</b>: 녹음을 들은 모델이 「여기서 원문 글자가 발음됐다」고 판단한 확률이에요.
          </li>
          <li>
            <b>글자 점수</b> = 정확도 × 신뢰도. <b>전체 점수</b>는 글자 점수의 평균이고, 원문에 없는 소리가 들리면 그만큼
            감점돼요. 모든 글자의 정확도와 신뢰도가 100%일 때만 100점이 돼요.
          </li>
          <li>
            음성 인식 모델은 자연스러운 문장 쪽으로 보정하려는 경향이 있어서, 사람 귀와 다르게 판단할 수 있어요.
          </li>
        </ul>
      </details>
    </div>
  );
}
