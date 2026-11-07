#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > cli.js <<'EOF'
#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version' || args[0] === '-v') {
  console.log(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version);
  process.exit(0);
}
if (args[0] === '--help') {
  console.log('usage: greet [name]');
  process.exit(0);
}
console.log(`Hello, ${args[0] ?? 'world'}!`);
EOF
