import type { ModelPreset } from './models';
import type { FileProgress, PitchResult, SeparateResult, WorkerRequest, WorkerResponse } from './protocol';
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
export type RequestProgress = (label: string, loaded: number, total: number) => void;

// Single worker shared by the whole app; the model stays loaded across pages.
class AsrClient {
  private worker: Worker | null = null;
  private state: ModelState = { status: 'idle' };
  private listeners = new Set<Listener>();
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: never) => void; reject: (e: Error) => void; onProgress?: RequestProgress }
  >();

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
      case 'request-progress':
        this.pending.get(msg.requestId)?.onProgress?.(msg.label, msg.loaded, msg.total);
        break;
      case 'result':
        this.settle(msg.requestId, msg.output);
        break;
      case 'transcribe-result':
        this.settle(msg.requestId, msg.text);
        break;
      case 'separate-result':
      case 'pitch-result':
        this.settle(msg.requestId, msg.result);
        break;
      case 'request-error':
        this.pending.get(msg.requestId)?.reject(new Error(msg.message));
        this.pending.delete(msg.requestId);
        break;
    }
  }

  private settle(requestId: number, value: unknown) {
    (this.pending.get(requestId)?.resolve as ((v: unknown) => void) | undefined)?.(value);
    this.pending.delete(requestId);
  }

  // Sends a request and resolves with its matching *-result payload.
  private request<T>(
    build: (requestId: number) => WorkerRequest,
    transfer: Transferable[],
    onProgress?: RequestProgress,
  ): Promise<T> {
    const requestId = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (v: never) => void, reject, onProgress });
      this.ensureWorker().postMessage(build(requestId), transfer);
    });
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

  // The audio buffers passed below are transferred to the worker; callers must not reuse them.
  score(audio: Float32Array, target: string, language: string, onProgress?: RequestProgress): Promise<ScoreOutput> {
    return this.request((requestId) => ({ type: 'score', requestId, audio, target, language }), [audio.buffer], onProgress);
  }

  transcribe(audio: Float32Array, language: string, onProgress?: RequestProgress): Promise<string> {
    return this.request((requestId) => ({ type: 'transcribe', requestId, audio, language }), [audio.buffer], onProgress);
  }

  separate(left: Float32Array, right: Float32Array, useCache: boolean, onProgress?: RequestProgress): Promise<SeparateResult> {
    const transfer = left.buffer === right.buffer ? [left.buffer] : [left.buffer, right.buffer];
    return this.request((requestId) => ({ type: 'separate', requestId, left, right, useCache }), transfer, onProgress);
  }

  pitch(audio: Float32Array, gateDb: number, useCache: boolean, onProgress?: RequestProgress): Promise<PitchResult> {
    return this.request((requestId) => ({ type: 'pitch', requestId, audio, gateDb, useCache }), [audio.buffer], onProgress);
  }
}

export const asrClient = new AsrClient();
