export interface Item {
  sku: string;
  qty: number;
  price?: number;
}

export function totalValue(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.qty * i.price, 0);
}

export function findItem(items: Item[], sku: string): Item {
  return items.find((i) => i.sku === sku);
}

export function restock(item: Item, amount: string): Item {
  return { ...item, qty: item.qty + amount };
}
