import { EventEmitter } from 'node:events';

export function createBus() {
  return new EventEmitter();
}
