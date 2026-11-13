import { useEffect, useMemo, useRef, useState } from 'react';
import { asrClient } from '../asr/asrClient';
import type { ModelState } from '../asr/asrClient';
import { comparePitch } from '../audio/pitchCompare';
import type { PitchComparison } from '../audio/pitchCompare';
import { micErrorMessage, useRecorder } from '../hooks/useRecorder';
import { prepareSpeech } from '../lib/recorder';
import { analyze, grade } from '../lib/scoring';
import type { Analysis } from '../lib/scoring';
import { getSong, putSong } from '../lib/songStore';
import type { Song } from '../lib/songStore';
import { ModelGate } from './ModelGate';
import { PitchChart } from './PitchChart';
import { RecordControls } from './RecordControls';
import { ResultView } from './ResultView';

interface Props {
  songId: string;
  modelState: ModelState;
  selectedModelId: string;
  saveModels: boolean;
  onLoadModel: (id: string) => void;
}

interface Outcome {
  pitch: PitchComparison;
  pronunciation: Analysis | null;
  total: number;
  ms: number;
}

type Phase = { kind: 'idle' } | { kind: 'analyzing' } | { kind: 'done'; outcome: Outcome } | { kind: 'error'; message: string };

export function SongPractice({ songId, modelState, selectedModelId, saveModels, onLoadModel }: Props) {
  const [song, setSong] = useState<Song | null | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const finishRef = useRef<() => void>(() => {});
  const recorder = useRecorder(() => finishRef.current());

  useEffect(() => {
    let cancelled = false;
    getSong(songId)
      .then((s) => {
        if (!cancelled) setSong(s ?? null);
      })
      .catch(() => {
        if (!cancelled) setSong(null);
      });
    return () => {
      cancelled = true;
    };
  }, [songId]);

  const ref = useMemo(() => (song ? new Float32Array(song.refMidi) : null), [song]);
  const urls = useMemo(
    () => (song ? { original: URL.createObjectURL(song.original), vocals: URL.createObjectURL(song.vocals) } : null),
    [song],
  );
  useEffect(
    () => () => {
      if (urls) {
        URL.revokeObjectURL(urls.original);
        URL.revokeObjectURL(urls.vocals);
      }
    },
    [urls],
  );
  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const whisperReady = modelState.status === 'ready';
  const hasLyrics = !!song?.lyrics;

  const finish = async () => {
    if (!song || !ref || !recorder.hasRecording()) return;
    setPhase({ kind: 'analyzing' });
    try {
      const recording = await recorder.stop();
      if (!recording) return;
      setAudioUrl(recording.url);
      const speech = prepareSpeech(recording.samples);
      if (!speech) {
        setPhase({ kind: 'error', message: '노랫소리가 잘 들리지 않았어요. 마이크에 조금 더 가까이 불러 주세요.' });
        return;
      }
      const t0 = performance.now();
      // Each call transfers its buffer to the worker, so each gets its own copy.
      const userPitch = await asrClient.pitch(speech.slice(), 30, saveModels);
      const pitch = comparePitch({ midi: ref, frameSeconds: song.frameSeconds }, userPitch);
      let pronunciation: Analysis | null = null;
      if (hasLyrics && whisperReady) {
        const output = await asrClient.score(speech.slice(), song.lyrics, song.language);
        pronunciation = analyze(song.lyrics, output);
      }
      const total = pronunciation ? (pronunciation.overall + pitch.score) / 2 : pitch.score;
      if (song.bestScore === undefined || total > song.bestScore) {
        const updated = { ...song, bestScore: total };
        await putSong(updated).catch(() => {});
        if (recorder.isMounted()) setSong(updated);
      }
      if (recorder.isMounted()) setPhase({ kind: 'done', outcome: { pitch, pronunciation, total, ms: performance.now() - t0 } });
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

  if (song === undefined) return <p className="muted">불러오는 중…</p>;
  if (song === null || !ref || !urls) {
    return (
      <p className="empty">
        노래를 찾을 수 없어요. <a href="#/songs">노래 목록으로</a>
      </p>
    );
  }

  const outcome = phase.kind === 'done' ? phase.outcome : null;

  return (
    <section className="panel">
      <a className="back" href="#/songs">
        ← 노래 목록
      </a>
      <div className="phrase-card">
        <div className="phrase-meta">
          <span className="tag">노래</span>
          <span className="phrase-title">{song.title}</span>
        </div>
        <p className="phrase">{song.lyrics || '(가사 없음 · 음정만 평가해요)'}</p>
        <div className="players">
          <label>
            원곡 구간
            <audio controls src={urls.original} />
          </label>
          <label>
            보컬만
            <audio controls src={urls.vocals} />
          </label>
        </div>
      </div>

      {hasLyrics && !whisperReady && (
        <ModelGate
          modelState={modelState}
          selectedModelId={selectedModelId}
          onLoadModel={onLoadModel}
          reason="가사 발음까지 채점하려면 음성 인식 모델이 필요해요. 지금 녹음하면 음정만 평가해요."
        />
      )}

      <RecordControls
        recording={recorder.recording}
        busy={phase.kind === 'analyzing'}
        elapsed={recorder.elapsed}
        meterRef={recorder.meterRef}
        onStart={() => void start()}
        onStop={() => void finish()}
        idleLabel={phase.kind === 'done' ? '다시 부르기' : '눌러서 녹음 시작'}
        idleHint="원곡을 들어본 뒤, 반주 없이 이 구간을 따라 불러 주세요"
      />

      {phase.kind === 'error' && <p className="error">{phase.message}</p>}
      {audioUrl && !recorder.recording && <audio className="playback" controls src={audioUrl} />}

      {outcome ? (
        <>
          <div className="result">
            <div className="score-row">
              <div className={`score-ring tone-${grade(outcome.total).tone}`} style={{ '--p': outcome.total } as React.CSSProperties}>
                <div className="score-ring-inner">
                  <strong>{outcome.total.toFixed(1)}</strong>
                  <span>종합</span>
                </div>
              </div>
              <div className="score-summary">
                <p className={`grade tone-${grade(outcome.total).tone}`}>{grade(outcome.total).label}</p>
                <dl>
                  <div>
                    <dt>음정</dt>
                    <dd>{outcome.pitch.score.toFixed(1)}</dd>
                  </div>
                  <div>
                    <dt>발음</dt>
                    <dd>{outcome.pronunciation ? outcome.pronunciation.overall.toFixed(1) : '–'}</dd>
                  </div>
                  <div>
                    <dt>50센트 이내</dt>
                    <dd>{outcome.pitch.hitRate.toFixed(0)}%</dd>
                  </div>
                  <div>
                    <dt>평균 음정 오차</dt>
                    <dd>
                      {outcome.pitch.meanCents > 0 ? '+' : ''}
                      {outcome.pitch.meanCents.toFixed(0)}센트
                    </dd>
                  </div>
                </dl>
                <p className="muted small">
                  {Math.abs(outcome.pitch.meanCents) >= 30 &&
                    (outcome.pitch.meanCents > 0 ? '전체적으로 조금 높게 불렀어요. ' : '전체적으로 조금 낮게 불렀어요. ')}
                  {outcome.pitch.octaveShift !== 0 &&
                    `원곡보다 ${Math.abs(outcome.pitch.octaveShift)}옥타브 ${outcome.pitch.octaveShift > 0 ? '낮게' : '높게'} 불러서 옥타브를 맞춰 비교했어요. `}
                  분석 {(outcome.ms / 1000).toFixed(1)}초
                </p>
              </div>
            </div>
            <h3>음정 비교</h3>
            <PitchChart
              reference={ref}
              frameSeconds={song.frameSeconds}
              user={outcome.pitch.alignedUser}
              frameScores={outcome.pitch.frameScores}
            />
            <p className="legend small">
              <span className="swatch ref" /> 원곡 보컬 <span className="swatch great" /> 정확 <span className="swatch ok" />{' '}
              조금 벗어남 <span className="swatch low" /> 많이 벗어남
            </p>
            {!outcome.pronunciation && hasLyrics && (
              <p className="muted small">음성 인식 모델이 준비되지 않아 발음은 채점하지 않았어요.</p>
            )}
            <details className="explain">
              <summary>음정 점수는 어떻게 계산되나요?</summary>
              <ul>
                <li>원곡 보컬과 녹음에서 16ms마다 음 높이를 추출해 반음 단위로 비교해요.</li>
                <li>박자가 조금 빠르거나 느려도 따라가도록 시간축을 맞춘 뒤(DTW) 비교하고, 옥타브 차이는 자동으로 맞춰요.</li>
                <li>
                  원곡이 소리 내는 구간마다 반음의 절반(50센트) 이내면 만점, 2반음 이상 벗어나면 0점이에요. 그 구간에 소리를
                  내지 않았어도 0점이에요.
                </li>
                <li>종합 점수는 발음 점수와 음정 점수의 평균이에요. 가사가 없으면 음정 점수만 사용해요.</li>
              </ul>
            </details>
          </div>
          {outcome.pronunciation && <ResultView analysis={outcome.pronunciation} elapsedMs={outcome.ms} />}
        </>
      ) : (
        <div className="result">
          <h3>원곡 음정</h3>
          <PitchChart reference={ref} frameSeconds={song.frameSeconds} />
        </div>
      )}
    </section>
  );
}
