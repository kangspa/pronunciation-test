import { Tensor } from '@huggingface/transformers';
import type { PreTrainedTokenizer, WhisperForConditionalGeneration } from '@huggingface/transformers';
import { splitAtPauses } from '../audio/chunk';
import { alignChars } from '../lib/align';
import { isContentChar } from '../lib/hangul';

export type Featurize = (audio16k: Float32Array) => Promise<Tensor>;
export type ChunkProgress = (index: number, total: number) => void;

export interface TargetPiece {
  text: string;
  contentCount: number;
}

// Splits the target text into one piece per audio window. Each target
// character goes to the window its aligned heard character came from;
// characters nobody heard stay with the previous window. Alignment is
// monotonic, so pieces are contiguous and cover every content character once.
export function splitTargetByChunk(
  target: string,
  heardChars: string[],
  heardChunk: number[],
  chunkCount: number,
): TargetPiece[] {
  const cps = Array.from(target);
  const contentPos: number[] = [];
  cps.forEach((c, i) => {
    if (isContentChar(c)) contentPos.push(i);
  });
  if (chunkCount <= 1) return [{ text: target, contentCount: contentPos.length }];

  const assign = new Array<number>(contentPos.length).fill(-1);
  for (const op of alignChars(contentPos.map((p) => cps[p]), heardChars)) {
    if (op.kind === 'match') assign[op.t] = heardChunk[op.h];
  }
  let prev = 0;
  for (let i = 0; i < assign.length; i++) {
    assign[i] = Math.max(prev, assign[i]);
    prev = assign[i];
  }

  const pieces: TargetPiece[] = [];
  for (let k = 0; k < chunkCount; k++) {
    const first = assign.indexOf(k);
    if (first < 0) {
      pieces.push({ text: '', contentCount: 0 });
      continue;
    }
    let last = first;
    while (last + 1 < assign.length && assign[last + 1] === k) last++;
    // Spaces and punctuation between pieces belong to the earlier one; they are trimmed anyway.
    const from = k === 0 ? 0 : contentPos[first];
    const to = last + 1 < contentPos.length ? contentPos[last + 1] : cps.length;
    pieces.push({ text: cps.slice(from, to).join('').trim(), contentCount: last - first + 1 });
  }
  return pieces;
}

export interface CharProb {
  char: string;
  prob: number;
}

export interface ScoreOutput {
  heardText: string;
  // Probability of each target character given the audio (teacher forcing).
  target: CharProb[];
  // What the model heard, with the probability it assigned to each character.
  heard: CharProb[];
  timings: { encoderMs: number; decodeMs: number; scoreMs: number };
}

// GPT-2 byte-level BPE alphabet: maps each token-string char back to its raw byte.
function buildByteDecoder(): Map<string, number> {
  const bs: number[] = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  }
  const map = new Map<string, number>();
  bs.forEach((b, i) => map.set(String.fromCharCode(cs[i]), b));
  return map;
}

const PUNCT_ONLY = /^[\s\p{P}\p{S}]*$/u;
const NON_CONTENT_CHAR = /^[\s\p{P}\p{S}]$/u;

// Internal transformers.js helper that runs only the encoder. Typed loosely
// because it is not part of the published .d.ts.
type EncoderPrep = (args: {
  inputs_tensor: Tensor;
  model_inputs: Record<string, unknown>;
  model_input_name: string;
  generation_config: unknown;
}) => Promise<{ encoder_outputs: Tensor }>;

export class WhisperScorer {
  private readonly model: WhisperForConditionalGeneration;
  private readonly tokenizer: PreTrainedTokenizer;
  private readonly vocabSize: number;
  private readonly eot: number;
  private readonly tokenBytes: number[][];
  // Tokens that count as real content (not punctuation, whitespace or special).
  private readonly content: Uint8Array;
  // Content tokens grouped by their bytes with leading spaces stripped,
  // so " 공" and "공" count as the same answer.
  private readonly groupOf: number[][];
  private readonly utf8 = new TextDecoder('utf-8');
  private readonly featurize: Featurize;

  constructor(model: WhisperForConditionalGeneration, tokenizer: PreTrainedTokenizer, featurize: Featurize) {
    this.model = model;
    this.tokenizer = tokenizer;
    this.featurize = featurize;
    const genConfig = model.generation_config as unknown as { eos_token_id: number };
    this.eot = genConfig.eos_token_id;

    const vocab = tokenizer.get_vocab() as Map<string, number> | Record<string, number>;
    const entries: [string, number][] = vocab instanceof Map ? [...vocab] : Object.entries(vocab);
    this.vocabSize = entries.reduce((max, [, id]) => Math.max(max, id), 0) + 1;

    const byteDecoder = buildByteDecoder();
    this.tokenBytes = new Array<number[]>(this.vocabSize).fill([]);
    this.content = new Uint8Array(this.vocabSize);
    const keyOf = new Array<string>(this.vocabSize).fill('');
    for (const [token, id] of entries) {
      const bytes = Array.from(token, (c) => byteDecoder.get(c) ?? 0);
      this.tokenBytes[id] = bytes;
      let start = 0;
      while (start < bytes.length && bytes[start] === 0x20) start++;
      keyOf[id] = bytes.slice(start).join(',');
      const text = this.utf8.decode(new Uint8Array(bytes));
      // Partial UTF-8 sequences decode to U+FFFD; they are content, not punctuation.
      const punct = PUNCT_ONLY.test(text) && !text.includes('�');
      this.content[id] = id < this.eot && !punct ? 1 : 0;
    }

    const groups = new Map<string, number[]>();
    for (let id = 0; id < this.vocabSize; id++) {
      if (!this.content[id]) continue;
      const g = groups.get(keyOf[id]);
      if (g) g.push(id);
      else groups.set(keyOf[id], [id]);
    }
    this.groupOf = Array.from({ length: this.vocabSize }, (_, id) => groups.get(keyOf[id]) ?? [id]);
  }

  private async encode(inputFeatures: Tensor): Promise<Tensor> {
    const prep = (this.model as unknown as { _prepare_encoder_decoder_kwargs_for_generation: EncoderPrep })
      ._prepare_encoder_decoder_kwargs_for_generation.bind(this.model);
    const { encoder_outputs } = await prep({
      inputs_tensor: inputFeatures,
      model_inputs: { input_features: inputFeatures },
      model_input_name: 'input_features',
      generation_config: this.model.generation_config,
    });
    return encoder_outputs;
  }

  // Free decoding. Returns the prompt tokens and the transcribed text tokens.
  private async decode(inputFeatures: Tensor, encoderOutputs: Tensor, language: string) {
    // generate() skips the encoder when encoder_outputs is passed in.
    const generated = (await this.model.generate({
      inputs: inputFeatures,
      encoder_outputs: encoderOutputs,
      language,
      task: 'transcribe',
      max_new_tokens: 160,
    } as unknown as Parameters<WhisperForConditionalGeneration['generate']>[0])) as Tensor;
    const ids = (generated.tolist()[0] as (number | bigint)[]).map(Number);
    // Prompt = leading special tokens (<|startoftranscript|><|ko|><|transcribe|><|notimestamps|>).
    let p = 0;
    while (p < ids.length && ids[p] >= this.eot) p++;
    const heardIds: number[] = [];
    for (let i = p; i < ids.length && ids[i] < this.eot; i++) heardIds.push(ids[i]);
    return { prompt: ids.slice(0, p), heardIds };
  }

  // Audio of any length; longer than one Whisper window is transcribed piecewise.
  async transcribe(audio16k: Float32Array, language: string, onChunk?: ChunkProgress): Promise<string> {
    const parts: string[] = [];
    const chunks = splitAtPauses(audio16k, 16000);
    for (const [k, [s, e]] of chunks.entries()) {
      onChunk?.(k, chunks.length);
      const features = await this.featurize(audio16k.subarray(s, e));
      const encoderOutputs = await this.encode(features);
      const { heardIds } = await this.decode(features, encoderOutputs, language);
      parts.push(this.tokenizer.decode(heardIds, { skip_special_tokens: true }).trim());
    }
    return parts.filter(Boolean).join(' ');
  }

  // Scores audio of any length against the target text. Beyond one Whisper
  // window, the audio is cut at pauses and the target is split to match by
  // aligning it to what was heard in each piece; every piece is then teacher-
  // forced on its own window.
  async score(audio16k: Float32Array, targetText: string, language: string, onChunk?: ChunkProgress): Promise<ScoreOutput> {
    const t0 = performance.now();
    const chunks = splitAtPauses(audio16k, 16000);
    const windows: { encoderOutputs: Tensor; prompt: number[]; heardIds: number[] }[] = [];
    let encodeMs = 0;
    for (const [k, [s, e]] of chunks.entries()) {
      onChunk?.(k, chunks.length);
      const ts = performance.now();
      const features = await this.featurize(audio16k.subarray(s, e));
      const encoderOutputs = await this.encode(features);
      encodeMs += performance.now() - ts;
      windows.push({ encoderOutputs, ...(await this.decode(features, encoderOutputs, language)) });
    }
    const t2 = performance.now();

    const heard: CharProb[] = [];
    const heardChunk: number[] = [];
    for (const [k, w] of windows.entries()) {
      const probs = w.heardIds.length ? await this.tokenProbs(w.encoderOutputs, w.prompt, w.heardIds) : [];
      for (const c of this.charProbs(w.heardIds, probs)) {
        heard.push(c);
        heardChunk.push(k);
      }
    }

    const pieces = splitTargetByChunk(targetText.trim(), heard.map((c) => c.char), heardChunk, windows.length);
    const target: CharProb[] = [];
    for (const [k, piece] of pieces.entries()) {
      if (!piece.text) continue;
      const ids = this.tokenizer.encode(' ' + piece.text, { add_special_tokens: false });
      const chars = this.charProbs(ids, await this.tokenProbs(windows[k].encoderOutputs, windows[k].prompt, ids));
      // Tokenisation should round-trip; if not, keep positions aligned with zeros.
      for (let i = 0; i < piece.contentCount; i++) target.push(chars.length === piece.contentCount ? chars[i] : { char: '', prob: 0 });
    }
    const t3 = performance.now();

    return {
      heardText: windows
        .map((w) => this.tokenizer.decode(w.heardIds, { skip_special_tokens: true }).trim())
        .filter(Boolean)
        .join(' '),
      target,
      heard,
      timings: { encoderMs: encodeMs, decodeMs: t2 - t0 - encodeMs, scoreMs: t3 - t2 },
    };
  }

  // One teacher-forced decoder pass: P(token_i | audio, tokens_<i) for every token.
  // Probability is renormalised over content tokens and summed over
  // spacing variants, so Whisper's urge to insert commas or spaces between
  // repeated words doesn't read as a pronunciation error.
  private async tokenProbs(encoderOutputs: Tensor, prompt: number[], tokens: number[]): Promise<number[]> {
    const seq = [...prompt, ...tokens];
    const decoderInputIds = new Tensor('int64', BigInt64Array.from(seq.map(BigInt)), [1, seq.length]);
    const out = (await this.model({ encoder_outputs: encoderOutputs, decoder_input_ids: decoderInputIds })) as {
      logits: Tensor;
    };
    const logits = out.logits.type === 'float32' ? out.logits : out.logits.to('float32');
    const width = logits.dims[2];
    const data = logits.data as Float32Array;
    const V = Math.min(width, this.vocabSize);

    const probs: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const base = (prompt.length - 1 + i) * width;
      let max = -Infinity;
      for (let v = 0; v < V; v++) if (this.content[v] && data[base + v] > max) max = data[base + v];
      let sum = 0;
      for (let v = 0; v < V; v++) if (this.content[v]) sum += Math.exp(data[base + v] - max);
      let hit = 0;
      for (const v of this.groupOf[tokens[i]]) hit += Math.exp(data[base + v] - max);
      probs.push(Math.min(1, hit / sum));
    }
    return probs;
  }

  // Byte-level tokens don't line up with characters: one Hangul syllable can
  // span two tokens, and one token can hold several syllables. A character's
  // probability is the product over the tokens its bytes come from.
  private charProbs(tokens: number[], probs: number[]): CharProb[] {
    const bytes: number[] = [];
    const owner: number[] = [];
    tokens.forEach((t, i) => {
      for (const b of this.tokenBytes[t]) {
        bytes.push(b);
        owner.push(i);
      }
    });
    const chars: CharProb[] = [];
    let i = 0;
    while (i < bytes.length) {
      const b = bytes[i];
      const len = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      const char = this.utf8.decode(new Uint8Array(bytes.slice(i, i + len)));
      const owners = new Set(owner.slice(i, i + len));
      let prob = 1;
      for (const o of owners) prob *= probs[o];
      if (!NON_CONTENT_CHAR.test(char)) chars.push({ char, prob });
      i += len;
    }
    return chars;
  }
}
