import { useState } from 'react';
import type { PitchComparison } from '../audio/pitchCompare';
import { keyLabel, relativeLabel } from '../lib/songScores';
import { PitchChart, TimingLegend } from './PitchChart';

type View = 'absolute' | 'relative';

const cents = (c: number) => `${c > 0 ? '+' : ''}${c.toFixed(0)}센트`;

// Absolute and relative pitch side by side, with one chart that switches
// between the two overlays. Shared by 30 s practice and the full-song test.
export function PitchResult({
  pitch,
  reference,
  frameSeconds,
  forReference = false,
  pxPerSecond,
}: {
  pitch: PitchComparison;
  reference: Float32Array;
  frameSeconds: number;
  // Measured alongside the pronunciation test; not part of its score.
  forReference?: boolean;
  pxPerSecond?: number;
}) {
  const [view, setView] = useState<View>('absolute');
  const rel = pitch.relative;
  const shown = view === 'relative' && rel ? rel : pitch;
  const shift = view === 'relative' && rel ? rel.keyShift : (pitch.keyShift ?? 0);
  const moved = Math.abs(shift) >= 0.25 || shown.octaveShift !== 0;

  return (
    <div className="result">
      <h3>음정 비교{forReference && ' (참고용 · 발음 평가 점수에는 반영 안 됨)'}</h3>
      <div className="pitch-pair">
        <div className={view === 'absolute' ? 'active' : ''}>
          <span className="pitch-pair-label">절대 음정 · {keyLabel(pitch)}</span>
          <strong>{pitch.score.toFixed(1)}</strong>
          <span className="muted small">
            50센트 이내 {pitch.hitRate.toFixed(0)}% · 평균 {cents(pitch.meanCents)}
          </span>
        </div>
        {rel && (
          <div className={view === 'relative' ? 'active' : ''}>
            <span className="pitch-pair-label">상대 음정 · 키 무관</span>
            <strong>{rel.score.toFixed(1)}</strong>
            <span className="muted small">{relativeLabel(rel)}</span>
          </div>
        )}
      </div>
      <p className="muted small">
        {Math.abs(pitch.meanCents) >= 30 && (pitch.meanCents > 0 ? '절대 음정 기준으로 전체적으로 조금 높게 불렀어요. ' : '절대 음정 기준으로 전체적으로 조금 낮게 불렀어요. ')}
        {pitch.octaveShift !== 0 &&
          `원곡보다 ${Math.abs(pitch.octaveShift)}옥타브 ${pitch.octaveShift > 0 ? '낮게' : '높게'} 불러서 옥타브를 맞춰 비교했어요.`}
      </p>
      {rel && (
        <div className="filter-chips" role="tablist" aria-label="그래프 기준">
          {(
            [
              ['absolute', '절대 음정으로 보기'],
              ['relative', '상대 음정으로 보기'],
            ] as [View, string][]
          ).map(([v, label]) => (
            <button key={v} role="tab" aria-selected={view === v} className={`chip ${view === v ? 'active' : ''}`} onClick={() => setView(v)}>
              {label}
            </button>
          ))}
        </div>
      )}
      <PitchChart
        reference={reference}
        frameSeconds={frameSeconds}
        user={shown.alignedUser}
        frameScores={shown.frameScores}
        timingErrors={pitch.timingErrors}
        pxPerSecond={pxPerSecond}
      />
      <p className="legend small">
        <span className="swatch ref" /> 원곡 보컬 <span className="swatch great" /> 정확 <span className="swatch ok" /> 조금 벗어남{' '}
        <span className="swatch low" /> 많이 벗어남
        {moved && ' · 내 음정은 키·옥타브 차이만큼 옮겨서 겹쳐 그렸어요'}
        {pxPerSecond && ' · 옆으로 밀어서 곡 전체를 볼 수 있어요'}
      </p>
      {pitch.timingErrors && <TimingLegend />}
      <details className="explain">
        <summary>음정 점수는 어떻게 계산되나요?</summary>
        <ul>
          <li>원곡 보컬과 녹음에서 16ms마다 음 높이를 추출해 반음 단위로 비교해요.</li>
          <li>박자가 조금 빠르거나 느려도 따라가도록 시간축을 맞춘 뒤(DTW) 비교하고, 옥타브 차이는 자동으로 맞춰요.</li>
          <li>
            <b>절대 음정</b>은 채점 키 설정(원래 키, 또는 노래방처럼 올리고 내린 키)대로 비교해요. <b>상대 음정</b>은 가장 잘 맞는
            키를 찾아(반음보다 작은 차이까지) 옮긴 뒤 비교해서, 키와 상관없이 음의 높낮이 변화만 채점해요. 둘은 항상 함께
            채점하고, 종합 점수에는 절대 음정을 써요.
          </li>
          <li>
            원곡이 소리 내는 구간마다 반음의 절반(50센트) 이내면 만점, 2반음 이상 벗어나면 0점이에요. 그 구간에 소리를 내지
            않았어도 0점이에요.
          </li>
          <li>녹음 앞의 무음·숨소리·잡음과 상관없이, 곡 전체에서 소리 나는 패턴을 비교해 시작 위치를 맞춰요.</li>
        </ul>
      </details>
    </div>
  );
}
