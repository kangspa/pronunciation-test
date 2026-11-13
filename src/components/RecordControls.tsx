import type { RefObject } from 'react';
import { MAX_SECONDS } from '../lib/recorder';

interface Props {
  recording: boolean;
  busy: boolean;
  elapsed: number;
  maxSeconds?: number;
  meterRef: RefObject<HTMLDivElement | null>;
  onStart: () => void;
  onStop: () => void;
  idleLabel: string;
  idleHint: string;
  busyHint?: string;
}

export function RecordControls({ recording, busy, elapsed, maxSeconds = MAX_SECONDS, meterRef, onStart, onStop, idleLabel, idleHint, busyHint }: Props) {
  if (recording) {
    return (
      <div className="recorder">
        <button className="record-button recording" onClick={onStop} aria-label="녹음 정지">
          <span className="record-icon stop" />
        </button>
        <div className="rec-info">
          <span className="rec-time">
            {elapsed.toFixed(1)}초 / {maxSeconds}초
          </span>
          <div className="meter">
            <div className="meter-fill" ref={meterRef} />
          </div>
          <span className="hint">다 끝났으면 정지 버튼을 눌러 주세요</span>
        </div>
      </div>
    );
  }
  return (
    <div className="recorder">
      <button className="record-button" onClick={onStart} disabled={busy} aria-label="녹음 시작">
        <span className="record-icon" />
      </button>
      <div className="rec-info">
        <span className="rec-time">{busy ? '분석 중…' : idleLabel}</span>
        <span className="hint">
          {busy ? (busyHint ?? '기기 성능에 따라 몇 초에서 수십 초 걸릴 수 있어요') : idleHint}
        </span>
      </div>
    </div>
  );
}
