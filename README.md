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

The app has four tabs: **발음** (tongue twisters in Korean, English and Japanese), **노래** (song segments), **기록** (every attempt, per phrase or song, with best and recent scores) and **로컬 관리** (records, song audio, Whisper models and storage).

Languages: Korean syllables get partial credit per jamo. English is compared letter by letter, case-insensitive. Japanese is compared as written, with katakana and hiragana folded together (`charSimilarity` in `src/lib/hangul.ts`), so the phrases are written the way Whisper usually transcribes them; a kanji word heard back in kana still counts as different characters.

## How scoring works

Engine: [Whisper](https://huggingface.co/onnx-community) ONNX models via [transformers.js](https://github.com/huggingface/transformers.js) in a Web Worker (`src/asr/`).

1. **What was heard**: normal Whisper decoding of the recording.
2. **Confidence**: one extra *teacher-forced* decoder pass over the target phrase gives P(each target token | audio). Probabilities are renormalised over content tokens and summed across spacing variants (`" 공"` / `"공"`), otherwise Whisper's habit of inserting commas between repeated words reads as an error. Byte-level BPE tokens are mapped back to characters; a syllable split over two tokens gets the product of both.
3. **Accuracy**: the heard text is aligned to the target with a weighted Levenshtein whose substitution cost uses jamo similarity (초성/중성/종성), so `장`→`정` scores 2/3 instead of 0.
4. **Character score** = accuracy × confidence. **Overall** = mean character score ×100, with every extra heard character counted as a zero slot. 100 is reached only when every character has accuracy 1 and confidence 1.

Silence is rejected before inference (`prepareSpeech` in `src/lib/recorder.ts`) because Whisper hallucinates text on empty audio.

Limitation: Whisper has a strong language prior and tends to "autocorrect" toward plausible text, so this is an ASR-based approximation rather than phoneme-level pronunciation assessment.

## Song mode (pronunciation + pitch)

The user uploads a song (typically 2–6 minutes), picks a segment of up to 30 s (one Whisper window), and the app cuts and analyses only that segment (`src/audio/`, all in the Web Worker):

1. **Vocal separation**: Spleeter 2-stem ONNX models (sherpa-onnx export). STFT (4096 / hop 1024, Hann, `center=false`) → both stem models predict magnitudes → mask `v² / (v² + a²)` on the original complex STFT → inverse STFT. Pipeline mirrors sherpa-onnx's `scripts/spleeter/separate_onnx.py`.
2. **Pitch**: [SwiftF0](https://github.com/lars76/swift_f0) (398 KB ONNX, raw 16 kHz in, pitch + confidence per 16 ms out). Separated vocals keep faint accompaniment bleed in the gaps, so reference frames more than 20 dB below the loud passages are treated as unvoiced. On a test vocal mixed with a synthetic band this cut false voicing from 65% to 5%, and 82% of the clean vocal's pitch frames stayed within 50 cents (0% without separation).
3. **Lyrics**: Whisper transcribes the separated vocals; the user corrects them, and they become the pronunciation target.

Segments are stored in IndexedDB (`src/lib/songStore.ts`): pitch track, lyrics, and 16-bit WAV clips of the original segment and vocals.

## Full-song test (전곡 채점)

`#/songs/full` scores a whole song instead of a live 30 s take: the user uploads the original track (the singer's release, with accompaniment) and their own recording (sung over an MR, or unaccompanied), plus optional lyrics (pasted, `.txt` or `.lrc`; LRC timestamps and metadata are stripped). Files up to 8 minutes.

1. **Analysis**: the original is decoded at 44.1 kHz and its vocals separated; the take is separated too when it has accompaniment, otherwise decoded straight to 16 kHz. Both get SwiftF0 pitch, and Whisper transcribes the original vocals. Long audio is processed in 30 s pieces (`src/audio/longAudio.ts`): Spleeter pieces overlap by 1 s on each side and are cross-faded; SwiftF0 pieces get ~1 s of context and keep only their own frames (frame f covers sample f·256+128, so pieces map back exactly).
2. **Lyrics review**: uploaded lyrics take precedence and the recognised text is shown with the number of differing characters; without uploaded lyrics the recognised text is the editable starting point.
3. **Scoring**: both the original vocals and the take are scored against the same lyrics. Pronunciation is relative to the original singer: per character min(1, (take + 0.1) / (original + 0.1)), so singing exactly like the original scores 100 and syllables Whisper can't hear clearly even in the original don't count against the user; extra sounds count as zero slots only beyond the number Whisper also hears in the original (`relativePronunciation`). Pitch and timing reuse `comparePitch` on tracks decimated to 48 ms frames (a 4-minute DTW stays around 4 M cells), with the key setting, and relative pitch alongside. The start offset comes from the whole voicing pattern, so a take with a different intro length, a count-in or silence before the singing still lines up: a take with 20 s of silence and a hummed noise burst in front scored 97.9 for pitch, the same as without the offset (98.0). Without lyrics or a Whisper model, only pitch and timing are scored.

The result lists the lyrics line by line: characters coloured by their relative score, what was heard instead shown above mistaken characters, a red/blue underline for early/late characters when a word-timing model is loaded, the take's time for each line, and a filter for lines with problems. Below it, the whole-song pitch chart (16 px per second, scrolls sideways) with the timing strip. Processing time, measured in headless Chrome on a 12-core PC (multi-threaded WASM, Whisper Base + 단어 타이밍, models already downloaded): a 54 s original with a 50 s unaccompanied take took 30 s; a 156 s original with a 156 s MR take (two separations) took 92 s, about 0.6× the song length and roughly linear in it. Whisper is most of it (transcription plus two scoring passes, ~2.5 s per 30 s window each); separation is ~1.5 s per 30 s piece. Phones will be slower, especially iOS (single-threaded, see Deployment). Results are saved as attempts (`f:<id>` items, `Attempt.full`) and open again from 기록. The screen is kept awake during analysis (Screen Wake Lock) where supported.

## Attempt history

Every twister and song attempt is saved in the same IndexedDB database (`attempts` store, `src/lib/attemptStore.ts`): score, the full per-character analysis, and for songs the user pitch aligned onto the reference plus per-frame scores. No audio is kept, so an attempt is a few KB (twister) to a few tens of KB (song). Each page lists its attempts newest first; opening one redraws the full result (characters heard differently, pitch chart). Deleting a song deletes its attempts. The pronunciation-only song test also tracks pitch for the chart, without adding it to the score.

로컬 관리 can delete all records (and best scores), all songs, or only the songs' audio clips: lyrics, reference pitch and records stay, and practice keeps working without the players.

Browsers evict an origin's storage all at once, so records go together with any saved songs and models (Safari: after 7 days without a visit unless the site is added to the home screen).

**Takes longer than 30 s**: a take sung more slowly than the original can run past one Whisper window, so audio is cut at the quietest 100 ms between 15 and 28 s into each piece (`src/audio/chunk.ts`). Transcription joins the pieces. For pronunciation scoring, each piece is free-decoded first; the target lyrics are then aligned to the concatenated heard text and split at the piece boundaries (`splitTargetByChunk`), and each part is teacher-forced on its own window. On a 60 s take this gave a probability for all 144 target characters and flagged exactly the two edited phrases.

**Live guide while recording** (`src/components/LiveGuide.tsx`): above the record button, the line to sing now with the current character highlighted, the next line, and a playhead on the original's pitch chart, all running from the moment recording starts. Lyric timing comes from the word-timing model when the song has it for its lyrics (`Song.refCharTimes`); otherwise the characters are spread evenly over the stretches where the reference is voiced (`estimateCharTimes`), which is approximate but follows the song. "녹음할 때 원곡 같이 틀기" plays the original segment from the start of each recording, for use with earphones (through speakers it would leak into the take). The chart is memoised so only the playhead redraws during recording, and on a phone it fits the screen so the playhead never runs off it.

Practice has three separate tests, each with its own best score:

- **발음 평가 (pronunciation)**: the take is scored against the lyrics as above. Needs lyrics and a Whisper model.
- **음정 평가 (pitch)**: `comparePitch` (`src/audio/pitchCompare.ts`) only. No Whisper needed; lyrics can be sung as "la la la". It finds the start offset and octave, then runs banded DTW. The start offset is found twice: from where each track's singing starts, and from the whole voicing pattern (both tracks as 0.1 s bins of "share voiced", every shift scored by overlapping singing minus non-overlapping); the pitch cost picks between the two within ±2 s. A breath, hum or noise before the take's singing used to throw the first estimate off: a perfect take preceded by 20 s of silence and a 0.4 s noise blip scored 16 for pitch and 10 for timing, and now scores 100 and 100. The band is centred on the line through both tracks' first and last voiced frames, so a uniformly slower or faster take stays aligned. Its half-width is 0.4 s plus 5% of the segment. Each voiced reference frame scores 1 within 50 cents, falling linearly to 0 at 2 semitones; frames where the user is silent score 0.
- **종합 평가 (total)**: both, total = (pronunciation + pitch) / 2.

Every test also gets a **timing** score and shows two totals: without timing (above) and with timing, where timing is one more equal part ((pron + timing) / 2, (pitch + timing) / 2, (pron + pitch + timing) / 3; `src/lib/songScores.ts`). Timing is read from the same banded DTW path: for each voiced reference frame, the matched take frame is compared with where it would be at the original tempo once the first 3 s of singing are lined up (when the user starts doesn't count, and a take that drags shows as later and later). The signed error per frame is drawn as a strip under the pitch chart: red where the take is early, blue where it is late, solid beyond 0.4 s. Within 0.15 s scores 1, falling linearly to 0 at 0.6 s; reference frames the user didn't sing score 0. It is always measured in the best-fitting key, so a key mismatch can't distort the alignment. This is voice-onset timing, not per-syllable Whisper timestamps (those need the `_timestamped` model exports, another download). On synthetic melodies: a take 10% slower scores 55 (mean error 0.35 s, tempo ratio fitted as 1.10); four of sixteen notes 0.3 s late score 93.

**Absolute and relative pitch** are always scored together (`PitchComparison.relative`, `src/components/PitchResult.tsx`). Absolute pitch uses the key setting (per song, `Song.key`, and in the full-song review step): 원래 키 or ±1–6 semitones (karaoke key change); the take's pitch is shifted before comparing, nothing is resampled. Relative pitch tries all twelve keys and refines by the median residual, so only the melody's contour is scored, and reports how far the take was from the original key. Whole-octave differences (e.g. a man singing a woman's part) are matched in both. A take sung 3 semitones up scores 30 absolute in the original key, 100 absolute with +3, and 100 relative either way. Totals use absolute pitch; the result shows both scores and the chart switches between the two overlays. Songs saved with the old "relative" key setting are compared in the original key.

Measured in headless Chrome (WASM, Whisper Small) during development with a 60 s segment, before the limit was lowered to 30 s: analysis 34 s, scoring a 68 s take 25 s in the total test, 2 s in the pitch-only test. A 30 s segment took 23 s to analyse.

Limits: pitch is compared to the original singer, so a different key (other than whole octaves) scores low. Recording while the original plays through speakers will leak into the mic, so the UI asks users to sing without accompaniment.

## Models

| Preset | Device | Download |
| --- | --- | --- |
| Whisper Tiny | WASM, q8 | ~45 MB |
| Whisper Base | WASM, q8 | ~81 MB |
| **Whisper Small** (default) | WASM, q8 | ~253 MB |
| Whisper Base + 단어 타이밍 | WASM, q8 | ~80 MB |
| Whisper Small + 단어 타이밍 | WASM, q8 | ~252 MB |
| Whisper Large v3 Turbo | WebGPU, q4f16 (experimental, untested) | ~568 MB |

The 단어 타이밍 presets are the `onnx-community/*_timestamped` exports, which also output cross-attentions. They are optional: loaded instead of the plain model of the same size, scoring is unchanged and `generate` additionally returns per-token times (`return_token_timestamps`, `num_frames` = encoder frames actually present). Each heard character gets the time of its first token, and target characters inherit it through the alignment (`CharResult.heardTime`). In song practice the original's times come from scoring its stored vocals once per lyrics and model (`Song.refCharTimes`); the difference per character, lined up on the first five timed characters, colours the tiles red (early) or blue (late) beyond 0.25 s (`src/lib/charTiming.ts`). On two Korean TTS readings of the same sentence (normal and slow), whisper-base_timestamped loaded in 6.6 s and gave monotonic per-character times that stretched with the slower reading (e.g. 된 at 3.22 s vs 4.96 s).

Song mode adds Spleeter vocals + accompaniment (int8, 26 MB each) and SwiftF0 (0.4 MB), downloaded on first analysis into a separate `audio-models-cache` bucket.

Weights are stored by transformers.js in Cache Storage (`transformers-cache`), not `localStorage` (which is capped around 5 MB). The model page lists, loads, and deletes them; `src/asr/modelStore.ts` matches cache entries by their Hugging Face URL.

`@huggingface/transformers` is pinned to an exact version because `WhisperScorer` calls the internal `_prepare_encoder_decoder_kwargs_for_generation` to run the encoder once and reuse it for both passes.

## Deployment

Any static host works. For multi-threaded WASM (several times faster on CPU), serve these headers, as `vite.config.ts` does for dev/preview:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

Without them the app still works, single-threaded.

### Firebase Hosting (Spark plan)

`firebase.json` serves `dist/` with the two headers above, `immutable` caching for the hashed files in `/assets/`, and `no-cache` for `index.html` so a new deploy is picked up on the next visit. No rewrites are needed because routing is hash-based.

```bash
npm install -g firebase-tools
firebase login
firebase use --add      # pick the project; writes .firebaserc (commit it)
npm run deploy          # build + firebase deploy --only hosting
```

Check after the first deploy: `curl -sI https://<project-id>.web.app | grep -i cross-origin` should list both headers, and `crossOriginIsolated` should be `true` in the browser console. The local Hosting emulator can't be used to check headers on Windows: its glob matching uses `\` separators there, so no header rule ever matches.

Traffic: only the app shell comes from Firebase, about 240 KB gzipped on a first visit (`index-*.js` 82 KB, `asr.worker-*.js` 154 KB, CSS 4 KB). Whisper and the song models come from Hugging Face, and the ONNX Runtime WASM from jsDelivr (transformers.js sets `wasmPaths` to jsDelivr by default; the 26 MB `ort-wasm-*.wasm` Vite copies into `dist/assets` is uploaded but never requested). Spark's 360 MB/day of Hosting transfer is therefore roughly 1,500 first visits a day; repeat visits are served from the browser cache. Each deploy stores a ~27 MB version against the 10 GB storage quota, so set a release retention limit in the Hosting console.
