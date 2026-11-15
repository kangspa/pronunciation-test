import { lyricsLines } from '../lib/fullSong';
import { isContentChar } from '../lib/hangul';
import { charAt } from '../lib/lyricsTiming';
import { PitchChart } from './PitchChart';

interface Props {
  lyrics: string;
  // Reference time of every lyric content character, seconds from the segment start.
  charTimes: (number | null)[];
  // Whether those times come from a word-timing model (else estimated).
  measured: boolean;
  reference: Float32Array;
  frameSeconds: number;
  // Seconds since recording started, or null when not recording.
  seconds: number | null;
}

// Karaoke-style guide for 30 s practice: the line to sing now with the
// current character highlighted, the next line below, and a playhead on the
// original's pitch. Time 0 is when recording starts, which is also when the
// original starts if "원곡 같이 틀기" is on.
export function LiveGuide({ lyrics, charTimes, measured, reference, frameSeconds, seconds }: Props) {
  const lines = lyricsLines(lyrics);
  const current = seconds === null ? -1 : charAt(charTimes, seconds);
  const lineIdx = Math.max(
    0,
    lines.findIndex((l) => l.chars.length > 0 && l.chars[l.chars.length - 1] >= Math.max(0, current)),
  );
  const line = lines[lineIdx];
  const next = lines[lineIdx + 1];
  const firstNote = reference.findIndex((v) => !Number.isNaN(v));

  const renderLine = () => {
    if (!line) return null;
    let k = 0;
    return Array.from(line.text).map((ch, p) => {
      if (!isContentChar(ch)) return <span key={p}>{ch}</span>;
      const i = line.chars[k++];
      const cls = i < current ? 'sung' : i === current ? 'now' : '';
      return (
        <span key={p} className={cls}>
          {ch}
        </span>
      );
    });
  };

  return (
    <div className="result live-guide">
      <h3>{seconds === null ? '따라 부르기 가이드' : '지금 부를 곳'}</h3>
      {line && (
        <p className="live-lyrics" aria-live="off">
          {renderLine()}
          {next && <span className="next">{next.text}</span>}
        </p>
      )}
      <PitchChart reference={reference} frameSeconds={frameSeconds} playheadSeconds={seconds ?? undefined} />
      <p className="muted small">
        {seconds === null
          ? `녹음을 시작하면 파란 선이 원곡 위치를 따라 움직이고, 지금 불러야 할 가사가 표시돼요.${firstNote > 0 ? ` 원곡 노래는 ${(firstNote * frameSeconds).toFixed(1)}초부터 시작해요.` : ''}`
          : '파란 선이 지금 원곡이 부르는 위치예요.'}{' '}
        {lyrics &&
          (measured
            ? '가사 위치는 단어 타이밍 모델로 잰 원곡 타이밍이에요.'
            : '가사 위치는 원곡 음정에서 어림한 값이라 조금 어긋날 수 있어요. 단어 타이밍 모델로 한 번 채점하면 정확해져요.')}
      </p>
    </div>
  );
}
