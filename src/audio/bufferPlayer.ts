// Plays an AudioBuffer from any offset and reports the play position.
// AudioBufferSourceNode can't seek, so seeking restarts a new node.
// Exposes subscribe/isPlaying for useSyncExternalStore.
export class BufferPlayer {
  private readonly buffer: AudioBuffer;
  private ctx: AudioContext | null = null;
  private src: AudioBufferSourceNode | null = null;
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

  private emit() {
    for (const l of this.listeners) l();
  }

  time(): number {
    if (!this.src || !this.ctx) return this.pausedAt;
    return Math.min(this.buffer.duration, this.startedOffset + (this.ctx.currentTime - this.startedCtxTime));
  }

  play(from = this.pausedAt) {
    this.ctx ??= new AudioContext();
    void this.ctx.resume();
    this.stopNode();
    const offset = Math.max(0, Math.min(from, this.buffer.duration));
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.ctx.destination);
    src.onended = () => {
      if (this.src !== src) return;
      this.src = null;
      this.pausedAt = this.buffer.duration;
      this.emit();
    };
    src.start(0, offset);
    this.src = src;
    this.startedCtxTime = this.ctx.currentTime;
    this.startedOffset = offset;
    this.emit();
  }

  pause(at?: number) {
    const t = at ?? this.time();
    this.stopNode();
    this.pausedAt = Math.max(0, Math.min(t, this.buffer.duration));
    this.emit();
  }

  seek(t: number) {
    if (this.src) this.play(t);
    else this.pausedAt = Math.max(0, Math.min(t, this.buffer.duration));
  }

  dispose() {
    this.stopNode();
    void this.ctx?.close();
    this.ctx = null;
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
