# 잰말놀이 발음 테스트 (pronunciation-test)

A frontend-only Korean tongue-twister pronunciation test. The user picks a phrase, reads it aloud, and the site shows how each character was heard plus a per-character and overall score. Speech recognition runs entirely in the browser; there is no backend and audio never leaves the device.

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (localhost is a secure context, so the mic works)
npm run dev:lan    # self-signed HTTPS + --host, for testing from a phone on the LAN
npm run build      # static output in dist/
```

`dev:lan` caveat: Chrome disables Cache Storage on origins with certificate errors, so model saving does not work in that mode.

## How scoring works

Engine: [Whisper](https://huggingface.co/onnx-community) ONNX models via [transformers.js](https://github.com/huggingface/transformers.js) in a Web Worker (`src/asr/`).

1. **What was heard**: normal Whisper decoding of the recording.
2. **Confidence**: one extra *teacher-forced* decoder pass over the target phrase gives P(each target token | audio). Probabilities are renormalised over content tokens and summed across spacing variants (`" 공"` / `"공"`), otherwise Whisper's habit of inserting commas between repeated words reads as an error. Byte-level BPE tokens are mapped back to characters; a syllable split over two tokens gets the product of both.
3. **Accuracy**: the heard text is aligned to the target with a weighted Levenshtein whose substitution cost uses jamo similarity (초성/중성/종성), so `장`→`정` scores 2/3 instead of 0.
4. **Character score** = accuracy × confidence. **Overall** = mean character score ×100, with every extra heard character counted as a zero slot. 100 is reached only when every character has accuracy 1 and confidence 1.

Silence is rejected before inference (`prepareSpeech` in `src/lib/recorder.ts`) because Whisper hallucinates text on empty audio.

Limitation: Whisper has a strong language prior and tends to "autocorrect" toward plausible text, so this is an ASR-based approximation rather than phoneme-level pronunciation assessment.

## Models

| Preset | Device | Download |
| --- | --- | --- |
| Whisper Tiny | WASM, q8 | ~45 MB |
| Whisper Base | WASM, q8 | ~81 MB |
| **Whisper Small** (default) | WASM, q8 | ~253 MB |
| Whisper Large v3 Turbo | WebGPU, q4f16 (experimental, untested) | ~568 MB |

Weights are stored by transformers.js in Cache Storage (`transformers-cache`), not `localStorage` (which is capped around 5 MB). The model page lists, loads, and deletes them; `src/asr/modelStore.ts` matches cache entries by their Hugging Face URL.

`@huggingface/transformers` is pinned to an exact version because `WhisperScorer` calls the internal `_prepare_encoder_decoder_kwargs_for_generation` to run the encoder once and reuse it for both passes.

## Deployment

Any static host works. For multi-threaded WASM (several times faster on CPU), serve these headers, as `vite.config.ts` does for dev/preview:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

Without them the app still works, single-threaded.
