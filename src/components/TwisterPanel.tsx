import { useEffect, useRef, useState } from 'react';
import { asrClient, loadPercent } from '../asr/asrClient';
import type { ModelState } from '../asr/asrClient';
import { findPreset } from '../asr/models';
import { LEVEL_LABEL } from '../data/twisters';
import type { Twister } from '../data/twisters';
import { MAX_SECONDS, prepareSpeech, startRecording } from '../lib/recorder';
import type { ActiveRecording } from '../lib/recorder';
import { analyze } from '../lib/scoring';
import type { Analysis } from '../lib/scoring';
import { recordBestScore } from '../lib/settings';
import { ResultView } from './ResultView';

interface Props {
  twister: Twister;
  modelState: ModelState;
  selectedModelId: string;
  onLoadModel: (id: string) => void;
  onBest: (best: Record<string, number>) => void;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'analyzing' }
  | { kind: 'done'; analysis: Analysis; ms: number }
  | { kind: 'error'; message: string };

export function TwisterPanel({ twister, modelState, selectedModelId, onLoadModel, onBest }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const recRef = useRef<ActiveRecording | null>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const startingRef = useRef(false);

  const ready = modelState.status === 'ready';
  const preset = findPreset(selectedModelId);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recRef.current?.cancel();
      recRef.current = null;
    };
  }, []);
  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const finish = async () => {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    setPhase({ kind: 'analyzing' });
    try {
      const recording = await rec.stop();
      if (!mountedRef.current) {
        URL.revokeObjectURL(recording.url);
        return;
      }
      setAudioUrl(recording.url);
      const speech = prepareSpeech(recording.samples);
      if (!speech) {
        setPhase({ kind: 'error', message: '목소리가 잘 들리지 않았어요. 마이크에 조금 더 가까이 말해 주세요.' });
        return;
      }
      const t0 = performance.now();
      const output = await asrClient.score(speech, twister.text, twister.language);
      const analysis = analyze(twister.text, output);
      onBest(recordBestScore(twister.id, analysis.overall));
      if (mountedRef.current) setPhase({ kind: 'done', analysis, ms: performance.now() - t0 });
    } catch (err) {
      if (mountedRef.current) setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  // Live meter + timer + auto-stop at Whisper's 30 s window.
  useEffect(() => {
    if (phase.kind !== 'recording') return;
    let raf = 0;
    const tick = () => {
      const rec = recRef.current;
      if (!rec) return;
      const secs = (performance.now() - phase.startedAt) / 1000;
      setElapsed(secs);
      if (meterRef.current) meterRef.current.style.transform = `scaleX(${rec.level()})`;
      if (secs >= MAX_SECONDS) {
        void finish();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // finish only reads refs and stable props; re-subscribing on each render would restart the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const start = async () => {
    // getUserMedia can take a while (permission prompt); ignore repeat clicks.
    if (startingRef.current || recRef.current) return;
    startingRef.current = true;
    try {
      const rec = await startRecording();
      if (!mountedRef.current) {
        rec.cancel();
        return;
      }
      recRef.current = rec;
      setElapsed(0);
      setPhase({ kind: 'recording', startedAt: performance.now() });
    } catch (err) {
      if (!mountedRef.current) return;
      const denied = err instanceof DOMException && err.name === 'NotAllowedError';
      setPhase({
        kind: 'error',
        message: denied
          ? '마이크 권한이 거부됐어요. 주소창의 사이트 설정에서 마이크를 허용해 주세요.'
          : `마이크를 시작할 수 없어요: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      startingRef.current = false;
    }
  };

  return (
    <section className="panel">
      <a className="back" href="#/">
        ← 목록
      </a>

      <div className="phrase-card">
        <div className="phrase-meta">
          <span className={`level level-${twister.level}`}>{LEVEL_LABEL[twister.level]}</span>
          <span className="phrase-title">{twister.title}</span>
        </div>
        <p className="phrase">{twister.text}</p>
      </div>

      {!ready ? (
        <div className="gate">
          {modelState.status === 'loading' ? (
            <>
              <p>
                {findPreset(modelState.modelId)?.label} 불러오는 중… {loadPercent(modelState).toFixed(0)}%
              </p>
              <div className="progress">
                <div className="progress-bar" style={{ width: `${loadPercent(modelState)}%` }} />
              </div>
            </>
          ) : (
            <>
              {modelState.status === 'error' && <p className="error">모델 오류: {modelState.message}</p>}
              <p>발음을 분석하려면 음성 인식 모델이 필요해요.</p>
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
            </>
          )}
        </div>
      ) : (
        <div className="recorder">
          {phase.kind === 'recording' ? (
            <>
              <button className="record-button recording" onClick={() => void finish()} aria-label="녹음 정지">
                <span className="record-icon stop" />
              </button>
              <div className="rec-info">
                <span className="rec-time">
                  {elapsed.toFixed(1)}초 / {MAX_SECONDS}초
                </span>
                <div className="meter">
                  <div className="meter-fill" ref={meterRef} />
                </div>
                <span className="hint">다 읽었으면 정지 버튼을 눌러 주세요</span>
              </div>
            </>
          ) : (
            <>
              <button
                className="record-button"
                onClick={() => void start()}
                disabled={phase.kind === 'analyzing'}
                aria-label="녹음 시작"
              >
                <span className="record-icon" />
              </button>
              <div className="rec-info">
                <span className="rec-time">
                  {phase.kind === 'analyzing' ? '분석 중…' : phase.kind === 'done' ? '다시 녹음하기' : '눌러서 녹음 시작'}
                </span>
                <span className="hint">
                  {phase.kind === 'analyzing'
                    ? '기기 성능에 따라 몇 초에서 수십 초 걸릴 수 있어요'
                    : '위 문구를 또박또박 소리 내어 읽어 주세요'}
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {phase.kind === 'error' && <p className="error">{phase.message}</p>}
      {audioUrl && phase.kind !== 'recording' && <audio className="playback" controls src={audioUrl} />}
      {phase.kind === 'done' && <ResultView analysis={phase.analysis} elapsedMs={phase.ms} />}
    </section>
  );
}
