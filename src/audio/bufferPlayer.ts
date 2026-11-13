export type PlayMode =
  | { kind: 'free' }
  // Stops at `end`, scheduled on the audio clock.
  | { kind: 'until'; end: number }
  // Repeats start..end natively (AudioBufferSourceNode.loop).
  | { kind: 'loop'; start: number; end: number };

// Plays an AudioBuffer from any offset and reports the play position.
// Stops and loops are scheduled on the audio node itself rather than checked
// per animation frame, so they hold in background tabs (where frames pause)
// and at the very end of the buffer. AudioBufferSourceNode can't seek, so
// seeking restarts a new node. Exposes subscribe/isPlaying for
// useSyncExternalStore.
export class BufferPlayer {
  private readonly buffer: AudioBuffer;
  private ctx: AudioContext | null = null;
  private src: AudioBufferSourceNode | null = null;
  private mode: PlayMode = { kind: 'free' };
  private startedCtxTime = 0;
  private startedOffset = 0;
  private pausedAt = 0;
  private listeners = new Set<() => void>();

  constructor(buffer: AudioBuffer) {
    this.buffer = buffer;
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  isPlaying = () => this.src !== null;

  playMode(): PlayMode['kind'] {
    return this.src ? this.mode.kind : 'free';
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  private clamp(t: number) {
    return Math.max(0, Math.min(t, this.buffer.duration));
  }

  time(): number {
    if (!this.src || !this.ctx) return this.pausedAt;
    let t = this.startedOffset + (this.ctx.currentTime - this.startedCtxTime);
    const m = this.mode;
    if (m.kind === 'loop' && t >= m.end && m.end > m.start) t = m.start + ((t - m.start) % (m.end - m.start));
    if (m.kind === 'until') t = Math.min(t, m.end);
    return this.clamp(t);
  }

  play(from = this.pausedAt, mode: PlayMode = { kind: 'free' }) {
    this.ctx ??= new AudioContext();
    void this.ctx.resume();
    this.stopNode();
    const offset = this.clamp(from);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.ctx.destination);
    src.onended = () => {
      if (this.src !== src) return;
      this.src = null;
      this.pausedAt = this.mode.kind === 'until' ? this.clamp(this.mode.end) : this.buffer.duration;
      this.emit();
    };
    this.src = src;
    this.mode = mode;
    this.startedCtxTime = this.ctx.currentTime;
    this.startedOffset = offset;
    // start() first: scheduling stop() on a node that hasn't started throws.
    src.start(0, offset);
    this.applyMode();
    this.emit();
  }

  // Moves the loop points or the scheduled stop of the current playback,
  // e.g. while the user drags a bar.
  updateRange(start: number, end: number) {
    if (!this.src || this.mode.kind === 'free') return;
    // Read the position under the old range first, then restart the
    // position formula from it under the new one.
    const t = this.time();
    this.mode = this.mode.kind === 'loop' ? { kind: 'loop', start, end } : { kind: 'until', end };
    this.startedOffset = t;
    this.startedCtxTime = this.ctx!.currentTime;
    this.applyMode();
  }

  pause(at?: number) {
    const t = at ?? this.time();
    this.stopNode();
    this.pausedAt = this.clamp(t);
    this.emit();
  }

  // Seeking during playback continues without a stop or loop.
  seek(t: number) {
    if (this.src) this.play(t);
    else this.pausedAt = this.clamp(t);
  }

  dispose() {
    this.stopNode();
    void this.ctx?.close();
    this.ctx = null;
  }

  private applyMode() {
    const src = this.src;
    const ctx = this.ctx;
    if (!src || !ctx) return;
    const m = this.mode;
    src.loop = m.kind === 'loop';
    if (m.kind === 'loop') {
      src.loopStart = m.start;
      src.loopEnd = m.end;
    } else if (m.kind === 'until') {
      // stop() may be called again; the latest call wins.
      src.stop(ctx.currentTime + Math.max(0, m.end - this.time()));
    }
  }

  private stopNode() {
    if (!this.src) return;
    const src = this.src;
    this.src = null;
    src.onended = null;
    try {
      src.stop();
    } catch {
      // Already stopped.
    }
  }
}
