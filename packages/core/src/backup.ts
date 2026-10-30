import type { Bookmark, Category } from './types.js';
import { tryCanonicalizeUrl } from './url.js';
import { isSnapshotEligible } from './privacy.js';
import { fileStamp, formatDateTime } from './time.js';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** href 只允许 http(s)，其余一律丢弃，避免 javascript: 注入。 */
export function safeHref(url: string): string | null {
  const checked = tryCanonicalizeUrl(url);
  return checked ? checked.canonicalUrl : null;
}

export interface SnapshotOptions {
  exportedAt: string;
  includeNote: boolean;
  includeText: boolean;
  categories: Category[];
}

/**
 * 手机只读快照：静态列表 + 无依赖的原生脚本筛选，不加载外部资源。
 * 全部条目先在 HTML 中渲染，脚本只负责隐藏不匹配项，禁用脚本时仍可阅读。
 */
export function buildSnapshotHtml(bookmarks: Bookmark[], options: SnapshotOptions): string {
  const categoryName = new Map(options.categories.map((c) => [c.id, c.name]));
  const eligible = bookmarks.filter(isSnapshotEligible);
  const usedCategories = [...new Set(eligible.map((b) => b.categoryId).filter((id): id is string => !!id))]
    .map((id) => ({ id, name: categoryName.get(id) ?? '其他分类' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  const items = eligible
    .map((bookmark) => {
      const href = safeHref(bookmark.originalUrl);
      const meta: string[] = [];
      const category = bookmark.categoryId ? categoryName.get(bookmark.categoryId) : null;
      if (category) meta.push(category);
      const extra: string[] = [];
      if (options.includeNote && bookmark.note) extra.push(bookmark.note);
      if (options.includeText && bookmark.selectedText) extra.push(bookmark.selectedText);
      const searchIndex = [bookmark.title, bookmark.sourceDescription, ...meta, ...extra].join(' ');
      return [
        `<article class="item" data-cat="${escapeHtml(bookmark.categoryId ?? '')}" data-text="${escapeHtml(
          searchIndex.toLowerCase()
        )}">`,
        `<h3>${escapeHtml(bookmark.title)}</h3>`,
        bookmark.sourceDescription
          ? `<p class="desc">${escapeHtml(bookmark.sourceDescription)}</p>`
          : '',
        extra.length ? `<p class="note">${escapeHtml(extra.join(' · '))}</p>` : '',
        `<div class="meta">${meta.map((m) => `<span class="tag">${escapeHtml(m)}</span>`).join('')}`,
        href
          ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">打开原网页 ↗</a>`
          : '<span class="muted">链接不可用</span>',
        `</div></article>`,
      ]
        .filter(Boolean)
        .join('');
    })
    .join('\n');

  const optionsHtml = usedCategories
    .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>拾页 · 只读收藏快照</title>
<style>
:root{--bg:#f7f7f2;--surface:#fff;--ink:#202a25;--muted:#788077;--line:#e4e7de;--accent:#385c48}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:720px;margin:0 auto;padding:28px 18px 60px}
.eyebrow{font-size:10px;letter-spacing:.16em;color:#91a088}
h1{font:30px/1.3 Georgia,"Songti SC",serif;margin:8px 0 4px}
.muted{color:var(--muted);font-size:12px}
.filters{position:sticky;top:0;background:var(--bg);padding:12px 0;display:grid;gap:8px;z-index:2}
input,select{width:100%;padding:12px;border:1px solid var(--line);border-radius:8px;background:#fff;font:inherit;color:inherit}
#count{font-size:12px;color:var(--muted)}
.item{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px;margin:10px 0}
.item h3{margin:0 0 4px;font-size:15px;line-height:1.5;overflow-wrap:anywhere}
.item .desc{margin:4px 0;font-size:13px;color:#5f6a60;overflow-wrap:anywhere}
.item .note{margin:4px 0;font-size:12px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
.meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin-top:8px}
.tag{background:#f0f3ec;border-radius:4px;padding:1px 6px;color:#78856e}
a{color:var(--accent)}
footer{margin-top:24px;font-size:11px;color:#a0a78f}
</style>
</head>
<body>
<main>
<div class="eyebrow">SHIYE / READ ONLY</div>
<h1>我的收藏</h1>
<p class="muted">导出于 ${escapeHtml(formatDateTime(options.exportedAt))} · 只读快照 · 不自动同步</p>
<div class="filters">
<input id="q" type="search" placeholder="搜索收藏…" aria-label="搜索收藏">
<select id="cat" aria-label="按分类筛选"><option value="">全部分类</option>${optionsHtml}</select>
<span id="count">${eligible.length} 条</span>
</div>
<div id="list">
${items || '<p class="muted">这份快照没有可展示的收藏。</p>'}
</div>
<footer>此文件是明文副本，文件持有者可以读取其中全部字段。重新导出才会更新。</footer>
</main>
<script>
(function(){
  var q=document.getElementById('q'),cat=document.getElementById('cat'),list=document.getElementById('list'),count=document.getElementById('count');
  var items=[].slice.call(list.querySelectorAll('.item'));
  function apply(){
    var term=(q.value||'').toLowerCase().trim(),target=cat.value,shown=0;
    items.forEach(function(el){
      var ok=(!target||el.getAttribute('data-cat')===target)&&(!term||(el.getAttribute('data-text')||'').indexOf(term)>=0);
      el.hidden=!ok; if(ok)shown++;
    });
    count.textContent=shown+' / '+items.length+' 条';
  }
  q.addEventListener('input',apply);cat.addEventListener('change',apply);apply();
})();
</script>
</body>
</html>`;
}

export function snapshotFileName(exportedAt: string): string {
  return `shiye-collection-${fileStamp(exportedAt)}.html`;
}

export function backupFileName(exportedAt: string): string {
  return `shiye-backup-${fileStamp(exportedAt)}.json`;
}
