import { useEffect, useMemo, useRef, useState } from 'react';
import { asrClient } from '../asr/asrClient';
import type { ModelState } from '../asr/asrClient';
import { REFERENCE_GATE_DB, voicedRatio } from '../audio/pitch';
import { SEPARATION_RATE } from '../audio/separation';
import { encodeWav } from '../audio/wav';
import { newSongId, putSong } from '../lib/songStore';
import { LANGUAGES } from '../data/languages';
import { PitchChart } from './PitchChart';
import { SegmentPicker } from './SegmentPicker';

// Leaves headroom inside Whisper's 30 s window for a slower user take.
const MAX_SEGMENT = 25;

interface Props {
  modelState: ModelState;
  saveModels: boolean;
}

interface Draft {
  // Bounds the analysis actually ran on; saved instead of the live selection.
  start: number;
  end: number;
  original: Blob;
  vocals: Blob;
  vocals16k: Float32Array;
  refMidi: Float32Array;
  frameSeconds: number;
}

type Step = { kind: 'pick' } | { kind: 'working'; label: string; percent: number | null } | { kind: 'review' };

function peakNormalize(x: Float32Array): Float32Array {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  return peak > 0 ? x.map((v) => (v / peak) * 0.9) : x;
}

export function SongEditor({ modelState, saveModels }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(10);
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState('ko');
  const [lyrics, setLyrics] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef<{ ctx: AudioContext; src: AudioBufferSourceNode } | null>(null);
  const mountedRef = useRef(true);

  const whisperReady = modelState.status === 'ready';

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      playerRef.current?.src.stop();
      void playerRef.current?.ctx.close();
    };
  }, []);

  const urls = useMemo(
    () => (draft ? { original: URL.createObjectURL(draft.original), vocals: URL.createObjectURL(draft.vocals) } : null),
    [draft],
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

  const onFile = async (f: File) => {
    setError(null);
    setDraft(null);
    setStep({ kind: 'pick' });
    setFile(f);
    setTitle(f.name.replace(/\.[^.]+$/, ''));
    try {
      const ctx = new AudioContext({ sampleRate: SEPARATION_RATE });
      try {
        const decoded = await ctx.decodeAudioData(await f.arrayBuffer());
        if (!mountedRef.current) return;
        setBuffer(decoded);
        setStart(0);
        setEnd(Math.min(decoded.duration, 15));
      } finally {
        void ctx.close();
      }
    } catch {
      setError('이 파일은 재생할 수 없는 형식이에요. mp3, wav, m4a, ogg 파일을 사용해 주세요.');
      setBuffer(null);
    }
  };

  const stopPreview = () => {
    playerRef.current?.src.stop();
    void playerRef.current?.ctx.close();
    playerRef.current = null;
    setPlaying(false);
  };

  const preview = () => {
    if (!buffer) return;
    if (playing) return stopPreview();
    const ctx = new AudioContext();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.onended = () => {
      if (playerRef.current?.src === src) stopPreview();
    };
    src.start(0, start, end - start);
    playerRef.current = { ctx, src };
    setPlaying(true);
  };

  const run = async () => {
    if (!buffer) return;
    stopPreview();
    setError(null);
    const progress = (label: string, loaded: number, total: number) => {
      if (mountedRef.current) setStep({ kind: 'working', label, percent: total > 1 ? (loaded / total) * 100 : null });
    };
    const segStart = start;
    const segEnd = end;
    try {
      const s0 = Math.floor(segStart * SEPARATION_RATE);
      const s1 = Math.floor(segEnd * SEPARATION_RATE);
      const left = buffer.getChannelData(0).slice(s0, s1);
      const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice(s0, s1) : left.slice();
      // Encode before the channel buffers are transferred to the worker.
      const original = encodeWav(
        left.map((v, i) => (v + right[i]) / 2),
        SEPARATION_RATE,
      );

      progress('보컬 분리 준비 중', 0, 1);
      const { vocals44k, vocals16k } = await asrClient.separate(left, right, saveModels, progress);
      progress('음정 추출 중', 0, 1);
      const pitch = await asrClient.pitch(vocals16k.slice(), REFERENCE_GATE_DB, saveModels, progress);
      let text = '';
      if (whisperReady) {
        progress('가사 인식 중', 0, 1);
        text = await asrClient.transcribe(vocals16k.slice(), language);
      }
      if (!mountedRef.current) return;
      setDraft({
        start: segStart,
        end: segEnd,
        original,
        vocals: encodeWav(peakNormalize(vocals44k), SEPARATION_RATE),
        vocals16k,
        refMidi: pitch.midi,
        frameSeconds: pitch.frameSeconds,
      });
      setLyrics(text);
      setStep({ kind: 'review' });
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setStep({ kind: 'pick' });
    }
  };

  const retranscribe = async () => {
    if (!draft) return;
    setStep({ kind: 'working', label: '가사 인식 중', percent: null });
    try {
      const text = await asrClient.transcribe(draft.vocals16k.slice(), language);
      if (mountedRef.current) setLyrics(text);
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setStep({ kind: 'review' });
    }
  };

  const save = async () => {
    if (!draft || !file) return;
    const id = newSongId();
    try {
      await putSong({
        id,
        title: title.trim() || file.name,
        sourceName: file.name,
        language,
        lyrics: lyrics.trim(),
        start: draft.start,
        end: draft.end,
        createdAt: Date.now(),
        refMidi: draft.refMidi.slice().buffer,
        frameSeconds: draft.frameSeconds,
        original: draft.original,
        vocals: draft.vocals,
      });
      window.location.hash = `#/s/${id}`;
    } catch (err) {
      setError(`저장하지 못했어요: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const working = step.kind === 'working';
  const voiced = draft ? voicedRatio({ midi: draft.refMidi, frameSeconds: draft.frameSeconds }) : 0;

  return (
    <section className="song-editor">
      <a className="back" href="#/songs">
        ← 노래 목록
      </a>
      <h1>노래 추가</h1>
      <p className="muted">
        노래 파일을 올리고 연습할 구간을 고르면, 브라우저 안에서 보컬을 분리해 음정과 가사를 분석해요. 파일은 이 기기
        밖으로 나가지 않아요.
      </p>

      <label className="file-drop">
        <input
          type="file"
          accept="audio/*"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
          }}
          disabled={working}
        />
        <span>{file ? file.name : '노래 파일 선택 (mp3, wav, m4a…)'}</span>
      </label>

      {buffer && (
        <div className="editor-box">
          <h2>1. 구간 선택</h2>
          <SegmentPicker
            buffer={buffer}
            start={start}
            end={end}
            maxLength={MAX_SEGMENT}
            disabled={working}
            onChange={(s, e) => {
              setStart(s);
              setEnd(e);
              setDraft(null);
              if (step.kind === 'review') setStep({ kind: 'pick' });
            }}
          />
          <div className="row">
            <button className="button" onClick={preview} disabled={working}>
              {playing ? '■ 정지' : '▶ 구간 듣기'}
            </button>
            <label className="inline-field">
              가사 언어
              <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={working}>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="button button-primary" onClick={() => void run()} disabled={working || end - start < 1}>
              구간 분석하기
            </button>
          </div>
          {!whisperReady && (
            <p className="muted small">
              음성 인식 모델이 준비되지 않아 가사는 자동으로 인식하지 않아요. 직접 입력하거나{' '}
              <a href="#/models">모델을 먼저 불러와</a> 주세요.
            </p>
          )}
          <p className="muted small">처음 분석할 때 보컬 분리·음정 모델(약 53MB)을 내려받아요.</p>
        </div>
      )}

      {working && (
        <div className="editor-box">
          <p>{step.label}…</p>
          <div className="progress">
            <div
              className={`progress-bar ${step.percent === null ? 'indeterminate' : ''}`}
              style={{ width: step.percent === null ? '35%' : `${step.percent}%` }}
            />
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {draft && urls && step.kind === 'review' && (
        <div className="editor-box">
          <h2>2. 분석 결과 확인</h2>
          {voiced < 0.05 && (
            <p className="error small">이 구간에서 노랫소리를 거의 찾지 못했어요. 보컬이 있는 구간인지 확인해 주세요.</p>
          )}
          <div className="players">
            <label>
              원곡 구간
              <audio controls src={urls.original} />
            </label>
            <label>
              분리된 보컬
              <audio controls src={urls.vocals} />
            </label>
          </div>
          <h3>기준 음정</h3>
          <PitchChart reference={draft.refMidi} frameSeconds={draft.frameSeconds} />
          <h3>가사</h3>
          <textarea
            className="lyrics-input"
            value={lyrics}
            onChange={(e) => setLyrics(e.target.value)}
            rows={3}
            placeholder="이 구간의 가사를 입력하세요. 비워두면 음정만 평가해요."
          />
          <div className="row">
            {whisperReady && (
              <button className="button" onClick={() => void retranscribe()}>
                가사 다시 인식
              </button>
            )}
            <span className="muted small">자동 인식된 가사가 틀렸다면 직접 고쳐 주세요. 발음 채점의 정답이 돼요.</span>
          </div>
          <label className="inline-field title-field">
            제목
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <button className="button button-primary" onClick={() => void save()}>
            저장하고 연습하기
          </button>
        </div>
      )}
    </section>
  );
}
