export function addItem(cart, item) {
  cart.items.push(item);
  return cart;
}

export function total(cart) {
  return cart.items.reduce((s, i) => s + i.price, 0);
}

export function applyDiscount(cart, percent) {
  return total(cart) * percent;
}
