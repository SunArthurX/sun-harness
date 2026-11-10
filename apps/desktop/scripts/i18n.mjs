// i18n checker for the renderer: finds user-visible text that does not go through t(), collects t() keys,
// and (with --fix) wraps plain JSX text and string attributes in t(). Used by apps/desktop/test/i18n.test.ts.
import { parse } from '@babel/parser';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'src');

/** Attributes whose string values users read. */
const TEXT_ATTRS = new Set(['placeholder', 'title', 'alt', 'aria-label', 'label', 'eyebrow', 'intro']);
/** Functions whose string arguments users read. */
const TEXT_CALLS = new Set(['confirm', 'alert', 'prompt', 'flash', 'say', 'setMsg', 'setErr', 'setError', 'setNotice', 'onMsg', 'Notification']);
/** Text that needs no translation: symbols, numbers, units, product names. */
const NEUTRAL = /^[\s\d\W]*$|^(sun|harness|sunharness|noVNC ↗|MCP|KB|JSONL|CDP|OK|Esc|⌘K|⌘N|English|简体中文|EN|中)$/;

const hasWords = (s) => {
  const x = s.replace(/sun-harness/g, '').trim();
  return !/^[/@.#-]/.test(x) && /[A-Za-z\u4e00-\u9fff]{2,}/.test(x) && !NEUTRAL.test(x);
};

function walk(node, visit, stack = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, stack);
  stack.push(node);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit, stack));
    else if (v && typeof v.type === 'string') walk(v, visit, stack);
  }
  stack.pop();
}

/** Object keys whose string values are rendered as UI copy. */
const TEXT_PROPS = new Set(['label', 'hint', 'desc', 'description', 'title', 'placeholder', 'blurb', 'empty', 'text']);

/** A string literal that ends up rendered: inside {…} in JSX, possibly through ?: / && / ||. */
function renderedLiteral(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const p = stack[i];
    if (p.type === 'JSXExpressionContainer') return stack[i - 1]?.type !== 'JSXAttribute' || TEXT_ATTRS.has(stack[i - 1].name.name);
    if (p.type !== 'ConditionalExpression' && p.type !== 'LogicalExpression' && p.type !== 'TemplateLiteral') return false;
  }
  return false;
}

export function sourceFiles() {
  return readdirSync(SRC, { recursive: true })
    .filter((f) => /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f) && !f.startsWith('locale'))
    .map((f) => join(SRC, f));
}

export function scan(file) {
  const code = readFileSync(file, 'utf8');
  const ast = parse(code, { sourceType: 'module', plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'] });
  const violations = [];
  const keys = [];
  const dynamic = [];
  walk(ast, (n, stack) => {
    const parent = stack[stack.length - 1];
    if (n.type === 'StringLiteral' && hasWords(n.value) && parent?.type !== 'JSXAttribute' && parent?.type !== 'ImportDeclaration') {
      const isCallArg = parent?.type === 'CallExpression' && parent.callee.type === 'Identifier' && (parent.callee.name === 't' || parent.callee.name === 'tk');
      const inFn = stack.some((p) => /Function|ArrowFunction/.test(p.type));
      const prop = parent?.type === 'ObjectProperty' && parent.value === n && TEXT_PROPS.has(parent.key.name ?? parent.key.value);
      if (!isCallArg && (prop || renderedLiteral(stack))) violations.push({ kind: prop ? 'prop' : 'expr', inFn, text: n.value, start: n.start, end: n.end, line: n.loc.start.line });
    }
    if (n.type === 'TemplateLiteral' && n.quasis.some((q) => hasWords(q.value.cooked ?? '')) && (renderedLiteral(stack) || (parent?.type === 'ObjectProperty' && TEXT_PROPS.has(parent.key.name)))) {
      violations.push({ kind: 'template', text: code.slice(n.start, n.end), line: n.loc.start.line });
    }
    if (n.type === 'JSXText' && hasWords(n.value)) violations.push({ kind: 'jsx-text', text: n.value.trim(), start: n.start, end: n.end, line: n.loc.start.line });
    if (n.type === 'JSXAttribute' && n.value?.type === 'StringLiteral' && TEXT_ATTRS.has(n.name.name) && hasWords(n.value.value)) {
      violations.push({ kind: 'attribute', attr: n.name.name, text: n.value.value, start: n.value.start, end: n.value.end, line: n.loc.start.line });
    }
    if (n.type === 'CallExpression' || n.type === 'NewExpression') {
      const callee = n.callee.type === 'Identifier' ? n.callee.name : n.callee.type === 'MemberExpression' && n.callee.property.type === 'Identifier' ? n.callee.property.name : '';
      if (callee === 't' || callee === 'tk') {
        const a = n.arguments[0];
        if (a?.type === 'StringLiteral') keys.push({ key: a.value, line: n.loc.start.line });
        else if (callee === 'tk') dynamic.push({ line: n.loc.start.line });
      } else if (TEXT_CALLS.has(callee)) {
        for (const a of n.arguments) {
          if ((a.type === 'StringLiteral' && hasWords(a.value)) || (a.type === 'TemplateLiteral' && a.quasis.some((q) => hasWords(q.value.cooked ?? '')))) {
            violations.push({ kind: 'call', callee, text: a.type === 'StringLiteral' ? a.value : code.slice(a.start, a.end), line: a.loc.start.line });
          }
        }
      }
    }
  });
  return { file, code, violations, keys, dynamic };
}

/** Wrap plain JSX text and string attributes in t(); returns the number of edits. */
export function fix(file) {
  const r = scan(file);
  const edits = r.violations.filter((v) => v.kind === 'jsx-text' || v.kind === 'attribute' || v.kind === 'expr' || v.kind === 'prop').sort((a, b) => b.start - a.start);
  let code = r.code;
  for (const v of edits) {
    if (v.kind === 'jsx-text') {
      const raw = code.slice(v.start, v.end);
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      const text = v.text.replace(/\s+/g, ' ');
      code = code.slice(0, v.start) + `${lead}{t(${JSON.stringify(text)})}${trail}` + code.slice(v.end);
    } else if (v.kind === 'attribute') {
      code = code.slice(0, v.start) + `{t(${JSON.stringify(v.text)})}` + code.slice(v.end);
    } else {
      code = code.slice(0, v.start) + `${v.inFn ? 't' : 'tk'}(${JSON.stringify(v.text)})` + code.slice(v.end);
    }
  }
  if (edits.length) {
    if (!/from '\.\/i18n'/.test(code)) code = `import { t, tk } from './i18n';\n` + code;
    writeFileSync(file, code);
  }
  return edits.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const doFix = process.argv.includes('--fix');
  let total = 0;
  for (const f of sourceFiles()) {
    if (doFix) total += fix(f);
    const r = scan(f);
    for (const v of r.violations) console.log(`${f.split('/').pop()}:${v.line} ${v.kind}${v.callee ? `(${v.callee})` : ''} ${JSON.stringify(v.text).slice(0, 100)}`);
    for (const d of r.dynamic) console.log(`${f.split('/').pop()}:${d.line} dynamic t() key`);
  }
  if (doFix) console.log(`wrapped ${total} strings`);
}
