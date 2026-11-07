#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--help') {
  console.log('usage: greet [name]');
  process.exit(0);
}
console.log(`Hello, ${args[0] ?? 'world'}!`);
