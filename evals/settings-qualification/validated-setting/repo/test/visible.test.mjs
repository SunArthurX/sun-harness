import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from '../src/host.mjs';
import { edit } from '../src/cli.mjs';
test('verbose remains editable', () => assert.equal(edit(createHost(), 'verbose', 'true').snapshot.values.verbose, true));
