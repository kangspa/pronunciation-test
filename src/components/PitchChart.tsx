import { memo } from 'react';
import { midiName } from '../audio/pitch';
import { TIMING_OK_SECONDS } from '../audio/pitchCompare';

interface Props {
  reference: Float32Array;
  frameSeconds: number;
  // User pitch already aligned onto the reference timeline.
  user?: Float32Array;
  frameScores?: Float32Array;
  // Signed seconds per reference frame (+ late, - early); drawn as a strip under the plot.
  timingErrors?: Float32Array;
  // Horizontal scale for long tracks; the chart then scrolls sideways.
  pxPerSecond?: number;
}

type ChartProps = Props & {
  // Live position (seconds on the reference timeline), drawn as a vertical line.
  playheadSeconds?: number;
};

const MIN_W = 800;
const H = 220;
const PAD_L = 36;
const PAD_B = 18;
const STRIP = 12;
// Errors from TIMING_OK_SECONDS up to this are drawn faint, beyond it solid.
const TIMING_STRONG_SECONDS = 0.4;

function toneOf(score: number) {
  if (Number.isNaN(score)) return 'none';
  if (score >= 0.75) return 'great';
  if (score >= 0.35) return 'ok';
  return 'low';
}

type TimingClass = 'early-strong' | 'early' | 'late' | 'late-strong' | null;

function timingClass(err: number): TimingClass {
  if (Number.isNaN(err) || Math.abs(err) <= TIMING_OK_SECONDS) return null;
  const strong = Math.abs(err) >= TIMING_STRONG_SECONDS;
  if (err < 0) return strong ? 'early-strong' : 'early';
  return strong ? 'late-strong' : 'late';
}

const chartWidth = (n: number, frameSeconds: number, pxPerSecond?: number) =>
  pxPerSecond ? Math.max(MIN_W, Math.round(n * frameSeconds * pxPerSecond)) : MIN_W;

// The chart itself is memoised: during recording only the playhead moves, and
// redrawing every path 60 times a second would be wasted work.
export function PitchChart({ playheadSeconds, ...props }: ChartProps) {
  const { reference, frameSeconds, user, timingErrors, pxPerSecond } = props;
  const n = reference.length;
  const hasValues = reference.some((v) => !Number.isNaN(v)) || !!user?.some((v) => !Number.isNaN(v));
  if (n === 0 || !hasValues) return <p className="muted small">표시할 음정이 없어요.</p>;
  const W = chartWidth(n, frameSeconds, pxPerSecond);
  const totalH = H + (timingErrors ? STRIP + 4 : 0);
  const px = playheadSeconds === undefined ? null : PAD_L + Math.min(1, Math.max(0, playheadSeconds / frameSeconds / Math.max(1, n - 1))) * (W - PAD_L - 4);
  return (
    <div className="chart-scroll">
      <div className="chart-stack" style={pxPerSecond ? { width: W } : undefined}>
        <ChartSvg {...props} />
        {px !== null && (
          <svg className="chart-overlay" viewBox={`0 0 ${W} ${totalH}`} aria-hidden>
            <line x1={px} x2={px} y1={2} y2={H - PAD_B} className="playhead" />
          </svg>
        )}
      </div>
    </div>
  );
}

const ChartSvg = memo(function ChartSvg({ reference, frameSeconds, user, frameScores, timingErrors, pxPerSecond }: Props) {
  const n = reference.length;
  const values: number[] = [];
  for (const v of reference) if (!Number.isNaN(v)) values.push(v);
  if (user) for (const v of user) if (!Number.isNaN(v)) values.push(v);

  let lo = values[0];
  let hi = values[0];
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  lo = Math.floor(lo) - 2;
  hi = Math.ceil(hi) + 2;
  if (hi - lo < 12) {
    const mid = (hi + lo) / 2;
    lo = Math.floor(mid - 6);
    hi = Math.ceil(mid + 6);
  }
  const seconds = n * frameSeconds;
  const W = chartWidth(n, frameSeconds, pxPerSecond);
  const strip = timingErrors ? STRIP + 4 : 0;
  const totalH = H + strip;
  const plotBottom = H - PAD_B;
  const x = (i: number) => PAD_L + (i / Math.max(1, n - 1)) * (W - PAD_L - 4);
  const y = (m: number) => 4 + (1 - (m - lo) / (hi - lo)) * (plotBottom - 8);

  const path = (arr: Float32Array, include: (i: number) => boolean = () => true) => {
    let d = '';
    let pen = false;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (Number.isNaN(v) || !include(i)) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const semis = [];
  for (let m = Math.ceil(lo); m <= hi; m++) semis.push(m);
  const tickEvery = seconds > 120 ? 10 : seconds > 20 ? 5 : seconds > 8 ? 2 : 1;
  const ticks = [];
  for (let t = 0; t <= seconds; t += tickEvery) ticks.push(t);

  // Each user frame is drawn in the colour of its score; runs share one path.
  const userPaths =
    user && frameScores
      ? (['great', 'ok', 'low'] as const).map((tone) => ({
          tone,
          d: path(user, (i) => toneOf(frameScores[i]) === tone || (i + 1 < n && toneOf(frameScores[i + 1]) === tone)),
        }))
      : user
        ? [{ tone: 'plain' as const, d: path(user) }]
        : [];

  // Runs of frames with the same timing class become one rectangle.
  const timingRuns: { cls: Exclude<TimingClass, null>; from: number; to: number }[] = [];
  if (timingErrors) {
    let cur: TimingClass = null;
    let from = 0;
    for (let i = 0; i <= n; i++) {
      const c = i < n ? timingClass(timingErrors[i]) : null;
      if (c === cur) continue;
      if (cur) timingRuns.push({ cls: cur, from, to: i });
      cur = c;
      from = i;
    }
  }
  const stripY = H - 2;

  return (
      <svg
        className={`pitch-chart ${pxPerSecond ? 'wide' : ''}`}
        viewBox={`0 0 ${W} ${totalH}`}
        role="img"
        aria-label={timingErrors ? '음정 그래프와 타이밍 표시' : '음정 그래프'}
      >
        {semis.map((m) => (
          <g key={m}>
            <line x1={PAD_L} x2={W - 4} y1={y(m)} y2={y(m)} className={m % 12 === 0 ? 'grid grid-c' : 'grid'} />
            {(m % 12 === 0 || m % 2 === 0) && (
              <text x={PAD_L - 4} y={y(m) + 3} className="axis" textAnchor="end">
                {midiName(m)}
              </text>
            )}
          </g>
        ))}
        {ticks.map((t) => (
          <text key={t} x={x(t / frameSeconds)} y={plotBottom + 12} className="axis" textAnchor="middle">
            {t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : `${t}s`}
          </text>
        ))}
        <path d={path(reference)} className="ref-line" />
        {userPaths.map((p) => (
          <path key={p.tone} d={p.d} className={`user-line tone-${p.tone}`} />
        ))}
        {timingErrors && (
          <g>
            <text x={PAD_L - 4} y={stripY + STRIP - 2} className="axis" textAnchor="end">
              박자
            </text>
            <rect x={PAD_L} y={stripY} width={W - PAD_L - 4} height={STRIP} className="timing-track" rx="3" />
            {timingRuns.map((r) => (
              <rect
                key={r.from}
                x={x(r.from)}
                y={stripY}
                width={Math.max(1.5, x(r.to) - x(r.from))}
                height={STRIP}
                className={`timing-mark ${r.cls}`}
              />
            ))}
          </g>
        )}
      </svg>
  );
});

export function TimingLegend() {
  return (
    <p className="legend small">
      박자 띠: <span className="swatch early" /> 원곡보다 빨리 <span className="swatch late" /> 원곡보다 늦게 (진할수록 0.4초 이상) · 빈
      곳은 0.15초 이내로 맞았거나 원곡이 쉬는 곳이에요
    </p>
  );
}
