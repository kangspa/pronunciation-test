import type { ModelPreset } from './models';
import type { ScoreOutput } from './whisperScorer';

export type WorkerRequest =
  | { type: 'load'; preset: ModelPreset; useCache: boolean }
  | { type: 'score'; requestId: number; audio: Float32Array; target: string; language: string }
  | { type: 'transcribe'; requestId: number; audio: Float32Array; language: string }
  // Stereo segment at 44.1 kHz.
  | { type: 'separate'; requestId: number; left: Float32Array; right: Float32Array; useCache: boolean }
  | { type: 'pitch'; requestId: number; audio: Float32Array; gateDb: number; useCache: boolean };

export interface FileProgress {
  file: string;
  loaded: number;
  total: number;
  done: boolean;
}

export interface SeparateResult {
  vocals44k: Float32Array;
  vocals16k: Float32Array;
}

export interface PitchResult {
  midi: Float32Array;
  frameSeconds: number;
}

export type WorkerResponse =
  | { type: 'progress'; modelId: string; files: FileProgress[] }
  | { type: 'ready'; modelId: string; device: string }
  | { type: 'load-error'; modelId: string; message: string }
  // Download/compute progress for a request (song analysis models).
  | { type: 'request-progress'; requestId: number; label: string; loaded: number; total: number }
  | { type: 'result'; requestId: number; output: ScoreOutput }
  | { type: 'transcribe-result'; requestId: number; text: string }
  | { type: 'separate-result'; requestId: number; result: SeparateResult }
  | { type: 'pitch-result'; requestId: number; result: PitchResult }
  | { type: 'request-error'; requestId: number; message: string };
