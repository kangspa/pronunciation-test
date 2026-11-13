import { useEffect, useRef, useState } from 'react';
import { asrClient } from '../asr/asrClient';
import type { ModelState } from '../asr/asrClient';
import { LEVEL_LABEL } from '../data/twisters';
import type { Twister } from '../data/twisters';
import { useAttempts } from '../hooks/useAttempts';
import { micErrorMessage, useRecorder } from '../hooks/useRecorder';
import { newAttemptId, pronunciationSummary, twisterKey } from '../lib/attemptStore';
import type { Attempt } from '../lib/attemptStore';
import { prepareSpeech } from '../lib/recorder';
import { analyze } from '../lib/scoring';
import type { Analysis } from '../lib/scoring';
import { recordBestScore } from '../lib/settings';
import { AttemptHistory } from './AttemptHistory';
import { ModelGate } from './ModelGate';
import { RecordControls } from './RecordControls';
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
  | { kind: 'analyzing' }
  | { kind: 'done'; analysis: Analysis; ms: number }
  | { kind: 'error'; message: string };

export function TwisterPanel({ twister, modelState, selectedModelId, onLoadModel, onBest }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  // finish is declared below and changes every render; the ref lets the
  // recorder's auto-stop always call the current one.
  const finishRef = useRef<() => void>(() => {});
  const recorder = useRecorder(() => finishRef.current());
  const history = useAttempts(twisterKey(twister.id));
  const [latestId, setLatestId] = useState<string | null>(null);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const finish = async () => {
    if (!recorder.hasRecording()) return;
    setPhase({ kind: 'analyzing' });
    try {
      const recording = await recorder.stop();
      if (!recording) return;
      setAudioUrl(recording.url);
      const speech = prepareSpeech(recording.samples);
      if (!speech) {
        setPhase({ kind: 'error', message: '목소리가 잘 들리지 않았어요. 마이크에 조금 더 가까이 말해 주세요.' });
        return;
      }
      const t0 = performance.now();
      const output = await asrClient.score(speech, twister.text, twister.language);
      const analysis = analyze(twister.text, output);
      const ms = performance.now() - t0;
      onBest(recordBestScore(twister.id, analysis.overall));
      const attempt: Attempt = {
        id: newAttemptId(),
        item: twisterKey(twister.id),
        createdAt: Date.now(),
        score: analysis.overall,
        target: twister.text,
        modelId: modelState.status === 'ready' ? modelState.modelId : undefined,
        analysisMs: ms,
        pronunciation: analysis,
      };
      void history.add(attempt);
      if (recorder.isMounted()) {
        setLatestId(attempt.id);
        setPhase({ kind: 'done', analysis, ms });
      }
    } catch (err) {
      if (recorder.isMounted()) setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  useEffect(() => {
    finishRef.current = () => void finish();
  });

  const start = async () => {
    try {
      if (await recorder.start()) setPhase({ kind: 'idle' });
    } catch (err) {
      if (recorder.isMounted()) setPhase({ kind: 'error', message: micErrorMessage(err) });
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

      {modelState.status !== 'ready' ? (
        <ModelGate
          modelState={modelState}
          selectedModelId={selectedModelId}
          onLoadModel={onLoadModel}
          reason="발음을 분석하려면 음성 인식 모델이 필요해요."
        />
      ) : (
        <RecordControls
          recording={recorder.recording}
          busy={phase.kind === 'analyzing'}
          elapsed={recorder.elapsed}
          meterRef={recorder.meterRef}
          onStart={() => void start()}
          onStop={() => void finish()}
          idleLabel={phase.kind === 'done' ? '다시 녹음하기' : '눌러서 녹음 시작'}
          idleHint="위 문구를 또박또박 소리 내어 읽어 주세요"
        />
      )}

      {phase.kind === 'error' && <p className="error">{phase.message}</p>}
      {audioUrl && !recorder.recording && <audio className="playback" controls src={audioUrl} />}
      {phase.kind === 'done' && <ResultView analysis={phase.analysis} elapsedMs={phase.ms} />}

      {history.error && <p className="error">{history.error}</p>}
      <AttemptHistory
        attempts={history.attempts}
        latestId={latestId}
        summary={(a) => pronunciationSummary(a.pronunciation)}
        renderDetail={(a) => a.pronunciation && <ResultView analysis={a.pronunciation} elapsedMs={a.analysisMs} />}
        onDelete={(a) => void history.remove(a)}
      />
    </section>
  );
}
