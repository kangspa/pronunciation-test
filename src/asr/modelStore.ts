import type { ModelPreset } from './models';

// transformers.js writes every downloaded file to this Cache Storage bucket,
// keyed by its full Hugging Face URL (https://huggingface.co/{repo}/resolve/main/{file}).
const CACHE_NAME = 'transformers-cache';

const DTYPE_SUFFIX: Record<string, string> = {
  fp32: '',
  fp16: '_fp16',
  q8: '_quantized',
  int8: '_int8',
  uint8: '_uint8',
  q4: '_q4',
  q4f16: '_q4f16',
  bnb4: '_bnb4',
};

export function requiredWeightFiles(preset: ModelPreset): string[] {
  return [
    `onnx/encoder_model${DTYPE_SUFFIX[preset.dtype.encoder_model] ?? ''}.onnx`,
    `onnx/decoder_model_merged${DTYPE_SUFFIX[preset.dtype.decoder_model_merged] ?? ''}.onnx`,
  ];
}

export interface CachedModelInfo {
  bytes: number;
  files: string[];
  complete: boolean;
}

function repoPrefix(repo: string) {
  return `/${repo}/resolve/`;
}

async function responseSize(res: Response): Promise<number> {
  const header = res.headers.get('content-length');
  if (header) return Number(header);
  return (await res.blob()).size;
}

export function cacheSupported(): boolean {
  return typeof caches !== 'undefined';
}

export async function inspectCache(presets: ModelPreset[]): Promise<{
  models: Record<string, CachedModelInfo>;
  otherBytes: number;
  // Set when Cache Storage exists but refuses to open (e.g. self-signed HTTPS).
  unavailable: boolean;
}> {
  const models: Record<string, CachedModelInfo> = {};
  for (const p of presets) models[p.id] = { bytes: 0, files: [], complete: false };
  let otherBytes = 0;
  if (!cacheSupported()) return { models, otherBytes, unavailable: true };

  let cache: Cache;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch {
    return { models, otherBytes, unavailable: true };
  }
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    const size = res ? await responseSize(res) : 0;
    const owner = presets.find((p) => req.url.includes(repoPrefix(p.repo)));
    if (!owner) {
      otherBytes += size;
      continue;
    }
    const info = models[owner.id];
    info.bytes += size;
    info.files.push(req.url.split(repoPrefix(owner.repo))[1]?.replace(/^[^/]+\//, '') ?? req.url);
  }
  for (const p of presets) {
    const info = models[p.id];
    info.complete = requiredWeightFiles(p).every((f) => info.files.includes(f));
  }
  return { models, otherBytes, unavailable: false };
}

// Deletes every cached file of the repo. Presets that share a repo but use
// another dtype lose their files too, which is fine here: one preset per repo.
export async function deleteModel(preset: ModelPreset): Promise<void> {
  if (!cacheSupported()) return;
  const cache = await caches.open(CACHE_NAME);
  for (const req of await cache.keys()) {
    if (req.url.includes(repoPrefix(preset.repo))) await cache.delete(req);
  }
}

export async function clearAll(): Promise<void> {
  if (!cacheSupported()) return;
  await caches.delete(CACHE_NAME);
}

export async function storageEstimate(): Promise<{ usage: number; quota: number; persisted: boolean } | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const persisted = (await navigator.storage.persisted?.()) ?? false;
  return { usage, quota, persisted };
}

// Asks the browser not to evict our cache under storage pressure.
export async function requestPersistence(): Promise<boolean> {
  return (await navigator.storage?.persist?.()) ?? false;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
