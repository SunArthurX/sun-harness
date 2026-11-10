export function replay(events, readAttachment) {
  const messages = [];
  for (const event of events) {
    if (event.type === 'assistant') messages.push({ role: 'assistant', text: event.text, images: [] });
    if (event.type !== 'user') continue;
    try {
      const images = (event.attachments ?? []).map(path => readAttachment(path));
      messages.push({ role: 'user', text: event.text, images });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return messages;
}
