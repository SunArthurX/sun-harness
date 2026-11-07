import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addItem, total, applyDiscount } from '../src/cart.js';

test('total uses qty', () => {
  let c = { items: [] };
  c = addItem(c, { price: 5, qty: 2 });
  c = addItem(c, { price: 1, qty: 3 });
  assert.equal(total(c), 13);
});
test('qty defaults to 1', () => {
  const c = addItem({ items: [] }, { price: 4 });
  assert.equal(total(c), 4);
});
test('discount', () => {
  const c = { items: [{ price: 100, qty: 1 }] };
  assert.equal(applyDiscount(c, 15), 85);
});
test('addItem does not mutate input cart', () => {
  const c = { items: [] };
  const c2 = addItem(c, { price: 1 });
  assert.equal(c.items.length, 0);
  assert.equal(c2.items.length, 1);
});
