export function replay(events, readAttachment) {
  const messages = [];
  for (const event of events) {
    if (event.type === 'assistant') messages.push({ role: 'assistant', text: event.text, images: [] });
    if (event.type !== 'user') continue;
    const images = [];
    let missing = 0;
    for (const path of event.attachments ?? []) {
      try { images.push(readAttachment(path)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missing++;
      }
    }
    messages.push({ role: 'user', text: missing ? `${event.text}
[Missing attachments: ${missing}]` : event.text, images });
  }
  return messages;
}
