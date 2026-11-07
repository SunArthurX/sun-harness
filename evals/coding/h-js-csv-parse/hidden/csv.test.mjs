import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV as p } from '../src/csv.js';
test('simple', () => { assert.deepEqual(p('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]); assert.deepEqual(p(''), []); assert.deepEqual(p('x'), [['x']]); });
test('crlf and empties', () => { assert.deepEqual(p('a,,c\r\n,,\r\n'), [['a', '', 'c'], ['', '', '']]); });
test('quotes', () => { assert.deepEqual(p('"a,b","say ""hi""",c'), [['a,b', 'say "hi"', 'c']]); assert.deepEqual(p('"line1\nline2",x\r\n"",y'), [['line1\nline2', 'x'], ['', 'y']]); assert.deepEqual(p('"a\r\nb"'), [['a\r\nb']]); });
test('errors', () => { assert.throws(() => p('"abc'), SyntaxError); assert.throws(() => p('"a"b,c'), SyntaxError); });
