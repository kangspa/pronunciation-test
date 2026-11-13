// Small ONNX models for song analysis, fetched straight from Hugging Face and
// kept in their own Cache Storage bucket (transformers.js manages the other one).
export const AUDIO_MODEL_CACHE = 'audio-models-cache';

export interface AudioModel {
  id: 'vocals' | 'accompaniment' | 'pitch';
  label: string;
  url: string;
  sizeMB: number;
}

export const AUDIO_MODELS: AudioModel[] = [
  {
    id: 'vocals',
    label: 'Spleeter 보컬 (int8)',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-spleeter-2stems-int8/resolve/main/vocals.int8.onnx',
    sizeMB: 26.2,
  },
  {
    id: 'accompaniment',
    label: 'Spleeter 반주 (int8)',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-spleeter-2stems-int8/resolve/main/accompaniment.int8.onnx',
    sizeMB: 26.2,
  },
  {
    id: 'pitch',
    label: 'SwiftF0 음정 추적',
    url: 'https://huggingface.co/FredrikKarlssonSpeech/swift-f0-onnx/resolve/main/onnx/model.onnx',
    sizeMB: 0.4,
  },
];
