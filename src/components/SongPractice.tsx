import { useEffect, useMemo, useRef, useState } from 'react';
import { asrClient } from '../asr/asrClient';
import { findPreset } from '../asr/models';
import type { ModelState } from '../asr/asrClient';
import { comparePitch } from '../audio/pitchCompare';
import type { PitchComparison } from '../audio/pitchCompare';
import { useAttempts } from '../hooks/useAttempts';
import { micErrorMessage, useRecorder } from '../hooks/useRecorder';
import { newAttemptId, pronunciationSummary, songKey } from '../lib/attemptStore';
import type { Attempt } from '../lib/attemptStore';
import { compareCharTimes } from '../lib/charTiming';
import { decodeTo16k, prepareSpeech } from '../lib/recorder';
import { KEY_OPTIONS, keyToValue, songScores, timingDetail, timingFormula, valueToKey } from '../lib/songScores';
import { analyze } from '../lib/scoring';
import type { Analysis } from '../lib/scoring';
import { bestOf, getSong, putSong, withBest } from '../lib/songStore';
import type { PracticeMode, Song } from '../lib/songStore';
import { AttemptHistory } from './AttemptHistory';
import { ScoreHeader } from './ScoreHeader';
import { ModelGate } from './ModelGate';
import { PitchChart } from './PitchChart';
import { PitchResult } from './PitchResult';
import { RecordControls } from './RecordControls';
import { ResultView } from './ResultView';

interface Props {
  songId: string;
  modelState: ModelState;
  selectedModelId: string;
  saveModels: boolean;
  onLoadModel: (id: string) => void;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'analyzing'; label: string }
  | { kind: 'done'; outcome: Attempt }
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
  const history = useAttempts(songKey(songId));
  const [latestId, setLatestId] = useState<string | null>(null);

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
    () =>
      song
        ? {
            original: song.original ? URL.createObjectURL(song.original) : null,
            vocals: song.vocals ? URL.createObjectURL(song.vocals) : null,
          }
        : null,
    [song],
  );
  useEffect(
    () => () => {
      if (urls) {
        if (urls.original) URL.revokeObjectURL(urls.original);
        if (urls.vocals) URL.revokeObjectURL(urls.vocals);
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
      let pitch: PitchComparison | undefined;
      let pronunciation: Analysis | undefined;
      // Each call transfers its buffer to the worker, so each gets its own copy.
      // The pronunciation test also tracks pitch, for the chart only: it is
      // cheap, and a failure there must not lose the pronunciation result.
      setLabel('음정 분석 중');
      try {
        const userPitch = await asrClient.pitch(speech.slice(), PITCH_GATE_DB, saveModels);
        pitch = comparePitch({ midi: ref, frameSeconds: song.frameSeconds }, userPitch, song.key);
      } catch (err) {
        if (runMode !== 'pronunciation') throw err;
      }
      let charTiming: number[] | undefined;
      let songNow = song;
      if (runMode !== 'pitch') {
        setLabel('발음 분석 중');
        const output = await asrClient.score(speech.slice(), song.lyrics, song.language, (label) => setLabel(label));
        pronunciation = analyze(song.lyrics, output);

        // A word-timing model also says when each lyric character was sung;
        // the original's times come from its vocals, once per lyrics + model.
        const modelId = modelState.status === 'ready' ? modelState.modelId : '';
        if (findPreset(modelId)?.timestamps) {
          let ref = song.refCharTimes?.lyrics === song.lyrics && song.refCharTimes.modelId === modelId ? song.refCharTimes.times : null;
          if (!ref && song.vocals) {
            setLabel('원곡 가사 타이밍 분석 중');
            const vocals16k = await decodeTo16k(song.vocals);
            const refOut = await asrClient.score(vocals16k, song.lyrics, song.language);
            ref = analyze(song.lyrics, refOut).chars.map((c) => c.heardTime ?? null);
            songNow = { ...songNow, refCharTimes: { lyrics: song.lyrics, modelId, times: ref } };
          }
          if (ref) charTiming = compareCharTimes(ref, pronunciation.chars.map((c) => c.heardTime ?? null));
        }
      }
      const { score, scoreWithTiming } = songScores(runMode, pronunciation, pitch);
      const attempt: Attempt = {
        id: newAttemptId(),
        item: songKey(song.id),
        createdAt: Date.now(),
        mode: runMode,
        score,
        scoreWithTiming,
        target: song.lyrics,
        modelId: runMode !== 'pitch' && modelState.status === 'ready' ? modelState.modelId : undefined,
        analysisMs: performance.now() - t0,
        pronunciation,
        pitch,
        pitchForReference: runMode === 'pronunciation' && pitch ? true : undefined,
        charTiming,
      };
      void history.add(attempt);

      const updated = withBest(songNow, runMode, score, scoreWithTiming);
      if (updated !== song) {
        await putSong(updated).catch(() => {});
        if (recorder.isMounted()) setSong(updated);
      }
      if (recorder.isMounted()) {
        setLatestId(attempt.id);
        setPhase({ kind: 'done', outcome: attempt });
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

  const changeKey = (value: string) => {
    if (!song) return;
    const updated = { ...song, key: valueToKey(value) };
    setSong(updated);
    void putSong(updated).catch(() => {});
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
        {urls.original || urls.vocals ? (
          <div className="players">
            {urls.original && (
              <label>
                원곡 구간
                <audio controls src={urls.original} />
              </label>
            )}
            {urls.vocals && (
              <label>
                보컬만
                <audio controls src={urls.vocals} />
              </label>
            )}
          </div>
        ) : (
          <p className="muted small">음원 파일은 삭제했어요. 가사, 원곡 음정, 기록으로 계속 연습할 수 있어요.</p>
        )}
      </div>

      <div className="mode-tabs" role="tablist" aria-label="평가 종류">
        {MODES.map((m) => {
          const best = bestOf(song, m.id);
          const bestTiming = song.bestWithTiming?.[m.id];
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
              {bestTiming !== undefined && <span className="mode-best">타이밍 포함 {bestTiming.toFixed(0)}점</span>}
            </button>
          );
        })}
      </div>

      <div className="key-control">
        <label>
          <span>채점 키</span>
          <select value={keyToValue(song.key)} onChange={(e) => changeKey(e.target.value)} disabled={busy}>
            {KEY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          노래방처럼 키를 바꿔 부른다면 맞춰 주세요. 소리를 바꾸지는 않고, 절대 음정을 채점할 때만 그만큼 옮겨서
          비교해요. 키와 상관없이 높낮이 변화만 보는 상대 음정도 항상 함께 채점해요. 남녀 차이 같은 한 옥타브
          차이는 자동으로 맞춰요.
        </p>
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

      {outcome && <SongOutcome attempt={outcome} reference={ref} frameSeconds={song.frameSeconds} />}

      {!outcome && (
        <div className="result">
          <h3>원곡 음정</h3>
          <PitchChart reference={ref} frameSeconds={song.frameSeconds} />
        </div>
      )}

      {history.error && <p className="error">{history.error}</p>}
      <AttemptHistory
        attempts={history.attempts}
        latestId={latestId}
        tag={(a) => MODES.find((m) => m.id === a.mode)?.label ?? null}
        summary={songSummary}
        renderDetail={(a) => <SongOutcome attempt={a} reference={ref} frameSeconds={song.frameSeconds} />}
        onDelete={(a) => void history.remove(a)}
      />
    </section>
  );
}

function songSummary(a: Attempt): string {
  const parts: string[] = [];
  if (a.scoreWithTiming !== undefined) parts.push(`타이밍 포함 ${a.scoreWithTiming.toFixed(0)}점`);
  if (a.mode === 'pronunciation') return [...parts, pronunciationSummary(a.pronunciation)].join(' · ');
  if (a.pronunciation) parts.push(`발음 ${a.pronunciation.overall.toFixed(0)}`);
  if (a.pitch) parts.push(`음정 ${a.pitch.score.toFixed(0)}${a.pitch.relative ? `(상대 ${a.pitch.relative.score.toFixed(0)})` : ''}`);
  if (a.pitch?.timingScore !== undefined) parts.push(`타이밍 ${a.pitch.timingScore.toFixed(0)}`);
  return parts.join(' · ');
}

const PLAIN_FORMULA: Record<PracticeMode, string> = {
  pronunciation: '발음 점수',
  pitch: '음정 점수',
  total: '(발음 + 음정) ÷ 2',
};

// Full result of one attempt; used for the attempt just made and for history entries.
function SongOutcome({ attempt, reference, frameSeconds }: { attempt: Attempt; reference: Float32Array; frameSeconds: number }) {
  const { pitch, pronunciation } = attempt;
  const mode = attempt.mode ?? 'total';
  const timing = pitch?.timingScore;
  const detail = pitch ? timingDetail(pitch) : '';
  const pitchView = pitch && (
    <PitchResult pitch={pitch} reference={reference} frameSeconds={frameSeconds} forReference={!!attempt.pitchForReference} />
  );
  return (
    <>
      <div className="result">
        <ScoreHeader score={attempt.score} caption="타이밍 제외">
          {attempt.scoreWithTiming !== undefined && (
            <div>
              <dt>타이밍 포함</dt>
              <dd>{attempt.scoreWithTiming.toFixed(1)}</dd>
            </div>
          )}
          {pronunciation && (
            <div>
              <dt>발음</dt>
              <dd>{pronunciation.overall.toFixed(1)}</dd>
            </div>
          )}
          {pitch && !attempt.pitchForReference && (
            <div>
              <dt>음정 (절대)</dt>
              <dd>{pitch.score.toFixed(1)}</dd>
            </div>
          )}
          {pitch?.relative && !attempt.pitchForReference && (
            <div>
              <dt>음정 (상대)</dt>
              <dd>{pitch.relative.score.toFixed(1)}</dd>
            </div>
          )}
          {timing !== undefined && (
            <div>
              <dt>타이밍</dt>
              <dd>{timing.toFixed(1)}</dd>
            </div>
          )}
        </ScoreHeader>
        <p className="muted small">
          타이밍 제외 = {PLAIN_FORMULA[mode]}
          {attempt.scoreWithTiming !== undefined && ` · 타이밍 포함 = ${timingFormula(mode)}`}
          {detail && ` · 타이밍: ${detail}`} · 분석 {(attempt.analysisMs / 1000).toFixed(1)}초
        </p>
        {timing !== undefined && (
          <details className="explain">
            <summary>타이밍 점수는 어떻게 계산되나요?</summary>
            <ul>
              <li>
                녹음과 원곡 보컬의 음 높이·소리 나는 구간을 시간축으로 맞춰서(DTW), 원곡이 소리 내는 순간마다 내가 몇
                초 늦거나 빨랐는지 재요. 키 설정과 상관없이 가장 잘 맞는 키로 맞춘 뒤 재요.
              </li>
              <li>
                처음 3초 동안 부른 부분을 기준으로 맞추므로 언제 시작했는지는 상관없어요. 0.15초 이내면 만점, 0.6초 이상 어긋나면 0점이고, 원곡이 소리 내는 곳에서
                소리를 내지 않았어도 0점이에요. 전체를 느리거나 빠르게 부르면 뒤로 갈수록 어긋나서 점수가 깎여요.
              </li>
              <li>
                타이밍 점수는 글자 단위가 아니라 소리 나는 구간 단위로 맞춘 근사치예요. 반주 없이 부르면 박자가
                흔들리기 쉬우니, 이어폰으로 원곡을 들으며 불러 보세요.
              </li>
              <li>
                {attempt.charTiming
                  ? '가사 글자 아래 빨강·파랑 줄은 단어 타이밍 모델로 잰 글자별 빠름·늦음이에요.'
                  : '로컬 관리에서 「단어 타이밍」 모델을 쓰면 가사 글자마다 빨랐는지 늦었는지도 표시돼요. (선택, 추가 다운로드)'}
              </li>
            </ul>
          </details>
        )}
      </div>
      {!attempt.pitchForReference && pitchView}
      {pronunciation && (
        <ResultView analysis={pronunciation} elapsedMs={attempt.analysisMs} showScore={false} charTiming={attempt.charTiming} />
      )}
      {attempt.pitchForReference && pitchView}
    </>
  );
}
