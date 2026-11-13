import type { ModelPreset } from './models';
import type { FileProgress, WorkerRequest, WorkerResponse } from './protocol';
import type { ScoreOutput } from './whisperScorer';

export type ModelState =
  | { status: 'idle' }
  | { status: 'loading'; modelId: string; files: FileProgress[] }
  | { status: 'ready'; modelId: string; device: string }
  | { status: 'error'; modelId: string; message: string };

export function loadPercent(state: ModelState): number {
  if (state.status !== 'loading' || state.files.length === 0) return 0;
  const total = state.files.reduce((s, f) => s + f.total, 0);
  const loaded = state.files.reduce((s, f) => s + f.loaded, 0);
  return total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
}

type Listener = (state: ModelState) => void;

// Single worker shared by the whole app; the model stays loaded across pages.
class AsrClient {
  private worker: Worker | null = null;
  private state: ModelState = { status: 'idle' };
  private listeners = new Set<Listener>();
  private nextId = 1;
  private pending = new Map<number, { resolve: (o: ScoreOutput) => void; reject: (e: Error) => void }>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handle(event.data);
    worker.onerror = (event) => this.crash(event.message || '워커 오류가 발생했어요.');
    worker.onmessageerror = () => this.crash('워커와 통신하지 못했어요.');
    this.worker = worker;
    return worker;
  }

  // A crashed worker never answers again: drop it so the next load starts a
  // fresh one, and fail every in-flight request instead of leaving it hanging.
  private crash(message: string) {
    this.worker?.terminate();
    this.worker = null;
    for (const { reject } of this.pending.values()) reject(new Error(message));
    this.pending.clear();
    const modelId = 'modelId' in this.state ? this.state.modelId : '';
    this.setState({ status: 'error', modelId, message });
  }

  private handle(msg: WorkerResponse) {
    switch (msg.type) {
      case 'progress':
        this.setState({ status: 'loading', modelId: msg.modelId, files: msg.files });
        break;
      case 'ready':
        this.setState({ status: 'ready', modelId: msg.modelId, device: msg.device });
        break;
      case 'load-error':
        this.setState({ status: 'error', modelId: msg.modelId, message: msg.message });
        break;
      case 'result':
        this.pending.get(msg.requestId)?.resolve(msg.output);
        this.pending.delete(msg.requestId);
        break;
      case 'score-error':
        this.pending.get(msg.requestId)?.reject(new Error(msg.message));
        this.pending.delete(msg.requestId);
        break;
    }
  }

  private setState(state: ModelState) {
    this.state = state;
    for (const l of this.listeners) l(state);
  }

  getState = (): ModelState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  load(preset: ModelPreset, useCache: boolean) {
    this.setState({ status: 'loading', modelId: preset.id, files: [] });
    const req: WorkerRequest = { type: 'load', preset, useCache };
    this.ensureWorker().postMessage(req);
  }

  score(audio: Float32Array, target: string, language: string): Promise<ScoreOutput> {
    const requestId = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const req: WorkerRequest = { type: 'score', requestId, audio, target, language };
      this.ensureWorker().postMessage(req, [audio.buffer]);
    });
  }
}

export const asrClient = new AsrClient();
