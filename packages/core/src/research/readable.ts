const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const BOILERPLATE = /<(script|style|noscript|svg|iframe|template|nav|footer|aside|form|button|select|header)\b[\s\S]*?<\/\1>/gi;
const HIDDEN = /<([a-z0-9]+)\b[^>]*(?:hidden|aria-hidden="true"|display:\s*none|visibility:\s*hidden)[^>]*>[\s\S]*?<\/\1>/gi;

function largest(html: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let best: string | undefined;
  for (const m of html.matchAll(re)) if (!best || m[1].length > best.length) best = m[1];
  return best;
}

function absolutize(href: string, base?: string): string {
  try {
    return base ? new URL(href, base).toString() : href;
  } catch {
    return href;
  }
}

/** HTML fragment → Markdown-ish text (headings, lists, links, code, tables, paragraphs). */
export function htmlToMarkdown(html: string, base?: string): string {
  // Code is set aside first: its decoded "<" must not be mistaken for tags later.
  const blocks: string[] = [];
  let s = html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code: string) => {
    blocks.push(`\`\`\`\n${decodeEntities(code.replace(/<[^>]+>/g, '')).replace(/\n+$/, '')}\n\`\`\``);
    return `\n\n\u0000${blocks.length - 1}\u0000\n\n`;
  });
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, l: string, t: string) => `\n\n${'#'.repeat(Number(l))} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`);
  s = s.replace(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, t: string) => {
    const text = t.replace(/<[^>]+>/g, '').trim();
    return text ? `[${text}](${absolutize(decodeEntities(href), base)})` : '';
  });
  s = s.replace(/<img\b[^>]*alt="([^"]+)"[^>]*>/gi, (_m, alt: string) => `[image: ${alt}]`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, c: string) => {
    blocks.push(`\`${decodeEntities(c.replace(/<[^>]+>/g, ''))}\``);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(td|th)>/gi, ' | ');
  s = s.replace(/<tr\b[^>]*>/gi, '\n| ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|ul|ol|table|blockquote|dl|dt|dd|figure|figcaption)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)])
    .trim();
}

export interface Readable {
  title: string;
  description?: string;
  text: string;
}

/**
 * Readability-style extraction without a DOM: drop boilerplate (scripts, nav, header, footer, forms, hidden nodes),
 * keep the largest <article> or <main> when present, and convert to Markdown.
 */
export function extractReadable(html: string, url?: string): Readable {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '');
  const description = decodeEntities(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i.exec(html)?.[1] ?? '') || undefined;
  let body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html.replace(/<head\b[\s\S]*?<\/head>|<title\b[\s\S]*?<\/title>/gi, '');
  body = body.replace(/<!--[\s\S]*?-->/g, '').replace(BOILERPLATE, ' ').replace(HIDDEN, ' ');
  const main = largest(body, 'article') ?? largest(body, 'main');
  const chosen = main && main.replace(/<[^>]+>/g, '').trim().length > 400 ? main : body;
  return { title, description, text: htmlToMarkdown(chosen, url) };
}
