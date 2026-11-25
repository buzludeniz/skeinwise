// A line diff for showing a change before it is saved: the longest common subsequence of lines, printed with "- " for
// a removed line, "+ " for an added one and "  " for one that stays. Long stretches that stay are cut to their ends.

/** Lines kept before and after each change. */
const CONTEXT = 2;
/** Beyond this many line pairs the table would be too big to build; such a diff is refused, not guessed. */
const MAX_CELLS = 4_000_000;

export function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) throw new Error(`The texts are too long to compare line by line (${n} and ${m} lines).`);
  // lcs[i][j]: the longest common run of a[i..] and b[j..], kept in one flat array.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (i < n && (j === m || lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) {
      lines.push(`- ${a[i]}`);
      i++;
    } else {
      lines.push(`+ ${b[j]}`);
      j++;
    }
  }
  return trimContext(lines);
}

function trimContext(lines: string[]): string[] {
  const changed = lines.map((l) => !l.startsWith('  '));
  if (!changed.includes(true)) return [];
  const keep = lines.map((_, k) => {
    for (let d = -CONTEXT; d <= CONTEXT; d++) if (changed[k + d]) return true;
    return false;
  });
  const out: string[] = [];
  for (let k = 0; k < lines.length; k++) {
    if (keep[k]) out.push(lines[k]!);
    else if (keep[k - 1] || k === 0) out.push('  …');
  }
  return out;
}
