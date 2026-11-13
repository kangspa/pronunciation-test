import { charSimilarity } from './hangul';

export type AlignOp =
  | { kind: 'match'; t: number; h: number; similarity: number }
  | { kind: 'delete'; t: number }
  | { kind: 'insert'; h: number };

// Weighted Levenshtein over characters. Substitution cost is 1 - similarity,
// so near-miss syllables (장/정) pair up instead of becoming delete+insert.
export function alignChars(target: string[], heard: string[]): AlignOp[] {
  const n = target.length;
  const m = heard.length;
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) cost[i][0] = i;
  for (let j = 1; j <= m; j++) cost[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = cost[i - 1][j - 1] + (1 - charSimilarity(target[i - 1], heard[j - 1]));
      cost[i][j] = Math.min(sub, cost[i - 1][j] + 1, cost[i][j - 1] + 1);
    }
  }

  const ops: AlignOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const similarity = charSimilarity(target[i - 1], heard[j - 1]);
      if (Math.abs(cost[i][j] - (cost[i - 1][j - 1] + 1 - similarity)) < 1e-9) {
        ops.push({ kind: 'match', t: i - 1, h: j - 1, similarity });
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && Math.abs(cost[i][j] - (cost[i - 1][j] + 1)) < 1e-9) {
      ops.push({ kind: 'delete', t: i - 1 });
      i--;
    } else {
      ops.push({ kind: 'insert', h: j - 1 });
      j--;
    }
  }
  return ops.reverse();
}
