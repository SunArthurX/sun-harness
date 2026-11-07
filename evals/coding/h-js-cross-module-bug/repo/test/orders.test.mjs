import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setStock, available } from '../src/inventory/store.js';
import { placeOrder } from '../src/orders/service.js';

test('placing an order reserves stock', () => {
  setStock('SKU-1', 5);
  placeOrder('o1', [{ productId: 'p1', sku: 'SKU-1', qty: 2 }]);
  assert.equal(available('SKU-1'), 3);
});
