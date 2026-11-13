import { useEffect, useRef } from 'react';

interface Props {
  buffer: AudioBuffer;
  start: number;
  end: number;
  maxLength: number;
  onChange: (start: number, end: number) => void;
}

const HEIGHT = 96;

// Waveform with a draggable selection. Drag to select; the inputs below fine-tune.
export function SegmentPicker({ buffer, start, end, maxLength, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<Float32Array | null>(null);
  const dragRef = useRef<number | null>(null);
  const duration = buffer.duration;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = canvas.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = HEIGHT * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // Peaks are recomputed only when the canvas width or file changes.
    if (!peaksRef.current || peaksRef.current.length !== width) {
      const data = buffer.getChannelData(0);
      const peaks = new Float32Array(width);
      const per = Math.max(1, Math.floor(data.length / width));
      for (let x = 0; x < width; x++) {
        let max = 0;
        for (let i = x * per; i < Math.min(data.length, (x + 1) * per); i++) max = Math.max(max, Math.abs(data[i]));
        peaks[x] = max;
      }
      peaksRef.current = peaks;
    }
    const peaks = peaksRef.current;
    const styles = getComputedStyle(canvas);
    const sx = (start / duration) * width;
    const ex = (end / duration) * width;
    ctx.clearRect(0, 0, width, HEIGHT);
    ctx.fillStyle = styles.getPropertyValue('--accent-soft');
    ctx.fillRect(sx, 0, ex - sx, HEIGHT);
    for (let x = 0; x < width; x++) {
      const h = Math.max(1, peaks[x] * (HEIGHT - 8));
      ctx.fillStyle = x >= sx && x <= ex ? styles.getPropertyValue('--accent') : styles.getPropertyValue('--border');
      ctx.fillRect(x, (HEIGHT - h) / 2, 1, h);
    }
  }, [buffer, start, end, duration]);

  const timeAt = (clientX: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration));
  };

  const select = (anchor: number, t: number) => {
    let s = Math.min(anchor, t);
    let e = Math.max(anchor, t);
    if (e - s > maxLength) {
      if (t > anchor) e = s + maxLength;
      else s = e - maxLength;
    }
    onChange(s, e);
  };

  return (
    <div className="segment-picker">
      <canvas
        ref={canvasRef}
        className="waveform"
        style={{ height: HEIGHT }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = timeAt(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragRef.current !== null) select(dragRef.current, timeAt(e.clientX));
        }}
        onPointerUp={(e) => {
          const anchor = dragRef.current;
          dragRef.current = null;
          // A plain click moves the selection, keeping its length.
          if (anchor !== null && Math.abs(timeAt(e.clientX) - anchor) < duration / 200) {
            const len = end - start;
            const s = Math.min(anchor, Math.max(0, duration - len));
            onChange(s, s + len);
          }
        }}
      />
      <div className="segment-inputs">
        <label>
          시작
          <input
            type="number"
            min={0}
            max={duration}
            step={0.1}
            value={start.toFixed(1)}
            onChange={(e) => {
              const s = Math.max(0, Math.min(Number(e.target.value), end - 1));
              onChange(s, Math.min(end, s + maxLength));
            }}
          />
          초
        </label>
        <label>
          끝
          <input
            type="number"
            min={0}
            max={duration}
            step={0.1}
            value={end.toFixed(1)}
            onChange={(e) => {
              const v = Math.min(duration, Math.max(Number(e.target.value), start + 1));
              onChange(Math.max(start, v - maxLength), v);
            }}
          />
          초
        </label>
        <span className="muted small">
          길이 {(end - start).toFixed(1)}초 (최대 {maxLength}초) · 전체 {duration.toFixed(1)}초
        </span>
      </div>
    </div>
  );
}
