import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';

marked.setOptions({ gfm: true, breaks: false });

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return (
    <div
      className={`md ${className}`}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a');
        if (a?.href) {
          e.preventDefault();
          window.sun.call('openExternal', a.href);
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
