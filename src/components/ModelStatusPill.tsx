import { loadPercent } from '../asr/asrClient';
import type { ModelState } from '../asr/asrClient';
import { findPreset } from '../asr/models';

export function ModelStatusPill({ state }: { state: ModelState }) {
  const name = 'modelId' in state ? (findPreset(state.modelId)?.label ?? state.modelId) : '';
  let text = '모델 선택';
  let tone = 'idle';
  if (state.status === 'loading') {
    text = `${name} 불러오는 중 ${loadPercent(state).toFixed(0)}%`;
    tone = 'loading';
  } else if (state.status === 'ready') {
    text = `${name} 준비됨`;
    tone = 'ready';
  } else if (state.status === 'error') {
    text = '모델 오류';
    tone = 'error';
  }
  return (
    <a className={`pill pill-${tone}`} href="#/models">
      <span className="pill-dot" aria-hidden />
      {text}
    </a>
  );
}
