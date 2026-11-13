// Worker-side: downloads, caches and runs the song analysis models.
// Uses the same onnxruntime-web entry as transformers.js so both share one
// runtime and its WASM files.
import * as ort from 'onnxruntime-web/webgpu';
import { AUDIO_MODELS, AUDIO_MODEL_CACHE } from './audioModels';
import type { AudioModel } from './audioModels';
import type { PitchRunner } from './pitch';
import type { StemRunner } from './separation';

export type ProgressFn = (label: string, loaded: number, total: number) => void;

const sessions = new Map<AudioModel['id'], Promise<ort.InferenceSession>>();

async function openCache(): Promise<Cache | null> {
  try {
    return await caches.open(AUDIO_MODEL_CACHE);
  } catch {
    return null;
  }
}

async function fetchModel(model: AudioModel, useCache: boolean, onProgress: ProgressFn): Promise<Uint8Array> {
  const cache = useCache ? await openCache() : null;
  const hit = await cache?.match(model.url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());

  const res = await fetch(model.url);
  if (!res.ok || !res.body) throw new Error(`${model.label} 다운로드 실패 (${res.status})`);
  const total = Number(res.headers.get('content-length')) || model.sizeMB * 1e6;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(model.label, loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  if (cache) {
    await cache
      .put(model.url, new Response(bytes, { headers: { 'content-length': String(loaded) } }))
      .catch(() => {});
  }
  return bytes;
}

function session(id: AudioModel['id'], useCache: boolean, onProgress: ProgressFn): Promise<ort.InferenceSession> {
  let s = sessions.get(id);
  if (!s) {
    const model = AUDIO_MODELS.find((m) => m.id === id)!;
    s = fetchModel(model, useCache, onProgress).then((bytes) =>
      ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] }),
    );
    // Don't keep a failed download around; the next request retries.
    s.catch(() => sessions.delete(id));
    sessions.set(id, s);
  }
  return s;
}

export async function stemRunner(id: 'vocals' | 'accompaniment', useCache: boolean, onProgress: ProgressFn): Promise<StemRunner> {
  const s = await session(id, useCache, onProgress);
  return async (input, dims) => {
    const out = await s.run({ x: new ort.Tensor('float32', input, dims) });
    return out.y.data as Float32Array;
  };
}

export async function pitchRunner(useCache: boolean, onProgress: ProgressFn): Promise<PitchRunner> {
  const s = await session('pitch', useCache, onProgress);
  return async (audio) => {
    const out = await s.run({ input_audio: new ort.Tensor('float32', audio, [1, audio.length]) });
    return { hz: out.pitch_hz.data as Float32Array, confidence: out.confidence.data as Float32Array };
  };
}
