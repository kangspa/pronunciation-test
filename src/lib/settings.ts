import { DEFAULT_MODEL_ID } from '../asr/models';

// Small preferences only. Model weights live in Cache Storage (see asr/modelStore.ts);
// localStorage is capped at ~5 MB, far below any model size.
const KEY = 'pronunciation-test:settings';
const BEST_KEY = 'pronunciation-test:best';

export interface Settings {
  modelId: string;
  saveModels: boolean;
}

const DEFAULTS: Settings = { modelId: DEFAULT_MODEL_ID, saveModels: true };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode or blocked storage: settings just won't persist.
  }
}

export function loadBestScores(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

export function recordBestScore(id: string, score: number): Record<string, number> {
  const best = loadBestScores();
  if (!(id in best) || score > best[id]) best[id] = score;
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(best));
  } catch {
    // ignore
  }
  return best;
}
