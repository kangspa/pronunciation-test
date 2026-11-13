import type { ModelPreset } from './models';
import type { ScoreOutput } from './whisperScorer';

export type WorkerRequest =
  | { type: 'load'; preset: ModelPreset; useCache: boolean }
  | { type: 'score'; requestId: number; audio: Float32Array; target: string; language: string };

export interface FileProgress {
  file: string;
  loaded: number;
  total: number;
  done: boolean;
}

export type WorkerResponse =
  | { type: 'progress'; modelId: string; files: FileProgress[] }
  | { type: 'ready'; modelId: string; device: string }
  | { type: 'load-error'; modelId: string; message: string }
  | { type: 'result'; requestId: number; output: ScoreOutput }
  | { type: 'score-error'; requestId: number; message: string };
