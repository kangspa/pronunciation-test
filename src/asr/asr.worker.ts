/// <reference lib="webworker" />
import { AutoProcessor, WhisperForConditionalGeneration, env } from '@huggingface/transformers';
import type { Processor } from '@huggingface/transformers';
import { pitchRunner, stemRunner } from '../audio/audioSessions';
import { PITCH_RATE, trackPitch } from '../audio/pitch';
import { resample } from '../audio/resample';
import { SEPARATION_RATE, separateVocals } from '../audio/separation';
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
    const proc = processor;
    scorer = new WhisperScorer(model, processor.tokenizer!, async (audio) => (await proc(audio)).input_features);
    post({ type: 'ready', modelId: preset.id, device: preset.device });
  } catch (err) {
    model = null;
    scorer = null;
    post({ type: 'load-error', modelId: preset.id, message: err instanceof Error ? err.message : String(err) });
  }
}

type RequestOf<T extends WorkerRequest['type']> = Extract<WorkerRequest, { type: T }>;

function requireWhisper() {
  if (!scorer) throw new Error('음성 인식 모델이 아직 로드되지 않았어요.');
  return scorer;
}

// "(2/3)" only when the audio spans several Whisper windows.
const chunkLabel = (requestId: number, label: string) => (k: number, n: number) =>
  post({ type: 'request-progress', requestId, label: n > 1 ? `${label} (${k + 1}/${n})` : label, loaded: k, total: n });

async function score(req: RequestOf<'score'>) {
  const output = await requireWhisper().score(req.audio, req.target, req.language, chunkLabel(req.requestId, '발음 분석 중'));
  post({ type: 'result', requestId: req.requestId, output });
}

async function transcribe(req: RequestOf<'transcribe'>) {
  const text = await requireWhisper().transcribe(req.audio, req.language, chunkLabel(req.requestId, '가사 인식 중'));
  post({ type: 'transcribe-result', requestId: req.requestId, text });
}

const progressFor = (requestId: number) => {
  let last = 0;
  return (label: string, loaded: number, total: number) => {
    const now = performance.now();
    if (now - last < 150 && loaded < total) return;
    last = now;
    post({ type: 'request-progress', requestId, label, loaded, total });
  };
};

async function separate(req: RequestOf<'separate'>) {
  const onProgress = progressFor(req.requestId);
  const vocalsModel = await stemRunner('vocals', req.useCache, onProgress);
  const accModel = await stemRunner('accompaniment', req.useCache, onProgress);
  onProgress('보컬 분리 중', 0, 1);
  const vocals44k = await separateVocals(req.left, req.right, vocalsModel, accModel);
  const vocals16k = resample(vocals44k, SEPARATION_RATE, PITCH_RATE);
  self.postMessage({ type: 'separate-result', requestId: req.requestId, result: { vocals44k, vocals16k } } satisfies WorkerResponse, [
    vocals44k.buffer,
    vocals16k.buffer,
  ]);
}

async function pitch(req: RequestOf<'pitch'>) {
  const run = await pitchRunner(req.useCache, progressFor(req.requestId));
  const track = await trackPitch(req.audio, run, { gateDb: req.gateDb });
  self.postMessage(
    { type: 'pitch-result', requestId: req.requestId, result: { midi: track.midi, frameSeconds: track.frameSeconds } } satisfies WorkerResponse,
    [track.midi.buffer],
  );
}

async function handle(req: WorkerRequest) {
  if (req.type === 'load') return load(req);
  try {
    if (req.type === 'score') await score(req);
    else if (req.type === 'transcribe') await transcribe(req);
    else if (req.type === 'separate') await separate(req);
    else await pitch(req);
  } catch (err) {
    post({ type: 'request-error', requestId: req.requestId, message: err instanceof Error ? err.message : String(err) });
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  // handle() reports its own errors; the catch is a backstop so one
  // unexpected throw can't leave the queue rejected and every later request unanswered.
  queue = queue.then(() => handle(req)).catch((err) => console.error('ASR worker task failed', err));
};
