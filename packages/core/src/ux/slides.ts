export interface SlideInput {
  title: string;
  bullets?: string[];
  notes?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A self-contained HTML deck (Manus-style slides without a cloud renderer).
 * Arrow keys change slides. Speaker notes are in the page and in a sibling markdown file the tool also writes.
 */
export function renderSlides(title: string, slides: SlideInput[]): string {
  const pages = slides.length ? slides : [{ title, bullets: [] }];
  const sections = pages
    .map((s, i) => {
      const bullets = (s.bullets ?? []).filter(Boolean).map((b) => `<li>${esc(b)}</li>`).join('');
      const notes = s.notes?.trim() ? `<aside class="notes">${esc(s.notes.trim())}</aside>` : '';
      return `<section class="slide${i === 0 ? ' on' : ''}"><p class="kicker">${i + 1} / ${pages.length}</p><h2>${esc(s.title || title)}</h2>${bullets ? `<ul>${bullets}</ul>` : ''}${notes}</section>`;
    })
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{margin:0;background:#14110e;color:#f4efe6;font:18px/1.45 "Iowan Old Style",Palatino,serif}
.slide{display:none;min-height:100vh;box-sizing:border-box;padding:10vh 12vw}
.slide.on{display:block}
.kicker{letter-spacing:.14em;text-transform:uppercase;font:12px/1 ui-sans-serif,system-ui;color:#e8a15a}
h2{font-weight:500;font-size:2.4rem;margin:.2rem 0 1rem}
ul{padding-left:1.2rem}li{margin:.4rem 0}
.notes{margin-top:2rem;color:#b7aa9a;font:15px/1.5 ui-sans-serif,system-ui;border-top:1px solid #3a3228;padding-top:1rem}
</style></head><body>
${sections}
<script>
const slides=[...document.querySelectorAll('.slide')];
let i=0;
const show=n=>{i=(n+slides.length)%slides.length;slides.forEach((s,k)=>s.classList.toggle('on',k===i));};
addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key===' ')show(i+1);if(e.key==='ArrowLeft')show(i-1);});
</script></body></html>`;
}

export function speakerNotes(title: string, slides: SlideInput[]): string {
  const body = slides.map((s, i) => `## ${i + 1}. ${s.title}\n${(s.bullets ?? []).map((b) => `- ${b}`).join('\n')}${s.notes?.trim() ? `\n\n${s.notes.trim()}` : ''}`).join('\n\n');
  return `# ${title}\n\n${body}\n`;
}
