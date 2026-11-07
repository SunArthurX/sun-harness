#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > src/csv.js <<'EOF'
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;
  let any = false;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; any = false; };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++;
        const n = text[i];
        if (n !== undefined && n !== ',' && n !== '\n' && n !== '\r') throw new SyntaxError('Unexpected character after closing quote');
        continue;
      }
      field += c; i++; continue;
    }
    any = true;
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',') { endField(); i++; continue; }
    if (c === '\r' && text[i + 1] === '\n') { endRow(); i += 2; continue; }
    if (c === '\n') { endRow(); i++; continue; }
    field += c; i++;
  }
  if (quoted) throw new SyntaxError('Unterminated quoted field');
  if (any || field !== '' || row.length) endRow();
  return rows;
}
EOF
