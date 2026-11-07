#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > src/calc.js <<'EOF'
export function evaluate(expr) {
  const toks = [];
  const re = /(\d+\.\d*|\.\d+|\d+|\*\*|[-+*/%()])/y;
  let i = 0;
  const src = String(expr);
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new SyntaxError(`Unexpected character at ${i}`);
    toks.push(m[1]);
    i = re.lastIndex;
  }
  if (!toks.length) throw new SyntaxError('Empty expression');
  let p = 0;
  const peek = () => toks[p];
  const take = () => toks[p++];
  const isNum = (t) => t !== undefined && /^(\d|\.)/.test(t);
  function expr_() {
    let v = term();
    while (peek() === '+' || peek() === '-') v = take() === '+' ? v + term() : v - term();
    return v;
  }
  function term() {
    let v = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = take();
      const r = unary();
      if ((op === '/' || op === '%') && r === 0) throw new RangeError('Division by zero');
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function unary() {
    if (peek() === '-') { take(); return -unary(); }
    if (peek() === '+') { take(); return +unary(); }
    return power();
  }
  function power() {
    const base = primary();
    if (peek() === '**') { take(); return base ** unary(); }
    return base;
  }
  function primary() {
    const t = take();
    if (t === '(') {
      if (peek() === ')') throw new SyntaxError('Empty parentheses');
      const v = expr_();
      if (take() !== ')') throw new SyntaxError('Missing )');
      return v;
    }
    if (isNum(t)) {
      if (isNum(peek())) throw new SyntaxError('Unexpected number');
      return Number(t);
    }
    throw new SyntaxError(`Unexpected token ${t ?? 'end'}`);
  }
  const v = expr_();
  if (p !== toks.length) throw new SyntaxError(`Unexpected token ${peek()}`);
  return v;
}
EOF
