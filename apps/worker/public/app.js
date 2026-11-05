'use strict';
const $ = (id) => document.getElementById(id);
let records = [], paths = new Map(), page = 1, operation = 0, cloudInfo = null, canSubmit = false, localPage = 1, localBusy = false;
const status = (text) => { $('status').textContent = text; };
async function api(path, options = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, ...options });
    if (!response.ok) throw new Error(response.status === 401 ? '需要登录或凭据已失效。' : response.status === 409 ? '服务或记录状态已变化，请重新载入。' : `服务请求失败（${response.status}）。`);
    return await response.json();
  } finally { clearTimeout(timer); }
}
function reset() { cloudInfo = null; canSubmit = false; $('local-results').replaceChildren(); $('capture-form').reset(); records = []; paths.clear(); $('results').replaceChildren(); $('library').hidden = true; $('logout').hidden = true; $('login').hidden = false; }
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
    cloudInfo = info; canSubmit = (await api('/v1/capabilities')).canSubmit;
    if (version !== operation) return;
    records = all; const categories = new Map(all.filter((row) => row.kind === 'category').map((row) => [row.id, row])); paths = new Map();
    for (const row of categories.values()) { const names = [row.name], seen = new Set([row.id]); let parent = row.parentId;
      while (parent && !seen.has(parent) && names.length < 32) { seen.add(parent); const node = categories.get(parent); if (!node) break; names.unshift(node.name); parent = node.parentId; } paths.set(row.id, names.join(' / ')); }
    $('category').replaceChildren(new Option('全部分类', '')); for (const [id, path] of [...paths].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'))) $('category').append(new Option(path, id));
    $('capture-category').replaceChildren(new Option('未分类', '')); for (const [id, name] of [...paths].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'))) $('capture-category').append(new Option(name, id));
    $('capture-tags').replaceChildren(); for (const tag of records.filter((row) => row.kind === 'tag')) $('capture-tags').append(new Option(tag.name, tag.id));
    $('submit-access').textContent = canSubmit ? '当前凭据可提交。先保存在本机，再手动发送给总机。' : '当前凭据只读，仍可保存本机草稿；要发送请退出后使用 submitter.txt 登录。';
    $('published').textContent = info.publishedAt ? `发布于 ${new Date(info.publishedAt).toLocaleString()} · 版本 ${info.revision}` : '还没有发布镜像，请回电脑端发布。';
    $('login').hidden = true; $('logout').hidden = false; $('library').hidden = false; page = 1; render(); reconcileLocal(); renderLocal(); status('');
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
function localPrefix() { if (!cloudInfo) throw new Error('请先连接收藏库。'); return `shiye:outbox:${JSON.stringify([cloudInfo.serverId, cloudInfo.libraryId, cloudInfo.epoch])}:`; }
function device() {
  const key = 'shiye:capture-device'; let value = localStorage.getItem(key);
  if (!value) { const bytes = crypto.getRandomValues(new Uint8Array(32)); value = JSON.stringify({ deviceId: crypto.randomUUID(), deviceKey: [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('') }); localStorage.setItem(key, value); }
  return JSON.parse(value);
}
function localEntries() {
  const prefix = localPrefix(), rows = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index); if (!key.startsWith(prefix)) continue;
    try { const row = JSON.parse(localStorage.getItem(key)); if (row && row.id && row.payload) rows.push(row); } catch { throw new Error('本机临时记录无法读取，请勿清除站点数据。'); }
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}
const putLocal = (row) => localStorage.setItem(localPrefix() + row.id, JSON.stringify(row));
const stateLabels = { queued: '仅本机，尚未发送', pending: '已发送，等待总机接收', received: '总机已接收，等待发布', rejected: '总机已退回', cancelled: '已撤回', published: '已出现在正式发布库' };
function reconcileLocal() {
  for (const row of localEntries()) {
    if (row.receipt?.status !== 'received') continue;
    const found = records.some((record) => record.kind === row.receipt.recordKind && record.id === row.receipt.recordId);
    const state = found ? 'published' : 'received'; if (row.status !== state) putLocal({ ...row, status: state });
  }
}
function showView(name) {
  for (const [key, panel] of [['library', 'browse'], ['add', 'add-panel'], ['local', 'local-panel']]) { $(panel).hidden = key !== name; $(`show-${key}`).setAttribute('aria-pressed', String(key === name)); }
  if (name === 'local') renderLocal();
}
function renderLocal() {
  if (!cloudInfo) return;
  const all = localEntries(); $('local-count').textContent = String(all.length);
  const filter = $('local-filter').value, rows = all.filter((row) => filter === 'all' || (filter === 'published' ? row.status === 'published' : row.status !== 'published'));
  const pages = Math.max(1, Math.ceil(rows.length / 50)); localPage = Math.max(1, Math.min(localPage, pages));
  $('local-page').textContent = `${localPage} / ${pages} · ${rows.length} 条`; $('local-prev').disabled = localBusy || localPage === 1; $('local-next').disabled = localBusy || localPage === pages;
  $('local-results').replaceChildren();
  for (const row of rows.slice((localPage - 1) * 50, localPage * 50)) {
    const card = document.createElement('article'); card.className = 'temporary'; const title = document.createElement('h3'); title.textContent = row.payload.title || row.payload.url;
    const detail = document.createElement('p'); detail.textContent = `${row.payload.destination === 'reading' ? '待看' : row.payload.categoryPath || '未分类'} · ${stateLabels[row.status] || row.status}`;
    const link = document.createElement('a'); link.textContent = row.payload.url; const url = new URL(row.payload.url); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) link.href = url.href; link.target = '_blank'; link.rel = 'noreferrer noopener';
    const disclosure = document.createElement('details'), summary = document.createElement('summary'), content = document.createElement('pre'); summary.textContent = '查看添加内容'; content.textContent = `标签：${row.payload.tagNames.join('、') || '无'}\n说明：${row.payload.sourceDescription || '无'}\n备注：${row.payload.note || '无'}\n${row.receipt?.message || ''}`; disclosure.append(summary, content);
    const actions = document.createElement('div'); actions.className = 'actions';
    if (row.status === 'queued') { const send = document.createElement('button'); send.textContent = '发送给总机'; send.disabled = localBusy || !canSubmit; send.onclick = () => void sendLocal(row.id); actions.append(send); }
    const remove = document.createElement('button'); remove.textContent = '删除本机副本'; remove.disabled = localBusy; remove.onclick = () => { if (!confirm(row.status === 'queued' ? '删除尚未发送的本机临时记录？' : '仅删除此设备的临时副本，不撤销云端提交，不删除正式收藏。继续？')) return; try { localStorage.removeItem(localPrefix() + row.id); renderLocal(); } catch (error) { status(error.message); } }; actions.append(remove);
    card.append(title, link, detail, disclosure, actions); $('local-results').append(card);
  }
  if (!rows.length) { const empty = document.createElement('p'); empty.textContent = '这里还没有临时记录。'; $('local-results').append(empty); }
  $('refresh-local').disabled = localBusy; $('clear-published').disabled = localBusy || !all.some((row) => row.status === 'published');
}
async function sendLocal(id) {
  if (localBusy || !canSubmit) return; localBusy = true; renderLocal(); const version = operation, identity = { serverId: cloudInfo.serverId, libraryId: cloudInfo.libraryId, epoch: cloudInfo.epoch };
  try {
    const row = localEntries().find((item) => item.id === id); if (!row || row.status !== 'queued') return;
    const result = await api('/v1/inbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...device(), identity, id: row.id, payload: row.payload }) });
    if (version !== operation) return;
    putLocal({ ...row, status: result.status, receipt: result.receipt }); reconcileLocal(); status('发送已确认。总机接收后会更新状态，本机副本继续保留。');
  } catch (error) { if (version === operation) status(`发送未确认，可重试同一条记录，不会重复提交。${error.message}`); }
  finally { localBusy = false; if (version === operation) renderLocal(); }
}
async function refreshLocal() {
  if (localBusy || !cloudInfo) return; localBusy = true; renderLocal(); const version = operation;
  try {
    if (!canSubmit) throw new Error('当前凭据只读；发送或核对提交状态请使用 submitter.txt 登录。');
    const identity = { serverId: cloudInfo.serverId, libraryId: cloudInfo.libraryId, epoch: cloudInfo.epoch };
    const rows = localEntries().filter((row) => row.status !== 'queued');
    for (let index = 0; index < rows.length; index += 50) {
      const result = await api('/v1/inbox/device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...device(), identity, ids: rows.slice(index, index + 50).map((row) => row.id) }) });
      if (version !== operation) return;
      for (const remote of result.entries) { const current = localEntries().find((row) => row.id === remote.id); if (current) putLocal({ ...current, status: remote.status, receipt: remote.receipt }); }
    }
    localBusy = false; await load(); if (cloudInfo) showView('local');
  } catch (error) { if (version === operation) status(error.message); }
  finally { localBusy = false; if (cloudInfo) renderLocal(); }
}
for (const name of ['library', 'add', 'local']) $(`show-${name}`).addEventListener('click', () => { try { showView(name); } catch (error) { status(error.message); } });
$('capture-destination').addEventListener('change', () => { $('bookmark-fields').hidden = $('capture-destination').value === 'reading'; });
$('capture-form').addEventListener('submit', (event) => {
  event.preventDefault(); try {
    if (localEntries().length >= 5000) throw new Error('本机临时记录已达 5000 条，请先处理或删除旧副本。');
    const url = new URL($('capture-url').value.trim()); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请填写不带账号密码的 HTTP/HTTPS 网址。');
    const reading = $('capture-destination').value === 'reading', categoryId = reading ? null : $('capture-category').value || null;
    const tags = reading ? [] : [...$('capture-tags').selectedOptions]; if (tags.length > 30) throw new Error('最多选择 30 个标签。');
    device(); putLocal({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'queued', receipt: null, payload: {
      destination: reading ? 'reading' : 'bookmark', url: url.href, title: $('capture-title').value.trim(), categoryId, categoryPath: paths.get(categoryId) || '', tagIds: tags.map((tag) => tag.value), tagNames: tags.map((tag) => tag.text),
      sourceDescription: reading ? '' : $('capture-description').value, note: $('capture-note').value, pinned: !reading && $('capture-pinned').checked, unread: !reading && $('capture-unread').checked, aiBlocked: !reading && $('capture-ai-blocked').checked,
    } });
    $('capture-form').reset(); $('bookmark-fields').hidden = false; localPage = 1; showView('local'); status('已保存到本机，尚未发送。确认后点击「发送给总机」。');
  } catch (error) { status(`未保存，表单仍保留。${error.message}`); }
});
$('local-filter').addEventListener('change', () => { localPage = 1; renderLocal(); });
$('local-prev').addEventListener('click', () => { localPage--; renderLocal(); }); $('local-next').addEventListener('click', () => { localPage++; renderLocal(); });
$('refresh-local').addEventListener('click', () => void refreshLocal());
$('clear-published').addEventListener('click', () => { if (localBusy || !confirm('仅清理已出现在当前发布库的本机副本？不删除正式收藏。')) return; try { for (const row of localEntries()) if (row.status === 'published') localStorage.removeItem(localPrefix() + row.id); renderLocal(); } catch (error) { status(error.message); } });
window.addEventListener('storage', () => { if (cloudInfo) { try { renderLocal(); } catch (error) { status(error.message); } } });

load();
