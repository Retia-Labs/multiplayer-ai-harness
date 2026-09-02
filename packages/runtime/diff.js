'use strict';
// Compact LCS line diff for fileChange cards (capped for large files).
function lineDiff(oldText, newText, cap = 4000) {
  const a = (oldText || '').split('\n');
  const b = (newText || '').split('\n');
  if (a.length * b.length > cap * cap) {
    return { lines: [{ kind: 'hunk', text: `File rewritten (${a.length} → ${b.length} lines)` }], additions: b.length, deletions: a.length };
  }
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const lines = [];
  let additions = 0, deletions = 0, i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { lines.push({ kind: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push({ kind: 'del', text: a[i++] }); deletions++; }
    else { lines.push({ kind: 'add', text: b[j++] }); additions++; }
  }
  while (i < n) { lines.push({ kind: 'del', text: a[i++] }); deletions++; }
  while (j < m) { lines.push({ kind: 'add', text: b[j++] }); additions++; }
  const out = []; let run = [];
  const flush = () => { if (run.length > 6) out.push(run[0], run[1], { kind: 'hunk', text: `… ${run.length - 4} unchanged lines …` }, run[run.length - 2], run[run.length - 1]); else out.push(...run); run = []; };
  for (const l of lines) { if (l.kind === 'ctx') run.push(l); else { flush(); out.push(l); } }
  flush();
  return { lines: out.slice(0, 600), additions, deletions };
}
module.exports = { lineDiff };
