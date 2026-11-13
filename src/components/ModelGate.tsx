import { loadPercent } from '../asr/asrClient';
import type { ModelState } from '../asr/asrClient';
import { findPreset } from '../asr/models';

interface Props {
  modelState: ModelState;
  selectedModelId: string;
  onLoadModel: (id: string) => void;
  reason: string;
}

// Shown in place of the recorder until a Whisper model is ready.
export function ModelGate({ modelState, selectedModelId, onLoadModel, reason }: Props) {
  const preset = findPreset(selectedModelId);
  if (modelState.status === 'loading') {
    return (
      <div className="gate">
        <p>
          {findPreset(modelState.modelId)?.label} 불러오는 중… {loadPercent(modelState).toFixed(0)}%
        </p>
        <div className="progress">
          <div className="progress-bar" style={{ width: `${loadPercent(modelState)}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div className="gate">
      {modelState.status === 'error' && <p className="error">모델 오류: {modelState.message}</p>}
      <p>{reason}</p>
      <div className="gate-actions">
        {preset && (
          <button className="button button-primary" onClick={() => onLoadModel(preset.id)}>
            {preset.label} 불러오기 (약 {preset.sizeMB}MB)
          </button>
        )}
        <a className="button" href="#/models">
          다른 모델 고르기
        </a>
      </div>
    </div>
  );
}
