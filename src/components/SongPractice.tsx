import { useEffect, useMemo, useRef, useState } from 'react';
import { asrClient } from '../asr/asrClient';
import type { ModelState } from '../asr/asrClient';
import { comparePitch } from '../audio/pitchCompare';
import type { PitchComparison } from '../audio/pitchCompare';
import { micErrorMessage, useRecorder } from '../hooks/useRecorder';
import { prepareSpeech } from '../lib/recorder';
import { analyze, grade } from '../lib/scoring';
import type { Analysis } from '../lib/scoring';
import { bestOf, getSong, putSong, withBest } from '../lib/songStore';
import type { PracticeMode, Song } from '../lib/songStore';
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
  mode: PracticeMode;
  pitch: PitchComparison | null;
  pronunciation: Analysis | null;
  score: number;
  ms: number;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'analyzing'; label: string }
  | { kind: 'done'; outcome: Outcome }
  | { kind: 'error'; message: string };

const MODES: { id: PracticeMode; label: string; hint: string }[] = [
  { id: 'pronunciation', label: '발음 평가', hint: '가사를 또박또박 불러 주세요. 음정은 채점하지 않아요.' },
  { id: 'pitch', label: '음정 평가', hint: '원곡 음정에 맞춰 불러 주세요. 가사는 채점하지 않아서 "라라라"로 불러도 돼요.' },
  { id: 'total', label: '종합 평가', hint: '가사와 음정을 모두 원곡처럼 불러 주세요.' },
];

const MODE_KEY = 'pronunciation-test:song-mode';
const PITCH_GATE_DB = 30;

function loadMode(): PracticeMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === 'pronunciation' || m === 'pitch' || m === 'total' ? m : 'total';
  } catch {
    return 'total';
  }
}

// Room for a slower take than the original, at least one Whisper window.
function recordLimit(song: Song): number {
  return Math.min(90, Math.max(30, Math.ceil((song.end - song.start) * 1.3 + 5)));
}

export function SongPractice({ songId, modelState, selectedModelId, saveModels, onLoadModel }: Props) {
  const [song, setSong] = useState<Song | null | undefined>(undefined);
  const [mode, setMode] = useState<PracticeMode>(loadMode);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const finishRef = useRef<() => void>(() => {});
  const recorder = useRecorder(() => finishRef.current(), song ? recordLimit(song) : 30);

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
  const needsWhisper = mode !== 'pitch';
  const blockedReason = needsWhisper && !hasLyrics ? '이 노래에는 가사가 없어서 발음 평가를 할 수 없어요. 음정 평가를 이용해 주세요.' : null;
  const canRecord = !blockedReason && (!needsWhisper || whisperReady);

  const finish = async () => {
    if (!song || !ref || !recorder.hasRecording()) return;
    const runMode = mode;
    const setLabel = (label: string) => {
      if (recorder.isMounted()) setPhase({ kind: 'analyzing', label });
    };
    setLabel('녹음 정리 중');
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
      let pitch: PitchComparison | null = null;
      let pronunciation: Analysis | null = null;
      // Each call transfers its buffer to the worker, so each gets its own copy.
      if (runMode !== 'pronunciation') {
        setLabel('음정 분석 중');
        const userPitch = await asrClient.pitch(speech.slice(), PITCH_GATE_DB, saveModels);
        pitch = comparePitch({ midi: ref, frameSeconds: song.frameSeconds }, userPitch);
      }
      if (runMode !== 'pitch') {
        setLabel('발음 분석 중');
        const output = await asrClient.score(speech.slice(), song.lyrics, song.language, (label) => setLabel(label));
        pronunciation = analyze(song.lyrics, output);
      }
      const score =
        runMode === 'pitch' ? pitch!.score : runMode === 'pronunciation' ? pronunciation!.overall : (pitch!.score + pronunciation!.overall) / 2;

      const updated = withBest(song, runMode, score);
      if (updated !== song) {
        await putSong(updated).catch(() => {});
        if (recorder.isMounted()) setSong(updated);
      }
      if (recorder.isMounted()) {
        setPhase({ kind: 'done', outcome: { mode: runMode, pitch, pronunciation, score, ms: performance.now() - t0 } });
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

  const switchMode = (m: PracticeMode) => {
    if (recorder.recording || phase.kind === 'analyzing') return;
    setMode(m);
    setPhase({ kind: 'idle' });
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // Not persisted; the choice still applies for this visit.
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
  const current = MODES.find((m) => m.id === mode)!;
  const busy = recorder.recording || phase.kind === 'analyzing';

  return (
    <section className="panel">
      <a className="back" href="#/songs">
        ← 노래 목록
      </a>
      <div className="phrase-card">
        <div className="phrase-meta">
          <span className="tag">노래</span>
          <span className="phrase-title">{song.title}</span>
          <span className="muted small">{(song.end - song.start).toFixed(0)}초 구간</span>
        </div>
        <p className="phrase lyrics">{song.lyrics || '(가사 없음 · 음정 평가만 할 수 있어요)'}</p>
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

      <div className="mode-tabs" role="tablist" aria-label="평가 종류">
        {MODES.map((m) => {
          const best = bestOf(song, m.id);
          return (
            <button
              key={m.id}
              role="tab"
              aria-selected={mode === m.id}
              className={`mode-tab ${mode === m.id ? 'active' : ''}`}
              onClick={() => switchMode(m.id)}
              disabled={busy && mode !== m.id}
            >
              <span>{m.label}</span>
              <span className="mode-best">{best !== undefined ? `최고 ${best.toFixed(0)}점` : '기록 없음'}</span>
            </button>
          );
        })}
      </div>

      {blockedReason ? (
        <p className="gate">{blockedReason}</p>
      ) : needsWhisper && !whisperReady ? (
        <ModelGate
          modelState={modelState}
          selectedModelId={selectedModelId}
          onLoadModel={onLoadModel}
          reason="발음을 채점하려면 음성 인식 모델이 필요해요."
        />
      ) : null}

      {canRecord && (
        <RecordControls
          recording={recorder.recording}
          busy={phase.kind === 'analyzing'}
          elapsed={recorder.elapsed}
          maxSeconds={recordLimit(song)}
          meterRef={recorder.meterRef}
          onStart={() => void start()}
          onStop={() => void finish()}
          idleLabel={phase.kind === 'done' ? '다시 부르기' : `${current.label} 녹음 시작`}
          idleHint={current.hint}
          busyHint={phase.kind === 'analyzing' ? `${phase.label}… 구간이 길면 수십 초 걸릴 수 있어요` : undefined}
        />
      )}

      {phase.kind === 'error' && <p className="error">{phase.message}</p>}
      {audioUrl && !recorder.recording && <audio className="playback" controls src={audioUrl} />}

      {outcome?.mode === 'total' && outcome.pitch && outcome.pronunciation && (
        <div className="result">
          <ScoreHeader score={outcome.score} caption="종합">
            <div>
              <dt>발음</dt>
              <dd>{outcome.pronunciation.overall.toFixed(1)}</dd>
            </div>
            <div>
              <dt>음정</dt>
              <dd>{outcome.pitch.score.toFixed(1)}</dd>
            </div>
          </ScoreHeader>
          <p className="muted small">종합 점수 = (발음 점수 + 음정 점수) ÷ 2 · 분석 {(outcome.ms / 1000).toFixed(1)}초</p>
        </div>
      )}
      {outcome?.pitch && <PitchResult pitch={outcome.pitch} reference={ref} frameSeconds={song.frameSeconds} />}
      {outcome?.pronunciation && <ResultView analysis={outcome.pronunciation} elapsedMs={outcome.ms} />}

      {!outcome && mode !== 'pronunciation' && (
        <div className="result">
          <h3>원곡 음정</h3>
          <PitchChart reference={ref} frameSeconds={song.frameSeconds} />
        </div>
      )}
    </section>
  );
}

function ScoreHeader({ score, caption, children }: { score: number; caption: string; children: React.ReactNode }) {
  const g = grade(score);
  return (
    <div className="score-row">
      <div className={`score-ring tone-${g.tone}`} style={{ '--p': score } as React.CSSProperties}>
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

function PitchResult({ pitch, reference, frameSeconds }: { pitch: PitchComparison; reference: Float32Array; frameSeconds: number }) {
  return (
    <div className="result">
      <ScoreHeader score={pitch.score} caption="음정">
        <div>
          <dt>50센트 이내</dt>
          <dd>{pitch.hitRate.toFixed(0)}%</dd>
        </div>
        <div>
          <dt>평균 음정 오차</dt>
          <dd>
            {pitch.meanCents > 0 ? '+' : ''}
            {pitch.meanCents.toFixed(0)}센트
          </dd>
        </div>
      </ScoreHeader>
      <p className="muted small">
        {Math.abs(pitch.meanCents) >= 30 && (pitch.meanCents > 0 ? '전체적으로 조금 높게 불렀어요. ' : '전체적으로 조금 낮게 불렀어요. ')}
        {pitch.octaveShift !== 0 &&
          `원곡보다 ${Math.abs(pitch.octaveShift)}옥타브 ${pitch.octaveShift > 0 ? '낮게' : '높게'} 불러서 옥타브를 맞춰 비교했어요.`}
      </p>
      <h3>음정 비교</h3>
      <PitchChart reference={reference} frameSeconds={frameSeconds} user={pitch.alignedUser} frameScores={pitch.frameScores} />
      <p className="legend small">
        <span className="swatch ref" /> 원곡 보컬 <span className="swatch great" /> 정확 <span className="swatch ok" /> 조금 벗어남{' '}
        <span className="swatch low" /> 많이 벗어남
      </p>
      <details className="explain">
        <summary>음정 점수는 어떻게 계산되나요?</summary>
        <ul>
          <li>원곡 보컬과 녹음에서 16ms마다 음 높이를 추출해 반음 단위로 비교해요.</li>
          <li>박자가 조금 빠르거나 느려도 따라가도록 시간축을 맞춘 뒤(DTW) 비교하고, 옥타브 차이는 자동으로 맞춰요.</li>
          <li>
            원곡이 소리 내는 구간마다 반음의 절반(50센트) 이내면 만점, 2반음 이상 벗어나면 0점이에요. 그 구간에 소리를 내지
            않았어도 0점이에요.
          </li>
        </ul>
      </details>
    </div>
  );
}
