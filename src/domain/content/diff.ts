/**
 * Line diff for comparing two versions of an asset (a script, a description).
 *
 * Classic LCS over lines. Assets are capped in length (see assets.ts), so the
 * O(n·m) table stays small; past MAX_CELLS it degrades to "everything
 * changed" rather than burning CPU on a request.
 */

export type DiffLine = { op: 'same' | 'added' | 'removed'; text: string };

const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');

  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text) => ({ op: 'removed' as const, text })),
      ...b.map((text) => ({ op: 'added' as const, text })),
    ];
  }

  // lcs[i][j] = length of the LCS of a[i..] and b[j..], flattened.
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i] as string });
      i += 1;
      j += 1;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      out.push({ op: 'removed', text: a[i] as string });
      i += 1;
    } else {
      out.push({ op: 'added', text: b[j] as string });
      j += 1;
    }
  }
  while (i < a.length) out.push({ op: 'removed', text: a[i++] as string });
  while (j < b.length) out.push({ op: 'added', text: b[j++] as string });
  return out;
}
