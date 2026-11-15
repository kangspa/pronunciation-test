import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { getAttempt } from '../lib/attemptStore';
import type { Attempt } from '../lib/attemptStore';
import { charTimingClass, charTimingText } from '../lib/charTiming';
import { lyricsLines } from '../lib/fullSong';
import type { FullSongInfo } from '../lib/fullSong';
import { isContentChar } from '../lib/hangul';
import { isMismatch } from '../lib/scoring';
import type { Analysis } from '../lib/scoring';
import { keyLabel, timingDetail } from '../lib/songScores';
import { PitchChart, TimingLegend } from './PitchChart';
import { ScoreHeader } from './ScoreHeader';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function tone(score: number) {
  if (score >= 0.9) return 'great';
  if (score >= 0.7) return 'good';
  if (score >= 0.4) return 'ok';
  return 'low';
}

// Lyrics line by line. Each character is coloured by how well it was heard
// relative to the original; characters heard as something else show what
// was heard above them, and with a word-timing model a red/blue underline
// marks early/late characters.
function LyricsReport({ lyrics, take, full, charTiming }: { lyrics: string; take: Analysis; full: FullSongInfo; charTiming?: number[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const rel = full.relativeChars ?? take.chars.map((c) => c.score);
  const ref = full.refPronunciation;
  const lines = lyricsLines(lyrics);
  const misses = take.chars.filter(isMismatch).length;
  const late = charTiming?.filter((d) => charTimingClass(d) !== null).length ?? 0;

  const lineHasIssue = (idx: number[]) => idx.some((i) => isMismatch(take.chars[i]) || charTimingClass(charTiming?.[i]) !== null);

  const renderLine = (text: string, idx: number[]): ReactNode[] => {
    let k = 0;
    return Array.from(text).map((ch, p) => {
      if (!isContentChar(ch)) return <span key={p}>{ch}</span>;
      const i = idx[k++];
      const c = take.chars[i];
      if (!c) return <span key={p}>{ch}</span>;
      const timing = charTimingClass(charTiming?.[i]);
      const cls = `lc tone-${tone(rel[i])} ${timing ? `timing-${timing}` : ''} ${selected === i ? 'selected' : ''}`;
      const onClick = () => setSelected(selected === i ? null : i);
      return isMismatch(c) ? (
        <button key={p} className={`${cls} miss`} onClick={onClick}>
          <ruby>
            {ch}
            <rt>{c.heard ?? '·'}</rt>
          </ruby>
        </button>
      ) : (
        <button key={p} className={cls} onClick={onClick}>
          {ch}
        </button>
      );
    });
  };

  const d = selected !== null ? take.chars[selected] : null;
  const timingText = selected !== null ? charTimingText(charTiming?.[selected]) : null;

  return (
    <div className="result">
      <h3>가사별 발음{charTiming ? ' · 타이밍' : ''}</h3>
      <p className="muted small">
        다르게 들린 글자 {misses}개{take.insertions.length > 0 && ` · 가사에 없는 소리 ${take.insertions.length}개`}
        {charTiming && ` · 0.25초 넘게 어긋난 글자 ${late}개`} · 글자를 누르면 자세히 볼 수 있어요
      </p>
      <label className="inline-check small">
        <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> 틀리거나 어긋난 줄만
        보기
      </label>
      <ol className="lyric-lines">
        {lines.map((line, li) => {
          if (onlyIssues && !lineHasIssue(line.chars)) return null;
          const scores = line.chars.map((i) => rel[i]).filter((v) => v !== undefined);
          const lineScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
          const start = line.chars.map((i) => take.chars[i]?.heardTime).find((t) => t != null);
          return (
            <li key={li} className="lyric-line">
              <span className={`line-score tone-text-${tone(lineScore)}`}>{Math.round(lineScore * 100)}</span>
              <p className="line-text">{renderLine(line.text, line.chars)}</p>
              {start != null && <span className="line-time muted small">{clock(start)}</span>}
            </li>
          );
        })}
      </ol>
      {d && selected !== null && (
        <div className="detail">
          <strong className="detail-char">{d.target}</strong>
          <div>
            <p>{d.heard === null ? '이 글자는 들리지 않았어요.' : isMismatch(d) ? `「${d.heard}」처럼 들렸어요.` : '가사대로 들렸어요.'}</p>
            <p className="muted small">
              원곡 대비 {pct(rel[selected])} · 내 점수 {pct(d.score)}
              {ref?.chars[selected] && ` · 원곡 가수 점수 ${pct(ref.chars[selected].score)}`}
            </p>
            {timingText && <p className="small">{timingText}</p>}
          </div>
        </div>
      )}
      <p className="legend small">
        글자 색: 원곡 가수만큼 또렷하면 초록, 덜할수록 주황·빨강 · 위 작은 글자는 대신 들린 소리
        {charTiming && (
          <>
            {' '}
            · 밑줄: <span className="swatch early" /> 원곡보다 빨리 <span className="swatch late" /> 원곡보다 늦게
          </>
        )}
      </p>
    </div>
  );
}

export function FullSongResult({ attempt }: { attempt: Attempt }) {
  const full = attempt.full!;
  const { pitch, pronunciation } = attempt;
  const timing = pitch?.timingScore;
  const pron = full.relativePronunciation;
  const detail = pitch ? timingDetail(pitch) : '';
  return (
    <>
      <div className="result">
        <div className="phrase-meta">
          <span className="tag">전곡 채점</span>
          <span className="phrase-title">{full.title}</span>
          <span className="muted small">{clock(full.durationSeconds)}</span>
        </div>
        <ScoreHeader score={attempt.score} caption="타이밍 제외">
          {attempt.scoreWithTiming !== undefined && (
            <div>
              <dt>타이밍 포함</dt>
              <dd>{attempt.scoreWithTiming.toFixed(1)}</dd>
            </div>
          )}
          {pron !== undefined && (
            <div>
              <dt>발음 (원곡 대비)</dt>
              <dd>{pron.toFixed(1)}</dd>
            </div>
          )}
          {pitch && (
            <div>
              <dt>음정</dt>
              <dd>{pitch.score.toFixed(1)}</dd>
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
          타이밍 제외 = {pron !== undefined ? '(발음 + 음정) ÷ 2' : '음정 점수'}
          {attempt.scoreWithTiming !== undefined && ` · 타이밍 포함 = ${pron !== undefined ? '(발음 + 음정 + 타이밍) ÷ 3' : '(음정 + 타이밍) ÷ 2'}`}
          {detail && ` · 타이밍: ${detail}`}
        </p>
        <p className="muted small">
          원곡 {full.originalName} · 채점용 {full.takeName}
          {full.takeHasAccompaniment ? ' (반주 분리)' : ' (무반주)'} · 분석 {(attempt.analysisMs / 60000).toFixed(1)}분 ·{' '}
          {new Date(attempt.createdAt).toLocaleString('ko-KR')}
        </p>
        {pron === undefined && (
          <p className="gate small">가사나 음성 인식 모델이 없어서 발음은 채점하지 않았어요. 음정과 타이밍만 채점했어요.</p>
        )}
      </div>

      {pronunciation && <LyricsReport lyrics={attempt.target} take={pronunciation} full={full} charTiming={attempt.charTiming} />}

      {pitch && (
        <div className="result">
          <h3>음정 · 박자</h3>
          <p className="muted small">
            음정 {pitch.score.toFixed(1)}점 · 50센트 이내 {pitch.hitRate.toFixed(0)}% · 평균 음정 오차 {pitch.meanCents > 0 ? '+' : ''}
            {pitch.meanCents.toFixed(0)}센트 · {keyLabel(pitch)}
            {pitch.octaveShift !== 0 && ` · ${Math.abs(pitch.octaveShift)}옥타브 차이는 맞춰서 비교`}
          </p>
          <PitchChart
            reference={full.refMidi}
            frameSeconds={full.frameSeconds}
            user={pitch.alignedUser}
            frameScores={pitch.frameScores}
            timingErrors={pitch.timingErrors}
            pxPerSecond={16}
          />
          <p className="legend small">
            <span className="swatch ref" /> 원곡 보컬 <span className="swatch great" /> 정확 <span className="swatch ok" /> 조금 벗어남{' '}
            <span className="swatch low" /> 많이 벗어남 · 옆으로 밀어서 곡 전체를 볼 수 있어요
          </p>
          {pitch.timingErrors && <TimingLegend />}
        </div>
      )}

      {(full.recognizedLyrics || full.lyricsSource !== 'none') && (
        <details className="explain">
          <summary>채점에 쓴 가사</summary>
          <p className="small">
            {full.lyricsSource === 'uploaded'
              ? '올린 가사로 채점했어요.'
              : full.lyricsSource === 'edited'
                ? '원곡 인식 결과를 고친 가사로 채점했어요.'
                : full.lyricsSource === 'recognized'
                  ? '원곡에서 인식한 가사를 그대로 썼어요.'
                  : ''}
          </p>
          {full.recognizedLyrics && (
            <>
              <p className="small">
                <b>원곡에서 인식한 가사</b>
              </p>
              <p className="small pre">{full.recognizedLyrics}</p>
            </>
          )}
        </details>
      )}
    </>
  );
}

// '#/full/<attempt id>': a saved full-song result, opened from 기록.
export function FullSongResultPage({ id }: { id: string }) {
  const [attempt, setAttempt] = useState<Attempt | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    getAttempt(id)
      .then((a) => {
        if (!cancelled) setAttempt(a?.full ? a : null);
      })
      .catch(() => {
        if (!cancelled) setAttempt(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (attempt === undefined) return <p className="muted">불러오는 중…</p>;
  if (attempt === null) {
    return (
      <p className="empty">
        결과를 찾을 수 없어요. <a href="#/records">기록으로</a>
      </p>
    );
  }
  return (
    <section className="panel">
      <a className="back" href="#/records">
        ← 기록
      </a>
      <FullSongResult attempt={attempt} />
    </section>
  );
}
