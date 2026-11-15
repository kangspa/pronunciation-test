import { useEffect, useRef, useState } from 'react';
import { asrClient } from '../asr/asrClient';
import type { ModelState } from '../asr/asrClient';
import { findPreset } from '../asr/models';
import { REFERENCE_GATE_DB } from '../audio/pitch';
import { comparePitch } from '../audio/pitchCompare';
import type { KeySetting, PitchComparison } from '../audio/pitchCompare';
import { SEPARATION_RATE } from '../audio/separation';
import { LANGUAGES } from '../data/languages';
import { useWakeLock } from '../hooks/useWakeLock';
import { addAttempt, fullKey, newAttemptId } from '../lib/attemptStore';
import type { Attempt } from '../lib/attemptStore';
import { compareCharTimes } from '../lib/charTiming';
import { cleanLyrics, countLyricDifferences, decimateTrack, relativePronunciation } from '../lib/fullSong';
import type { FullSongInfo } from '../lib/fullSong';
import { decodeTo16k } from '../lib/recorder';
import { analyze } from '../lib/scoring';
import type { Analysis } from '../lib/scoring';
import { KEY_OPTIONS, keyToValue, valueToKey } from '../lib/songScores';
import { FullSongResult } from './FullSongResult';
import { ModelGate } from './ModelGate';

interface Props {
  modelState: ModelState;
  selectedModelId: string;
  saveModels: boolean;
  onLoadModel: (id: string) => void;
}

// Longer files take too much memory to decode and separate in a browser tab.
const MAX_SECONDS = 8 * 60;
// Whole-song pitch tracks are compared at 48 ms frames instead of 16 ms.
const DECIMATE = 3;
// Unaccompanied takes: same voicing gate as live recordings.
const TAKE_GATE_DB = 30;

interface Prepared {
  origVocals16k: Float32Array;
  takeVocals16k: Float32Array;
  refMidi: Float32Array;
  takeMidi: Float32Array;
  frameSeconds: number;
  durationSeconds: number;
  startedAt: number;
}

type Step =
  | { kind: 'input' }
  | { kind: 'working'; label: string; percent: number | null }
  | { kind: 'review' }
  | { kind: 'done'; attempt: Attempt; saved: boolean };

async function decodeStereo(file: File): Promise<{ left: Float32Array; right: Float32Array; seconds: number }> {
  const ctx = new AudioContext({ sampleRate: SEPARATION_RATE });
  try {
    const b = await ctx.decodeAudioData(await file.arrayBuffer());
    const left = b.getChannelData(0).slice();
    const right = b.numberOfChannels > 1 ? b.getChannelData(1).slice() : left.slice();
    return { left, right, seconds: b.duration };
  } finally {
    void ctx.close();
  }
}

function FilePick({ label, hint, file, accept, onFile, disabled }: { label: string; hint: string; file: File | null; accept: string; onFile: (f: File) => void; disabled: boolean }) {
  return (
    <label className="file-pick">
      <span className="file-pick-label">{label}</span>
      <span className="muted small">{hint}</span>
      <input
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
      {file && <span className="small">선택됨: {file.name}</span>}
    </label>
  );
}

export function FullSongTest({ modelState, selectedModelId, saveModels, onLoadModel }: Props) {
  const [original, setOriginal] = useState<File | null>(null);
  const [take, setTake] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState('ko');
  const [takeHasAccompaniment, setTakeHasAccompaniment] = useState(true);
  const [uploadedLyrics, setUploadedLyrics] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [recognized, setRecognized] = useState('');
  const [key, setKey] = useState<KeySetting>({ kind: 'original' });
  const [step, setStep] = useState<Step>({ kind: 'input' });
  // Set once both files are analysed; the file form then stays hidden while scoring.
  const [analysed, setAnalysed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prepared = useRef<Prepared | null>(null);
  const mounted = useRef(true);
  // Set on every mount, not only cleared on unmount: StrictMode mounts twice
  // in development, and a flag left false would silently drop every update.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useWakeLock(step.kind === 'working');

  const whisperReady = modelState.status === 'ready';
  const working = step.kind === 'working';
  const progress = (label: string, loaded = 0, total = 1) => {
    if (mounted.current) setStep({ kind: 'working', label, percent: total > 1 ? (loaded / total) * 100 : null });
  };

  const readLyricsFile = async (f: File) => setUploadedLyrics(cleanLyrics(await f.text()));

  const analyse = async () => {
    if (!original || !take) return;
    setError(null);
    const startedAt = performance.now();
    try {
      progress('원곡 불러오는 중');
      const orig = await decodeStereo(original);
      if (orig.seconds > MAX_SECONDS) throw new Error(`원곡이 너무 길어요. ${MAX_SECONDS / 60}분 이하 파일을 사용해 주세요.`);
      const sep = await asrClient.separate(orig.left, orig.right, saveModels, (l, a, b) => progress(`원곡 ${l}`, a, b));
      const origVocals16k = sep.vocals16k;
      const ref = await asrClient.pitch(origVocals16k.slice(), REFERENCE_GATE_DB, saveModels, (l, a, b) => progress(`원곡 ${l}`, a, b));

      progress('채점용 파일 불러오는 중');
      let takeVocals16k: Float32Array;
      if (takeHasAccompaniment) {
        const t = await decodeStereo(take);
        if (t.seconds > MAX_SECONDS) throw new Error(`채점용 파일이 너무 길어요. ${MAX_SECONDS / 60}분 이하 파일을 사용해 주세요.`);
        takeVocals16k = (await asrClient.separate(t.left, t.right, saveModels, (l, a, b) => progress(`채점용 ${l}`, a, b))).vocals16k;
      } else {
        takeVocals16k = await decodeTo16k(take);
        if (takeVocals16k.length / 16000 > MAX_SECONDS) throw new Error(`채점용 파일이 너무 길어요. ${MAX_SECONDS / 60}분 이하 파일을 사용해 주세요.`);
      }
      const userTrack = await asrClient.pitch(
        takeVocals16k.slice(),
        takeHasAccompaniment ? REFERENCE_GATE_DB : TAKE_GATE_DB,
        saveModels,
        (l, a, b) => progress(`채점용 ${l}`, a, b),
      );

      let text = '';
      if (whisperReady) {
        progress('원곡 가사 인식 중');
        text = await asrClient.transcribe(origVocals16k.slice(), language, (l, a, b) => progress(`원곡 ${l}`, a, b));
      }
      if (!mounted.current) return;
      prepared.current = {
        origVocals16k,
        takeVocals16k,
        refMidi: ref.midi,
        takeMidi: userTrack.midi,
        frameSeconds: ref.frameSeconds,
        durationSeconds: orig.seconds,
        startedAt,
      };
      setRecognized(text);
      setLyrics(uploadedLyrics || text);
      setAnalysed(true);
      setStep({ kind: 'review' });
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setStep({ kind: 'input' });
    }
  };

  const score = async () => {
    const p = prepared.current;
    if (!p || !original || !take) return;
    setError(null);
    const finalLyrics = lyrics.trim();
    const modelId = modelState.status === 'ready' ? modelState.modelId : undefined;
    try {
      let pronunciation: Analysis | undefined;
      let refPronunciation: Analysis | undefined;
      let relative: { overall: number; chars: number[] } | undefined;
      let charTiming: number[] | undefined;
      if (finalLyrics && whisperReady) {
        const refOut = await asrClient.score(p.origVocals16k.slice(), finalLyrics, language, (l, a, b) => progress(`원곡 ${l}`, a, b));
        refPronunciation = analyze(finalLyrics, refOut);
        const takeOut = await asrClient.score(p.takeVocals16k.slice(), finalLyrics, language, (l, a, b) => progress(`채점용 ${l}`, a, b));
        pronunciation = analyze(finalLyrics, takeOut);
        relative = relativePronunciation(pronunciation, refPronunciation);
        if (modelId && findPreset(modelId)?.timestamps) {
          charTiming = compareCharTimes(
            refPronunciation.chars.map((c) => c.heardTime ?? null),
            pronunciation.chars.map((c) => c.heardTime ?? null),
          );
        }
      }

      progress('음정·박자 비교 중');
      // Let the label paint before the synchronous comparison.
      await new Promise((r) => setTimeout(r, 30));
      const fs = p.frameSeconds * DECIMATE;
      const refMidi = decimateTrack(p.refMidi, DECIMATE);
      const pitch: PitchComparison = comparePitch({ midi: refMidi, frameSeconds: fs }, { midi: decimateTrack(p.takeMidi, DECIMATE), frameSeconds: fs }, key);

      const parts = relative ? [relative.overall, pitch.score] : [pitch.score];
      const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const id = newAttemptId();
      const full: FullSongInfo = {
        title: title.trim() || original.name.replace(/\.[^.]+$/, ''),
        originalName: original.name,
        takeName: take.name,
        language,
        takeHasAccompaniment,
        durationSeconds: p.durationSeconds,
        refMidi,
        frameSeconds: fs,
        lyricsSource: !finalLyrics ? 'none' : finalLyrics === uploadedLyrics ? 'uploaded' : finalLyrics === recognized ? 'recognized' : 'edited',
        recognizedLyrics: recognized || undefined,
        refPronunciation,
        relativePronunciation: relative?.overall,
        relativeChars: relative?.chars,
      };
      const attempt: Attempt = {
        id,
        item: fullKey(id),
        createdAt: Date.now(),
        mode: relative ? 'total' : 'pitch',
        score: avg(parts),
        scoreWithTiming: pitch.timingScore === undefined ? undefined : avg([...parts, pitch.timingScore]),
        target: finalLyrics,
        modelId: relative ? modelId : undefined,
        analysisMs: performance.now() - p.startedAt,
        pronunciation,
        pitch,
        charTiming,
        full,
      };
      let saved = true;
      await addAttempt(attempt).catch(() => {
        saved = false;
      });
      if (mounted.current) setStep({ kind: 'done', attempt, saved });
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setStep({ kind: 'review' });
    }
  };

  const reset = () => {
    prepared.current = null;
    setAnalysed(false);
    setStep({ kind: 'input' });
  };

  if (step.kind === 'done') {
    return (
      <section className="panel">
        <a className="back" href="#/songs">
          ← 노래 목록
        </a>
        {!step.saved && <p className="error">결과를 이 브라우저에 저장하지 못했어요. 이 화면을 닫으면 사라져요.</p>}
        <FullSongResult attempt={step.attempt} />
        <div className="actions">
          <button className="button" onClick={reset}>
            다른 곡 채점하기
          </button>
          <a className="button" href="#/records">
            기록 보기
          </a>
        </div>
      </section>
    );
  }

  const diff = recognized && lyrics ? countLyricDifferences(recognized, lyrics) : 0;
  const preset = findPreset(selectedModelId);

  return (
    <section className="panel full-song">
      <a className="back" href="#/songs">
        ← 노래 목록
      </a>
      <h1>전곡 채점</h1>
      <p className="muted">
        원곡 파일과 내가 부른 파일을 올리면, 원곡 가수의 발음·음정·박자를 기준으로 내 노래를 처음부터 끝까지 채점해요. 모든 분석은
        이 브라우저 안에서만 실행돼요.
      </p>

      {!analysed && (
        <div className="settings-box form-grid">
          <FilePick
            label="① 원곡 파일"
            hint="가수 음원 그대로 (mp3, m4a, wav 등, 8분 이하)"
            file={original}
            accept="audio/*"
            disabled={working}
            onFile={(f) => {
              setOriginal(f);
              if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
            }}
          />
          <FilePick label="② 채점용 파일" hint="내가 부른 녹음 (MR에 맞춰 부른 것도, 무반주 녹음도 돼요)" file={take} accept="audio/*" disabled={working} onFile={setTake} />
          <label className="inline-check">
            <input type="checkbox" checked={takeHasAccompaniment} disabled={working} onChange={(e) => setTakeHasAccompaniment(e.target.checked)} />
            <span>
              채점용 파일에 반주(MR)가 섞여 있어요 <span className="muted small">켜 두면 반주를 걸러내고 목소리만 채점해요. 무반주 녹음이면 끄세요(더 빨라요).</span>
            </span>
          </label>
          <label className="field">
            <span>제목</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={working} placeholder="원곡 파일 이름" />
          </label>
          <label className="field">
            <span>가사 언어</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={working}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>
              ③ 가사 <span className="muted small">(선택) 붙여 넣거나 .txt · .lrc 파일을 올리세요. 원곡에서 인식한 가사를 이 가사로 보정해요.</span>
            </span>
            <textarea
              className="lyrics-input"
              rows={6}
              value={uploadedLyrics}
              disabled={working}
              onChange={(e) => setUploadedLyrics(e.target.value)}
              placeholder="가사가 없으면 원곡에서 음성 인식으로 뽑아요."
            />
            <input
              type="file"
              accept=".txt,.lrc,text/plain"
              disabled={working}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void readLyricsFile(f);
              }}
            />
          </div>
        </div>
      )}

      {!whisperReady && (
        <ModelGate
          modelState={modelState}
          selectedModelId={selectedModelId}
          onLoadModel={onLoadModel}
          reason="발음 채점과 가사 인식에는 음성 인식 모델이 필요해요. 없으면 음정과 타이밍만 채점해요."
        />
      )}
      {whisperReady && !preset?.timestamps && (
        <p className="muted small">
          글자마다 빨랐는지 늦었는지까지 보려면 <a href="#/local">로컬 관리</a>에서 「단어 타이밍」 모델을 불러오세요. (선택)
        </p>
      )}

      {step.kind === 'input' && (
        <div className="actions">
          <button className="button button-primary" disabled={!original || !take} onClick={() => void analyse()}>
            분석 시작
          </button>
          <span className="muted small">곡 길이와 기기에 따라 몇 분 걸릴 수 있어요. 분석 중에는 화면을 켜 두세요.</span>
        </div>
      )}

      {working && (
        <div className="editor-box" role="status">
          <p>{step.label}…</p>
          <div className="progress">
            <div
              className={`progress-bar ${step.percent === null ? 'indeterminate' : ''}`}
              style={{ width: step.percent === null ? '35%' : `${step.percent}%` }}
            />
          </div>
          <p className="muted small">화면을 끄거나 다른 앱으로 넘어가면 분석이 멈출 수 있어요.</p>
        </div>
      )}

      {step.kind === 'review' && (
        <div className="settings-box form-grid">
          <h2>가사 확인</h2>
          {recognized ? (
            <p className="muted small">
              원곡에서 인식한 가사{uploadedLyrics ? `와 올린 가사가 ${diff}글자 달라요. 올린 가사를 기준으로 채점해요.` : '예요. 틀린 곳을 고쳐 주세요.'}
            </p>
          ) : (
            <p className="muted small">{whisperReady ? '원곡에서 가사를 인식하지 못했어요.' : '음성 인식 모델이 없어서 가사를 인식하지 않았어요.'}</p>
          )}
          {recognized && uploadedLyrics && (
            <details className="explain">
              <summary>원곡에서 인식한 가사 보기</summary>
              <p className="small pre">{recognized}</p>
            </details>
          )}
          <label className="field">
            <span>채점할 가사</span>
            <textarea className="lyrics-input" rows={8} value={lyrics} onChange={(e) => setLyrics(e.target.value)} />
          </label>
          <label className="field">
            <span>채점 키</span>
            <select value={keyToValue(key)} onChange={(e) => setKey(valueToKey(e.target.value))}>
              {KEY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {!whisperReady && lyrics.trim() && <p className="muted small">음성 인식 모델을 불러오면 이 가사로 발음도 채점해요.</p>}
          <div className="actions">
            <button className="button button-primary" onClick={() => void score()}>
              채점하기
            </button>
            <button className="button" onClick={reset}>
              처음으로
            </button>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </section>
  );
}
