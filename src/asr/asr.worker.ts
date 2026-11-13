/// <reference lib="webworker" />
import { AutoProcessor, WhisperForConditionalGeneration, env } from '@huggingface/transformers';
import type { Processor } from '@huggingface/transformers';
import { WhisperScorer } from './whisperScorer';
import type { FileProgress, WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

env.allowLocalModels = false;

let processor: Processor | null = null;
let model: WhisperForConditionalGeneration | null = null;
let scorer: WhisperScorer | null = null;
// Loads and scores run strictly one at a time, so a load can't dispose the
// model while a score is still using it.
let queue: Promise<void> = Promise.resolve();

const post = (msg: WorkerResponse) => self.postMessage(msg);

interface ProgressEvent {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

async function load(req: Extract<WorkerRequest, { type: 'load' }>) {
  const { preset, useCache } = req;
  env.useBrowserCache = useCache;
  env.useWasmCache = useCache;

  if (model) {
    const old = model;
    model = null;
    scorer = null;
    processor = null;
    try {
      await old.dispose();
    } catch {
      // A failed dispose only leaks the old session; the new load can still proceed.
    }
  }

  const files = new Map<string, FileProgress>();
  let lastPost = 0;
  const progress_callback = (e: ProgressEvent) => {
    if (!e.file) return;
    const f = files.get(e.file) ?? { file: e.file, loaded: 0, total: 0, done: false };
    if (e.status === 'progress') {
      f.loaded = e.loaded ?? f.loaded;
      f.total = e.total ?? f.total;
    } else if (e.status === 'done') {
      f.done = true;
      f.loaded = f.total;
    }
    files.set(e.file, f);
    const now = performance.now();
    if (e.status !== 'progress' || now - lastPost > 150) {
      lastPost = now;
      post({ type: 'progress', modelId: preset.id, files: [...files.values()] });
    }
  };

  try {
    processor = await AutoProcessor.from_pretrained(preset.repo, { progress_callback });
    model = (await WhisperForConditionalGeneration.from_pretrained(preset.repo, {
      dtype: preset.dtype,
      device: preset.device,
      progress_callback,
    } as Parameters<typeof WhisperForConditionalGeneration.from_pretrained>[1])) as WhisperForConditionalGeneration;
    scorer = new WhisperScorer(model, processor.tokenizer!);
    post({ type: 'ready', modelId: preset.id, device: preset.device });
  } catch (err) {
    model = null;
    scorer = null;
    post({ type: 'load-error', modelId: preset.id, message: err instanceof Error ? err.message : String(err) });
  }
}

async function score(req: Extract<WorkerRequest, { type: 'score' }>) {
  try {
    if (!scorer || !processor) throw new Error('모델이 아직 로드되지 않았어요.');
    const { input_features } = await processor(req.audio);
    const output = await scorer.score(input_features, req.target, req.language);
    post({ type: 'result', requestId: req.requestId, output });
  } catch (err) {
    post({ type: 'score-error', requestId: req.requestId, message: err instanceof Error ? err.message : String(err) });
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  // load() and score() report their own errors; the catch is a backstop so one
  // unexpected throw can't leave the queue rejected and every later request unanswered.
  queue = queue
    .then(() => (req.type === 'load' ? load(req) : score(req)))
    .catch((err) => console.error('ASR worker task failed', err));
};
