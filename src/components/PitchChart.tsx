import { midiName } from '../audio/pitch';

interface Props {
  reference: Float32Array;
  frameSeconds: number;
  // User pitch already aligned onto the reference timeline.
  user?: Float32Array;
  frameScores?: Float32Array;
}

const W = 800;
const H = 220;
const PAD_L = 36;
const PAD_B = 18;

function toneOf(score: number) {
  if (Number.isNaN(score)) return 'none';
  if (score >= 0.75) return 'great';
  if (score >= 0.35) return 'ok';
  return 'low';
}

export function PitchChart({ reference, frameSeconds, user, frameScores }: Props) {
  const n = reference.length;
  const values: number[] = [];
  for (const v of reference) if (!Number.isNaN(v)) values.push(v);
  if (user) for (const v of user) if (!Number.isNaN(v)) values.push(v);
  if (n === 0 || values.length === 0) return <p className="muted small">표시할 음정이 없어요.</p>;

  let lo = Math.floor(Math.min(...values)) - 2;
  let hi = Math.ceil(Math.max(...values)) + 2;
  if (hi - lo < 12) {
    const mid = (hi + lo) / 2;
    lo = Math.floor(mid - 6);
    hi = Math.ceil(mid + 6);
  }
  const x = (i: number) => PAD_L + (i / Math.max(1, n - 1)) * (W - PAD_L - 4);
  const y = (m: number) => 4 + (1 - (m - lo) / (hi - lo)) * (H - PAD_B - 8);

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
  const seconds = n * frameSeconds;
  const tickEvery = seconds > 20 ? 5 : seconds > 8 ? 2 : 1;
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

  return (
    <div className="chart-scroll">
      <svg className="pitch-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="음정 그래프">
        {semis.map((m) => (
          <g key={m}>
            <line
              x1={PAD_L}
              x2={W - 4}
              y1={y(m)}
              y2={y(m)}
              className={m % 12 === 0 ? 'grid grid-c' : 'grid'}
            />
            {(m % 12 === 0 || m % 2 === 0) && (
              <text x={PAD_L - 4} y={y(m) + 3} className="axis" textAnchor="end">
                {midiName(m)}
              </text>
            )}
          </g>
        ))}
        {ticks.map((t) => (
          <text key={t} x={x(t / frameSeconds)} y={H - 4} className="axis" textAnchor="middle">
            {t}s
          </text>
        ))}
        <path d={path(reference)} className="ref-line" />
        {userPaths.map((p) => (
          <path key={p.tone} d={p.d} className={`user-line tone-${p.tone}`} />
        ))}
      </svg>
    </div>
  );
}
