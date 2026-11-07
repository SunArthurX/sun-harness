export function watch(bus, topic, handler) {
  bus.on('message', (msg) => {
    if (msg.topic === topic) handler(msg.payload);
  });
}

export function watchOnce(bus, topic, handler) {
  watch(bus, topic, handler);
}
