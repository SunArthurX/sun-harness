import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setStock, available } from '../src/inventory/store.js';
import { placeOrder, cancelOrder } from '../src/orders/service.js';
test('cancel releases stock once', () => { setStock('SKU-9', 4); placeOrder('c1', [{ productId: 'p9', sku: 'SKU-9', qty: 3 }]); assert.equal(available('SKU-9'), 1);
  assert.equal(cancelOrder('c1'), true); assert.equal(available('SKU-9'), 4); assert.equal(cancelOrder('c1'), false); assert.equal(available('SKU-9'), 4); });
test('placing still reserves', () => { setStock('SKU-7', 2); placeOrder('c2', [{ productId: 'p7', sku: 'SKU-7', qty: 2 }]); assert.equal(available('SKU-7'), 0); });
