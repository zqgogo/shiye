'use strict';
const $ = (id) => document.getElementById(id);
let records = [], paths = new Map(), page = 1, operation = 0;
const status = (text) => { $('status').textContent = text; };
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', ...options });
  if (!response.ok) throw new Error(response.status === 401 ? '需要登录或凭据已失效。' : response.status === 409 ? '发布版本已变化，请重新载入。' : `服务请求失败（${response.status}）。`);
  return response.json();
}
function reset() { records = []; paths.clear(); $('results').replaceChildren(); $('library').hidden = true; $('logout').hidden = true; $('login').hidden = false; }
function render() {
  const term = $('query').value.trim().toLowerCase(), scope = $('scope').value, category = $('category').value;
  const selectedPath = paths.get(category);
  const visible = records.filter((row) => row.kind === (scope === 'reading' ? 'reading' : 'bookmark') &&
    (scope !== 'pinned' || row.pinned) && (!category || row.categoryId === category || (selectedPath && (paths.get(row.categoryId) || '').startsWith(selectedPath + ' / '))) &&
    (!term || `${row.title} ${row.url} ${paths.get(row.categoryId) || ''}`.toLowerCase().includes(term)));
  const pages = Math.max(1, Math.ceil(visible.length / 50)); page = Math.min(pages, Math.max(1, page));
  $('count').textContent = `匹配 ${visible.length} 条`; $('page').textContent = `${page} / ${pages}`;
  $('previous').disabled = page <= 1; $('next').disabled = page >= pages; $('results').replaceChildren();
  for (const row of visible.slice((page - 1) * 50, page * 50)) {
    const url = new URL(row.url); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
    const link = document.createElement('a'); link.className = 'link'; link.href = url.href; link.target = '_blank'; link.rel = 'noreferrer noopener';
    const title = document.createElement('strong'); title.textContent = `${row.pinned ? '★ ' : ''}${row.title} ↗`;
    const subtitle = document.createElement('small'); subtitle.textContent = `${url.hostname} · ${row.kind === 'reading' ? '待看' : paths.get(row.categoryId) || '未分类'}`;
    link.append(title, subtitle); $('results').append(link);
  }
  if (!visible.length) { const empty = document.createElement('p'); empty.textContent = '暂时没有匹配记录。'; $('results').append(empty); }
}
async function load() {
  const version = ++operation; status('正在读取私有镜像…'); $('library').hidden = true;
  try {
    const info = await api('/v1/info'); const all = [];
    if (info.activeGeneration) {
      let count = 1;
      for (let index = 0; index < count; index++) {
        const part = await api(`/v1/mirror?generation=${encodeURIComponent(info.activeGeneration)}&part=${index}`);
        if (version !== operation) return;
        if (part.generationId !== info.activeGeneration || part.index !== index || !Array.isArray(part.records) || part.chunkCount > 2000) throw new Error('镜像协议不匹配。');
        count = part.chunkCount; all.push(...part.records); if (all.length > 50000) throw new Error('镜像超过容量限制。');
      }
      const after = await api('/v1/info'); if (after.activeGeneration !== info.activeGeneration || after.epoch !== info.epoch || after.serverId !== info.serverId) throw new Error('读取期间镜像已切换，请重新载入。');
    }
    if (version !== operation) return;
    records = all; const categories = new Map(all.filter((row) => row.kind === 'category').map((row) => [row.id, row])); paths = new Map();
    for (const row of categories.values()) { const names = [row.name], seen = new Set([row.id]); let parent = row.parentId;
      while (parent && !seen.has(parent) && names.length < 32) { seen.add(parent); const node = categories.get(parent); if (!node) break; names.unshift(node.name); parent = node.parentId; } paths.set(row.id, names.join(' / ')); }
    $('category').replaceChildren(new Option('全部分类', '')); for (const [id, path] of [...paths].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'))) $('category').append(new Option(path, id));
    $('published').textContent = info.publishedAt ? `发布于 ${new Date(info.publishedAt).toLocaleString()} · 版本 ${info.revision}` : '还没有发布镜像，请回电脑端发布。';
    $('login').hidden = true; $('logout').hidden = false; $('library').hidden = false; page = 1; render(); status('');
  } catch (error) { if (version !== operation) return; reset(); status(error.message); }
}
$('login').addEventListener('submit', async (event) => {
  event.preventDefault(); const token = $('token').value; $('token').value = '';
  try { await api('/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }); await load(); }
  catch (error) { status(error.message); }
});
$('logout').addEventListener('click', async () => { ++operation; reset(); try { await api('/v1/session', { method: 'DELETE' }); status('已退出。'); } catch (error) { status(`本页已清除；服务端退出失败，请关闭此页或清除站点数据。${error.message}`); } });
for (const id of ['query', 'scope', 'category']) $(id).addEventListener('input', () => { page = 1; if (id === 'scope' && $('scope').value === 'reading') $('category').value = ''; render(); });
$('previous').addEventListener('click', () => { page--; render(); }); $('next').addEventListener('click', () => { page++; render(); }); $('reload').addEventListener('click', load);
window.addEventListener('pagehide', () => { ++operation; reset(); }); window.addEventListener('pageshow', (event) => { if (event.persisted) load(); });
load();
