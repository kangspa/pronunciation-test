export type Device = 'wasm' | 'webgpu';

export interface ModelPreset {
  id: string;
  label: string;
  repo: string;
  device: Device;
  dtype: { encoder_model: string; decoder_model_merged: string };
  // Download size of the ONNX weights + tokenizer files, in MB.
  sizeMB: number;
  description: string;
  recommended?: boolean;
}

// Sizes measured from the Hugging Face repos (onnx/ folder + tokenizer files).
export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'whisper-tiny',
    label: 'Whisper Tiny',
    repo: 'onnx-community/whisper-tiny',
    device: 'wasm',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    sizeMB: 45,
    description: '가장 가볍고 빠르지만 한국어 인식이 부정확해요. 동작 확인용.',
  },
  {
    id: 'whisper-base',
    label: 'Whisper Base',
    repo: 'onnx-community/whisper-base',
    device: 'wasm',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    sizeMB: 81,
    description: '가벼운 편이지만 한국어 발음 구분력이 낮아요.',
  },
  {
    id: 'whisper-small',
    label: 'Whisper Small',
    repo: 'onnx-community/whisper-small',
    device: 'wasm',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    sizeMB: 253,
    description: '한국어 정확도와 속도의 균형이 좋아요. 대부분의 기기에서 동작합니다.',
    recommended: true,
  },
  {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper Large v3 Turbo',
    repo: 'onnx-community/whisper-large-v3-turbo',
    device: 'webgpu',
    dtype: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' },
    sizeMB: 568,
    description: '가장 정확하지만 WebGPU 지원 브라우저와 넉넉한 GPU 메모리가 필요해요. (실험적)',
  },
];

export const DEFAULT_MODEL_ID = 'whisper-small';

export function findPreset(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((m) => m.id === id);
}
