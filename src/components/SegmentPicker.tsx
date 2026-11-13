import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { BufferPlayer } from '../audio/bufferPlayer';
import type { PlayMode } from '../audio/bufferPlayer';

interface Props {
  buffer: AudioBuffer;
  start: number;
  end: number;
  maxLength: number;
  disabled?: boolean;
  onChange: (start: number, end: number) => void;
}

const HEIGHT = 112;
const MIN_LENGTH = 1;
// Zoomed view spans this many seconds around the selection.
const ZOOM_SECONDS = 60;
// After dropping the end bar, playback resumes this far before it so the boundary is heard.
const END_PREVIEW_SECONDS = 3;

type Drag =
  | { kind: 'start'; view: View }
  | { kind: 'end'; view: View }
  | { kind: 'region'; view: View; anchor: number; origStart: number; origEnd: number; moved: boolean }
  | { kind: 'seek'; view: View };

interface View {
  from: number;
  to: number;
}

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

// Keeps the typed text while focused and applies it on blur or Enter.
// Committing per keystroke clamped and reformatted partial input, so typing
// "60" became "6.0" after the first digit.
function SecondsField({
  value,
  max,
  disabled,
  onCommit,
}: {
  value: number;
  max: number;
  disabled: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft.trim() !== '' && Number.isFinite(Number(draft))) onCommit(Number(draft));
    setDraft(null);
  };
  return (
    <input
      type="number"
      min={0}
      max={max}
      step={0.1}
      disabled={disabled}
      value={draft ?? value.toFixed(1)}
      onFocus={() => setDraft(value.toFixed(1))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

// Timeline with a moving playhead and two draggable bars. The bars can never
// be more than maxLength apart; dragging past that stops at the limit.
// Dropping a bar while playing resumes from it, so the boundary can be
// adjusted by ear.
export function SegmentPicker({ buffer, start, end, maxLength, disabled = false, onChange }: Props) {
  const duration = buffer.duration;
  const player = useMemo(() => new BufferPlayer(buffer), [buffer]);
  const playing = useSyncExternalStore(player.subscribe, player.isPlaying);
  const [now, setNow] = useState(start);
  const [zoom, setZoom] = useState(duration > ZOOM_SECONDS * 1.5);
  const [loop, setLoop] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [width, setWidth] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => () => player.dispose(), [player]);

  // Keep a running segment playback's stop/loop points on the moving bars.
  useEffect(() => {
    player.updateRange(start, end);
  }, [player, start, end]);

  useEffect(() => {
    if (disabled) player.pause();
  }, [disabled, player]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Playhead animation only; stops and loops are scheduled inside the player.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      setNow(player.time());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, player]);
  // While paused the player's position is authoritative (e.g. where a scheduled stop landed).
  const position = playing ? now : player.time();

  // The zoomed view follows the selection, but stays put while dragging so
  // the bars don't slide away under the pointer.
  const liveView = (): View => {
    if (!zoom) return { from: 0, to: duration };
    const len = Math.min(duration, ZOOM_SECONDS);
    const from = Math.max(0, Math.min((start + end) / 2 - len / 2, duration - len));
    return { from, to: from + len };
  };
  const view = drag?.view ?? liveView();
  const span = Math.max(1e-6, view.to - view.from);
  const pct = (t: number) => ((t - view.from) / span) * 100;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = HEIGHT * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, HEIGHT);
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--wave');
    const data = buffer.getChannelData(0);
    const rate = buffer.sampleRate;
    const s0 = Math.floor(view.from * rate);
    const per = ((view.to - view.from) * rate) / width;
    for (let x = 0; x < width; x++) {
      const a = Math.floor(s0 + x * per);
      const b = Math.min(data.length, Math.floor(s0 + (x + 1) * per));
      let max = 0;
      // Long views are sampled sparsely; peaks still read fine at this size.
      const stride = Math.max(1, Math.floor((b - a) / 400));
      for (let i = a; i < b; i += stride) max = Math.max(max, Math.abs(data[i]));
      const h = Math.max(1, max * (HEIGHT - 10));
      ctx.fillRect(x, (HEIGHT - h) / 2, 1, h);
    }
  }, [buffer, width, view.from, view.to]);

  const timeAt = (clientX: number, v: View) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, v.from + ((clientX - rect.left) / rect.width) * (v.to - v.from)));
  };

  const setStart = (t: number) => {
    let s = Math.max(0, Math.min(t, end - MIN_LENGTH));
    if (end - s > maxLength) s = end - maxLength;
    onChange(s, end);
  };
  const setEnd = (t: number) => {
    let e = Math.min(duration, Math.max(t, start + MIN_LENGTH));
    if (e - start > maxLength) e = start + maxLength;
    onChange(start, e);
  };
  const moveTo = (s: number, len: number) => {
    const ns = Math.max(0, Math.min(s, duration - len));
    onChange(ns, ns + len);
  };

  const seek = (t: number) => {
    player.seek(t);
    setNow(t);
  };

  const segmentMode = (): PlayMode => (loop ? { kind: 'loop', start, end } : { kind: 'until', end });

  // Plays from t and stops (or loops) at the end bar.
  const playSegmentFrom = (t: number) => {
    player.play(t, segmentMode());
    setNow(t);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-drag]');
    const kind = (target?.dataset.drag ?? 'seek') as Drag['kind'];
    const v = view;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (kind === 'region') {
      setDrag({ kind, view: v, anchor: timeAt(e.clientX, v), origStart: start, origEnd: end, moved: false });
    } else {
      setDrag({ kind, view: v });
      if (kind === 'seek') {
        seek(timeAt(e.clientX, v));
      }
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const t = timeAt(e.clientX, drag.view);
    if (drag.kind === 'start') setStart(t);
    else if (drag.kind === 'end') setEnd(t);
    else if (drag.kind === 'seek') seek(t);
    else {
      const delta = t - drag.anchor;
      if (Math.abs(delta) > span / 300) {
        if (!drag.moved) setDrag({ ...drag, moved: true });
        moveTo(drag.origStart + delta, drag.origEnd - drag.origStart);
      }
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.kind === 'start' || (d.kind === 'region' && d.moved)) {
      if (playing) playSegmentFrom(start);
      else seek(start);
    } else if (d.kind === 'end') {
      if (playing) playSegmentFrom(Math.max(start, end - END_PREVIEW_SECONDS));
      else seek(end);
    } else if (d.kind === 'region') {
      // A plain click inside the selection seeks like anywhere else.
      seek(timeAt(e.clientX, d.view));
    }
  };

  const onHandleKey = (which: 'start' | 'end') => (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 1 : 0.1;
    const delta = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    if (!delta || disabled) return;
    e.preventDefault();
    if (which === 'start') setStart(start + delta);
    else setEnd(end + delta);
  };

  const togglePlay = () => {
    if (playing) {
      player.pause();
      return;
    }
    // Starting inside the selection with loop on repeats the segment.
    const from = position >= duration - 0.05 ? 0 : position;
    player.play(from, loop && from >= start && from < end ? { kind: 'loop', start, end } : { kind: 'free' });
  };

  const ticks = useMemo(() => {
    const candidates = [1, 2, 5, 10, 15, 30, 60];
    const stepSec = candidates.find((c) => span / c <= 8) ?? 120;
    const out: number[] = [];
    for (let t = Math.ceil(view.from / stepSec) * stepSec; t <= view.to; t += stepSec) out.push(t);
    return out;
  }, [span, view.from, view.to]);

  const length = end - start;
  const atLimit = length >= maxLength - 0.05;

  // Overview of the whole song while zoomed: click or drag to move the
  // selection (keeping its length) and the playhead there.
  const overviewRef = useRef<HTMLDivElement>(null);
  const overviewDrag = useRef(false);
  const jumpTo = (clientX: number) => {
    const rect = overviewRef.current!.getBoundingClientRect();
    const t = Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration));
    const len = end - start;
    moveTo(t - len / 2, len);
    seek(Math.max(0, Math.min(t - len / 2, duration - len)));
  };

  return (
    <div className={`segment-picker ${disabled ? 'disabled' : ''}`}>
      {zoom && (
        <div
          ref={overviewRef}
          className="timeline-overview"
          aria-label="전체 곡에서 구간 위치"
          onPointerDown={(e) => {
            if (disabled) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            overviewDrag.current = true;
            jumpTo(e.clientX);
          }}
          onPointerMove={(e) => {
            if (overviewDrag.current) jumpTo(e.clientX);
          }}
          onPointerUp={() => {
            overviewDrag.current = false;
            if (playing) playSegmentFrom(start);
          }}
        >
          <div className="overview-region" style={{ left: `${(start / duration) * 100}%`, width: `${((end - start) / duration) * 100}%` }} />
          <div className="overview-playhead" style={{ left: `${(position / duration) * 100}%` }} />
        </div>
      )}
      <div
        ref={trackRef}
        className="timeline"
        style={{ height: HEIGHT }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
      >
        <canvas ref={canvasRef} className="timeline-wave" style={{ height: HEIGHT }} />
        <div className="timeline-dim" style={{ left: 0, width: `${Math.max(0, pct(start))}%` }} />
        <div className="timeline-dim" style={{ left: `${Math.min(100, pct(end))}%`, right: 0 }} />
        <div
          className={`timeline-region ${atLimit ? 'at-limit' : ''}`}
          data-drag="region"
          style={{ left: `${pct(start)}%`, width: `${pct(end) - pct(start)}%` }}
        >
          {/* Too narrow to fit; the length is also shown below the timeline. */}
          {((pct(end) - pct(start)) / 100) * width >= 48 && (
            <span className="timeline-region-label">{length.toFixed(1)}초</span>
          )}
        </div>
        {(['start', 'end'] as const).map((which) => (
          <div
            key={which}
            className={`timeline-handle handle-${which}`}
            data-drag={which}
            style={{ left: `${pct(which === 'start' ? start : end)}%` }}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={which === 'start' ? '구간 시작' : '구간 끝'}
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={which === 'start' ? start : end}
            aria-valuetext={formatTime(which === 'start' ? start : end)}
            onKeyDown={onHandleKey(which)}
          >
            <span className="handle-knob">{which === 'start' ? '시작' : '끝'}</span>
          </div>
        ))}
        {position >= view.from && position <= view.to && <div className="timeline-playhead" style={{ left: `${pct(position)}%` }} />}
      </div>
      <div className="timeline-ruler">
        {ticks.map((t) => (
          <span key={t} style={{ left: `${pct(t)}%` }}>
            {formatTime(t).replace(/\.0$/, '')}
          </span>
        ))}
      </div>

      <div className="transport">
        <button className="button button-primary play-button" onClick={togglePlay} disabled={disabled} aria-label={playing ? '일시정지' : '재생'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="button" onClick={() => playSegmentFrom(start)} disabled={disabled}>
          구간 처음부터
        </button>
        <label className="loop-toggle">
          <input
            type="checkbox"
            checked={loop}
            onChange={(e) => {
              const on = e.target.checked;
              setLoop(on);
              if (!playing) return;
              const t = player.time();
              const inside = t >= start && t < end;
              // Switch the running playback in place. Turning loop off must
              // always leave loop playback, even if the bars moved past the playhead.
              if (on && inside) player.play(t, { kind: 'loop', start, end });
              else if (!on && player.playMode() === 'loop') player.play(t, inside ? { kind: 'until', end } : { kind: 'free' });
            }}
            disabled={disabled}
          />
          구간 반복
        </label>
        <span className="time-readout">
          <b>{formatTime(position)}</b> / {formatTime(duration)}
        </span>
        <span className="zoom-toggle" role="group" aria-label="보기">
          <button className={!zoom ? 'active' : ''} onClick={() => setZoom(false)}>
            전체
          </button>
          <button className={zoom ? 'active' : ''} onClick={() => setZoom(true)} disabled={duration <= ZOOM_SECONDS}>
            확대
          </button>
        </span>
      </div>

      <div className="segment-inputs">
        <label>
          시작
          <SecondsField value={start} max={duration} disabled={disabled} onCommit={setStart} />초
        </label>
        <button className="link-button" onClick={() => setStart(position)} disabled={disabled}>
          현재 위치를 시작으로
        </button>
        <label>
          끝
          <SecondsField value={end} max={duration} disabled={disabled} onCommit={setEnd} />초
        </label>
        <button className="link-button" onClick={() => setEnd(position)} disabled={disabled}>
          현재 위치를 끝으로
        </button>
        <span className={`small ${atLimit ? 'limit-note' : 'muted'}`}>
          길이 {length.toFixed(1)}초 / 최대 {maxLength}초{atLimit ? ' (최대 길이)' : ''}
        </span>
      </div>
    </div>
  );
}
