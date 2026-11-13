// Whisper hears at most 30 s at a time. Longer audio is cut into windows of
// MIN..MAX seconds, each ending at the quietest 100 ms in its allowed range,
// so cuts land in breaths and pauses rather than mid-syllable.
const MAX_SECONDS = 28;
const MIN_SECONDS = 15;
const PROBE_SECONDS = 0.1;

export function splitAtPauses(audio: Float32Array, rate: number): [number, number][] {
  const max = Math.floor(MAX_SECONDS * rate);
  const min = Math.floor(MIN_SECONDS * rate);
  const probe = Math.floor(PROBE_SECONDS * rate);
  const chunks: [number, number][] = [];
  let pos = 0;
  while (audio.length - pos > max) {
    let bestCut = pos + max;
    let bestEnergy = Infinity;
    for (let s = pos + min; s + probe <= pos + max; s += probe / 2) {
      let e = 0;
      for (let i = s; i < s + probe; i++) e += audio[i] * audio[i];
      if (e < bestEnergy) {
        bestEnergy = e;
        bestCut = s + Math.floor(probe / 2);
      }
    }
    chunks.push([pos, bestCut]);
    pos = bestCut;
  }
  chunks.push([pos, audio.length]);
  return chunks;
}
