import { useCallback, useEffect, useState } from 'react';
import { loadPercent } from '../asr/asrClient';
import type { ModelState } from '../asr/asrClient';
import { MODEL_PRESETS } from '../asr/models';
import { AUDIO_MODELS } from '../audio/audioModels';
import {
  cacheSupported,
  clearAll,
  deleteAudioModels,
  deleteModel,
  formatBytes,
  inspectAudioModels,
  inspectCache,
  requestPersistence,
  storageEstimate,
} from '../asr/modelStore';
import type { CachedModelInfo } from '../asr/modelStore';
import type { Settings } from '../lib/settings';

interface Props {
  settings: Settings;
  modelState: ModelState;
  onLoad: (id: string) => void;
  onChangeSettings: (patch: Partial<Settings>) => void;
}

interface StorageView {
  models: Record<string, CachedModelInfo>;
  otherBytes: number;
  unavailable: boolean;
  usage: number | null;
  quota: number | null;
  persisted: boolean;
  // Saved bytes per song analysis model id.
  audio: Record<string, number>;
}

const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;

async function scan(): Promise<StorageView> {
  const [cache, est, audio] = await Promise.all([inspectCache(MODEL_PRESETS), storageEstimate(), inspectAudioModels()]);
  return { ...cache, audio, usage: est?.usage ?? null, quota: est?.quota ?? null, persisted: est?.persisted ?? false };
}

export function ModelManager({ settings, modelState, onLoad, onChangeSettings }: Props) {
  const [storage, setStorage] = useState<StorageView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStorage(await scan());
  }, []);

  // Scan on open, and again once a download finishes so the "저장됨" badge appears.
  const isReady = modelState.status === 'ready';
  useEffect(() => {
    let cancelled = false;
    void scan().then((view) => {
      if (!cancelled) setStorage(view);
    });
    return () => {
      cancelled = true;
    };
  }, [isReady]);

  const remove = async (id: string) => {
    const preset = MODEL_PRESETS.find((p) => p.id === id);
    if (!preset || !window.confirm(`${preset.label} 모델을 이 브라우저에서 삭제할까요?\n다음에 사용할 때 다시 다운로드해야 해요.`)) return;
    await runBusy(id, () => deleteModel(preset));
  };

  const removeAll = async () => {
    if (!window.confirm('저장된 모든 모델과 런타임 파일을 삭제할까요?')) return;
    await runBusy('all', clearAll);
  };

  const togglePersist = async () => {
    await runBusy('persist', async () => {
      await requestPersistence();
    });
  };

  // Always clears `busy`, even when the storage call throws, so the buttons don't stay disabled.
  const runBusy = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      await refresh().catch(() => {});
      setBusy(null);
    }
  };

  return (
    <section className="models">
      <a className="back" href="#/">
        ← 목록
      </a>
      <h1>음성 인식 모델</h1>
      <p className="muted">
        모델은 Hugging Face에서 한 번 내려받아 이 브라우저 안에서만 실행돼요. 저장해 두면 다음 방문부터는 다운로드 없이
        바로 쓸 수 있어요.
      </p>

      <div className="settings-box">
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.saveModels}
            onChange={(e) => onChangeSettings({ saveModels: e.target.checked })}
            disabled={!cacheSupported()}
          />
          <span>
            <b>모델을 브라우저에 저장하기</b>
            <span className="muted small">
              {' '}
              끄면 페이지를 열 때마다 모델을 새로 내려받아요. (다음에 불러올 때부터 적용)
            </span>
          </span>
        </label>
        {storage?.unavailable && (
          <p className="error small">
            이 브라우저 환경에서는 모델을 저장할 수 없어요. (시크릿 모드이거나, 인증서 경고가 있는 HTTPS 주소일 수
            있어요.) 모델은 매번 새로 내려받게 됩니다.
          </p>
        )}
        {storage && (
          <div className="storage-line small">
            <span>
              이 사이트 저장 공간: {storage.usage !== null ? formatBytes(storage.usage) : '알 수 없음'}
              {storage.quota ? ` / 사용 가능 ${formatBytes(storage.quota)}` : ''}
            </span>
            {storage.persisted ? (
              <span className="tag tag-ok">영구 저장 허용됨</span>
            ) : (
              <button className="link-button" onClick={() => void togglePersist()}>
                브라우저가 자동 삭제하지 않도록 요청
              </button>
            )}
          </div>
        )}
      </div>

      {actionError && <p className="error small">저장 공간 작업에 실패했어요: {actionError}</p>}

      <ul className="model-list">
        {MODEL_PRESETS.map((p) => {
          const info = storage?.models[p.id];
          const active = 'modelId' in modelState && modelState.modelId === p.id;
          const isReady = active && modelState.status === 'ready';
          const isLoading = active && modelState.status === 'loading';
          const unsupported = p.device === 'webgpu' && !hasWebGPU;
          return (
            <li key={p.id} className={`model-item ${settings.modelId === p.id ? 'chosen' : ''}`}>
              <div className="model-main">
                <div className="model-title">
                  <h2>{p.label}</h2>
                  {p.recommended && <span className="tag tag-accent">추천</span>}
                  <span className="tag">{p.device === 'webgpu' ? 'WebGPU' : 'CPU (WASM)'}</span>
                  <span className="tag">약 {p.sizeMB}MB</span>
                </div>
                <p className="muted small">{p.description}</p>
                <p className="small">
                  {info?.complete ? (
                    <span className="tag tag-ok">저장됨 · {formatBytes(info.bytes)}</span>
                  ) : info && info.files.length > 0 ? (
                    <span className="tag tag-warn">일부만 저장됨 · {formatBytes(info.bytes)}</span>
                  ) : (
                    <span className="muted">저장 안 됨</span>
                  )}
                  {unsupported && <span className="tag tag-warn">이 브라우저는 WebGPU 미지원</span>}
                </p>
                {isLoading && (
                  <div className="progress">
                    <div className="progress-bar" style={{ width: `${loadPercent(modelState)}%` }} />
                  </div>
                )}
                {active && modelState.status === 'error' && <p className="error small">{modelState.message}</p>}
              </div>
              <div className="model-actions">
                {isReady ? (
                  <span className="tag tag-ok">사용 중</span>
                ) : (
                  <button
                    className="button button-primary"
                    onClick={() => onLoad(p.id)}
                    disabled={isLoading || unsupported}
                  >
                    {isLoading
                      ? `${loadPercent(modelState).toFixed(0)}%`
                      : info?.complete
                        ? '불러오기'
                        : settings.saveModels
                          ? '다운로드 후 사용'
                          : '임시로 사용'}
                  </button>
                )}
                {info && info.files.length > 0 && (
                  <button className="button button-danger" onClick={() => void remove(p.id)} disabled={busy !== null}>
                    삭제
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <h2 className="section-title">노래 분석 모델</h2>
      <p className="muted small">
        노래 구간을 분석할 때 자동으로 내려받아요. 보컬 분리(Spleeter)와 음정 추적(SwiftF0)에 쓰여요.
      </p>
      <div className="model-item">
        <div className="model-main">
          {AUDIO_MODELS.map((m) => (
            <p key={m.id} className="small audio-model-row">
              <b>{m.label}</b> <span className="tag">약 {m.sizeMB}MB</span>
              {storage?.audio[m.id] ? (
                <span className="tag tag-ok">저장됨 · {formatBytes(storage.audio[m.id])}</span>
              ) : (
                <span className="muted">저장 안 됨</span>
              )}
            </p>
          ))}
        </div>
        <div className="model-actions">
          {storage && Object.keys(storage.audio).length > 0 && (
            <button
              className="button button-danger"
              disabled={busy !== null}
              onClick={() => {
                if (window.confirm('노래 분석 모델을 삭제할까요? 다음에 분석할 때 다시 내려받아요.')) {
                  void runBusy('audio', deleteAudioModels);
                }
              }}
            >
              삭제
            </button>
          )}
        </div>
      </div>

      {storage && (
        <div className="danger-zone">
          <span className="muted small">
            런타임 등 기타 파일 {formatBytes(storage.otherBytes)}
          </span>
          <button className="button button-danger" onClick={() => void removeAll()} disabled={busy !== null}>
            저장된 파일 모두 삭제
          </button>
        </div>
      )}
      <p className="muted small">
        삭제해도 현재 불러온 모델은 페이지를 새로 고칠 때까지 메모리에 남아 있어요.
      </p>
    </section>
  );
}
