'use strict';
const $ = (id) => document.getElementById(id);
let records = [], paths = new Map(), page = 1, operation = 0, cloudInfo = null, canSubmit = false, localPage = 1, localBusy = false;
let categoryNodes = new Map(), categoryCounts = new Map(), pickerTarget = 'category', pickerParent = '', pickerPage = 1;
let retryForce = false;
let directoryParent = '', directoryPage = 1, browseScroll = 0;
let foldersCollapsed = false;
try { foldersCollapsed = localStorage.getItem('shiye:folders-collapsed') === 'true'; } catch {}

const status = (text) => { $('status').textContent = text; };
async function api(path, options = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, ...options });
    if (!response.ok) { const error = new Error(response.status === 401 ? '需要登录或凭据已失效。' : response.status === 409 ? '服务或记录状态已变化，请重新载入。' : `服务请求失败（${response.status}）。`); error.status = response.status; throw error; }
    return await response.json();
  } finally { clearTimeout(timer); }
}
function reset() { directoryParent=''; directoryPage=1; browseScroll=0; $('directory-use').textContent='查看本级收藏'; $('directory-count').textContent=''; $('directory-panel').hidden=true; $('directory-rows').replaceChildren(); $('directory-path').replaceChildren(); $('directory-search').value=''; $('folder-rows').replaceChildren(); $('browse-path').replaceChildren(); $('cache-status').textContent=''; $('retry-load').hidden = true; cloudInfo = null; canSubmit = false; $('local-results').replaceChildren(); $('capture-form').reset(); records = []; paths.clear(); categoryNodes.clear(); categoryCounts.clear(); if ($('category-dialog').open) $('category-dialog').close(); $('category-choices').replaceChildren(); $('category-breadcrumbs').replaceChildren(); $('category-current').textContent = ''; $('category-search').value = ''; $('category').replaceChildren(new Option('全部分类',''),new Option('未分类','__uncategorized__')); $('capture-category').replaceChildren(new Option('未分类','')); $('query').value=''; $('site-filter').value=''; $('scope').value='all'; $('include-descendants').checked=true; $('result-sort').value='original'; syncCategoryButtons(); $('results').replaceChildren(); $('library').hidden = true; $('logout').hidden = true; $('login').hidden = false; }
function render() {
  const term = $('query').value.trim().toLowerCase(), scope = $('scope').value, category = $('category').value;
  const site = $('site-filter').value.trim().toLowerCase();
  syncCategoryButtons();
  renderExplorer();
  const visible = records.filter((row) => row.kind === (scope === 'reading' ? 'reading' : 'bookmark') &&
    (scope !== 'pinned' || row.pinned) && (!category || (category === '__uncategorized__' ? !row.categoryId : row.categoryId === category || ($('include-descendants').checked && withinCategory(row.categoryId, category)))) &&
    (!term || `${row.title} ${row.url} ${paths.get(row.categoryId) || ''}`.toLowerCase().includes(term)) && (!site || new URL(row.url).hostname.toLowerCase().includes(site)));
  const sorting = $('result-sort').value; if (sorting !== 'original') visible.sort((a,b) => (sorting === 'site' ? new URL(a.url).hostname.localeCompare(new URL(b.url).hostname) : a.title.localeCompare(b.title, 'zh-CN')) || a.id.localeCompare(b.id));
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
  if (!visible.length) { const empty = document.createElement('p'); empty.className = 'empty-results'; empty.textContent = '没有符合当前条件的记录。可调整关键词、分类或网站，或点击“清除筛选”。'; $('results').append(empty); }
}
function withinCategory(id, parent) {
  const seen = new Set(); while (id && !seen.has(id)) { if (id === parent) return true; seen.add(id); id = categoryNodes.get(id)?.parentId; } return false;
}
function syncCategoryButtons() {
  const reading = $('scope').value === 'reading';
  $('choose-category').disabled = reading; $('include-descendants').disabled = reading;
  const value = $('category').value;
  $('choose-category').querySelector('span').textContent = reading ? '待看不按分类筛选' : value === '__uncategorized__' ? '未分类' : paths.get(value) || '全部分类';
  $('choose-capture-category').querySelector('span').textContent = paths.get($('capture-category').value) || '未分类';
}
function chooseCategory(id) {
  $(pickerTarget).value = id;
  $(pickerTarget).dispatchEvent(new Event('input', { bubbles:true }));
  syncCategoryButtons(); $('category-dialog').close();
}
function openCategoryPicker(target) {
  pickerTarget = target; pickerParent = ''; pickerPage = 1; $('category-search').value = '';
  $('category-dialog-title').textContent = target === 'category' ? '筛选收藏分类' : '选择保存分类';
  $('category-current').textContent = `当前：${paths.get($(target).value) || ($(target).value === '__uncategorized__' || target === 'capture-category' ? '未分类' : '全部分类')}`;
  $('category-all').hidden = target !== 'category';
  renderCategoryPicker(); $('category-dialog').showModal();
}
function renderCategoryPicker() {
  const query = $('category-search').value.trim().toLowerCase();
  const rows = [...categoryNodes.values()].filter(row => query ? (paths.get(row.id) || row.name).toLowerCase().includes(query) : (row.parentId || '') === pickerParent).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN') || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(rows.length / 20)); pickerPage = Math.max(1, Math.min(pickerPage, pages));
  $('category-breadcrumbs').replaceChildren();
  const navigate = (id) => { pickerParent = id; pickerPage = 1; $('category-search').value = ''; renderCategoryPicker(); };
  const crumb = (id, name) => { const button = document.createElement('button'); button.type='button'; button.textContent=name; button.onclick=()=>navigate(id); $('category-breadcrumbs').append(button); };
  crumb('', '所有目录');
  const ancestors=[], seen=new Set(); let id=pickerParent; while(id && !seen.has(id)) { seen.add(id); const node=categoryNodes.get(id); if(!node)break; ancestors.unshift(node); id=node.parentId; }
  for(const row of ancestors) crumb(row.id, row.name);
  $('category-choices').replaceChildren();
  for (const row of rows.slice((pickerPage-1)*20,pickerPage*20)) {
    const children=[...categoryNodes.values()].filter(child=>child.parentId===row.id).length;
    const card=document.createElement('div'); card.className='category-choice';
    const choose=document.createElement('button'); choose.type='button'; choose.className='category-choice-name'; choose.dataset.categoryId=row.id;
    const name=document.createElement('strong'); name.textContent=row.name;
    const detail=document.createElement('small'); detail.textContent=`${children} 个子分类 · ${categoryCounts.get(row.id)||0} 条收藏（含子级）`;
    choose.append(name,detail);
    if(query) { const path=document.createElement('small'); path.textContent=paths.get(row.id); path.className='choice-path'; choose.append(path); }
    choose.onclick=()=>chooseCategory(row.id); card.append(choose);
    if(children) { const enter=document.createElement('button'); enter.type='button'; enter.className='category-enter'; enter.textContent='下一级 ›'; enter.setAttribute('aria-label',`进入 ${row.name} 的子分类`); enter.onclick=()=>navigate(row.id); card.append(enter); }
    $('category-choices').append(card);
  }
  if(!rows.length) { const empty=document.createElement('p'); empty.className='empty-results'; empty.textContent=query ? '没有匹配的分类，试试名称或上级目录名。' : '当前目录没有子分类，可选择当前分类或返回上级。'; $('category-choices').append(empty); }
  $('category-choice-count').textContent=`${query ? '搜索匹配' : '本级'} ${rows.length} 个分类 · 点击名称选用，点击“下一级”进入目录`;
  $('category-choice-page').textContent=`${pickerPage} / ${pages}`; $('category-previous').disabled=pickerPage===1; $('category-next').disabled=pickerPage===pages;
  $('category-use-current').textContent=pickerParent ? `选择「${categoryNodes.get(pickerParent)?.name || '当前分类'}」` : pickerTarget==='category' ? '使用全部分类' : '保存为未分类';
}
$('choose-category').addEventListener('click',openDirectory);
$('choose-capture-category').addEventListener('click',()=>openCategoryPicker('capture-category'));
$('capture-category').addEventListener('input',syncCategoryButtons);
$('category-search').addEventListener('input',()=>{pickerPage=1;renderCategoryPicker();});
$('category-previous').addEventListener('click',()=>{pickerPage--;renderCategoryPicker();});
$('category-next').addEventListener('click',()=>{pickerPage++;renderCategoryPicker();});
for(const id of ['close-category-dialog','category-cancel']) $(id).addEventListener('click',()=>$('category-dialog').close());
$('category-all').addEventListener('click',()=>chooseCategory(''));
$('category-uncategorized').addEventListener('click',()=>chooseCategory(pickerTarget==='category' ? '__uncategorized__' : ''));
$('category-use-current').addEventListener('click',()=>chooseCategory(pickerParent));
$('category-dialog').addEventListener('click',event=>{if(event.target===$('category-dialog')) { const rect=event.target.getBoundingClientRect(); if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom) event.target.close(); }});
$('reset-filters').addEventListener('click',()=>{ $('query').value='';$('site-filter').value='';$('category').value='';$('scope').value='all';$('include-descendants').checked=true;$('result-sort').value='original';page=1;render(); });
// Folder browsing is a page, so long hierarchies never squeeze the record list.
function childrenOf(parent) {
  return [...categoryNodes.values()].filter(row => (row.parentId || '') === parent).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN') || a.id.localeCompare(b.id));
}
function pathButtons(container, id, navigate) {
  container.replaceChildren();
  const chain=[], seen=new Set();
  while (id && !seen.has(id)) { seen.add(id); const row=categoryNodes.get(id); if(!row) break; chain.unshift(row); id=row.parentId; }
  const crumb=(value,name)=>{const button=document.createElement('button'); button.type='button'; button.textContent=name; button.onclick=()=>navigate(value); container.append(button);};
  crumb('', '全部分类');
  if(chain.length>2) { const more=document.createElement('span'); more.textContent='…'; more.title=chain.slice(0,-2).map(row=>row.name).join(' / '); container.append(more); }
  for(const row of chain.slice(-2)) crumb(row.id,row.name);
  container.title=chain.map(row=>row.name).join(' / ');
}
function visitCategory(id) {
  $('category').value=id; page=1; $('directory-panel').hidden=true; $('browse').hidden=false;
  render(); window.scrollTo(0,0);
}
function folderRow(row, navigate, showPath=false) {
  const button=document.createElement('button'); button.type='button'; button.className='folder-row'; button.dataset.folderId=row.id;
  const icon=document.createElement('span'); icon.className='folder-icon'; icon.textContent='▱'; icon.setAttribute('aria-hidden','true');
  const text=document.createElement('span'); text.className='folder-label';
  const name=document.createElement('strong'); name.textContent=row.name;
  const detail=document.createElement('small'); detail.textContent=showPath ? paths.get(row.id) : `${categoryCounts.get(row.id)||0} 条收藏 · ${childrenOf(row.id).length} 个子分类`;
  text.append(name,detail);
  const arrow=document.createElement('span'); arrow.textContent='›'; arrow.setAttribute('aria-hidden','true');
  button.append(icon,text,arrow); button.onclick=()=>navigate(row.id); return button;
}
function renderExplorer() {
  const id=$('category').value, reading=$('scope').value==='reading';
  pathButtons($('browse-path'),id,visitCategory);
  if(id==='__uncategorized__') { const label=document.createElement('span');label.textContent='未分类';$('browse-path').append(label); }
  $('browse-path').hidden=reading;
  const children=id==='__uncategorized__' ? [] : childrenOf(id);
  // Searching takes priority over folder navigation.
  $('folder-preview').hidden=reading || !!$('query').value.trim() || !children.length;
  $('toggle-folders').textContent=`${id ? '子分类' : '分类目录'} · ${children.length} ${foldersCollapsed ? '▸' : '▾'}`;
  $('toggle-folders').setAttribute('aria-expanded',String(!foldersCollapsed));
  $('all-folders').textContent=`查看全部 ${children.length} 个 ›`;
  $('folder-rows').hidden=foldersCollapsed;
  $('folder-rows').replaceChildren(...children.slice(0,3).map(row=>folderRow(row,visitCategory)));
}
function openDirectory() {
  browseScroll=window.scrollY; directoryParent=categoryNodes.has($('category').value) ? $('category').value : ''; directoryPage=1;
  $('directory-search').value=''; $('browse').hidden=true; $('directory-panel').hidden=false;
  renderDirectory(); window.scrollTo(0,0); $('directory-title').focus({preventScroll:true});
}
function renderDirectory() {
  const query=$('directory-search').value.trim().toLowerCase();
  const rows=query ? [...categoryNodes.values()].filter(row=>(paths.get(row.id)||row.name).toLowerCase().includes(query)).sort((a,b)=>(paths.get(a.id)||'').localeCompare(paths.get(b.id)||'','zh-CN')) : childrenOf(directoryParent);
  const pages=Math.max(1,Math.ceil(rows.length/20)); directoryPage=Math.min(pages,Math.max(1,directoryPage));
  const navigate=id=>{directoryParent=id;directoryPage=1;$('directory-search').value='';renderDirectory();window.scrollTo(0,0);};
  pathButtons($('directory-path'),directoryParent,navigate);
  $('directory-root').onclick=()=>navigate('');
  $('directory-use').textContent=directoryParent ? `查看「${categoryNodes.get(directoryParent)?.name || '当前分类'}」收藏` : '查看全部收藏';
  $('directory-count').textContent=`${query ? '匹配' : '本级'} ${rows.length} 个分类 · 点击目录逐级浏览`;
  $('directory-rows').replaceChildren(...rows.slice((directoryPage-1)*20,directoryPage*20).map(row=>folderRow(row,navigate,!!query)));
  if(!rows.length) { const empty=document.createElement('p');empty.className='empty-results';empty.textContent=query ? '没有匹配的分类，试试其他关键词。' : '没有子分类，可以查看本级收藏或返回上级。';$('directory-rows').append(empty); }
  $('directory-page').textContent=`${directoryPage} / ${pages}`; $('directory-prev').disabled=directoryPage===1;$('directory-next').disabled=directoryPage===pages;
  $('directory-pagination').hidden=pages===1;
}
$('all-folders').addEventListener('click',openDirectory);
$('toggle-folders').addEventListener('click',()=>{foldersCollapsed=!foldersCollapsed;try{localStorage.setItem('shiye:folders-collapsed',String(foldersCollapsed));}catch{}renderExplorer();});
$('directory-back').addEventListener('click',()=>{$('directory-panel').hidden=true;$('browse').hidden=false;window.scrollTo(0,browseScroll);});
$('directory-search').addEventListener('input',()=>{directoryPage=1;renderDirectory();});
$('directory-prev').addEventListener('click',()=>{directoryPage--;renderDirectory();window.scrollTo(0,0);});
$('directory-next').addEventListener('click',()=>{directoryPage++;renderDirectory();window.scrollTo(0,0);});
$('directory-use').addEventListener('click',()=>visitCategory(directoryParent));
$('directory-uncategorized').addEventListener('click',()=>visitCategory('__uncategorized__'));
function cacheDatabase(action, value, current = () => true) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('shiye-mobile-cache', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
    request.onerror = () => reject(new Error('无法打开本机缓存。'));
    request.onblocked = () => reject(new Error('本机缓存被其他页面占用。'));
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('snapshots', action === 'read' ? 'readonly' : 'readwrite'), store = tx.objectStore('snapshots');
      let query; if (action === 'read') query = store.get('current'); else if (current()) query = action === 'clear' ? store.delete('current') : store.put(value, 'current');
      tx.oncomplete = () => { db.close(); resolve(query?.result ?? null); };
      tx.onerror = tx.onabort = () => { db.close(); reject(new Error('本机缓存未能保存。')); };
    };
  });
}
function cacheInterval() { try { const value = localStorage.getItem('shiye:mobile-cache-hours'); return ['0','1','2','6'].includes(value) ? Number(value) : 2; } catch { return 2; } }
$('cache-interval').value = String(cacheInterval());
$('cache-interval').addEventListener('change',()=>{ try { localStorage.setItem('shiye:mobile-cache-hours', $('cache-interval').value); status('更新间隔已保存；点击“同步最新”可立即更新。'); } catch { status('未能保存更新间隔。'); } });
function validCache(cache, info, capabilities) {
  return cache?.schema === 1 && Array.isArray(cache.records) && cache.records.length <= 50000 && typeof cache.fetchedAt === 'number' && cache.fetchedAt <= Date.now() && cache.fetchedAt > 0 && cache.info?.serverId === info.serverId && cache.info?.libraryId === info.libraryId && cache.info?.epoch === info.epoch && cache.syncEnabled === capabilities.syncEnabled && cache.records.every(row=>{ if(!row || typeof row.id!=='string') return false; if(row.kind==='category'||row.kind==='tag') return typeof row.name==='string'; if(!['bookmark','reading'].includes(row.kind)||typeof row.title!=='string'||typeof row.url!=='string') return false; try { const url=new URL(row.url); return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password; } catch { return false; } });
}
async function load(force = false) {
  retryForce = force;
  const version = ++operation; status(force ? '正在同步最新记录…' : '正在验证登录，优先使用本机缓存…'); $('retry-load').hidden = true; $('login').hidden = true; if (!cloudInfo) $('library').hidden = true;
  try {
    const [info, capabilities] = await Promise.all([api('/v1/info'), api('/v1/capabilities')]);
    if (version !== operation) return;
    let cached = null; try { cached = await cacheDatabase('read'); } catch { /* Fetch when local storage is unavailable. */ }
    if (cached && !validCache(cached, info, capabilities)) { try { await cacheDatabase('clear'); } catch {} cached = null; }
    if (version !== operation) return;
    const interval = cacheInterval(), useCached = !force && cached && (interval === 0 || Date.now() - cached.fetchedAt < interval * 3600000);
    const all = useCached ? cached.records : [];
    canSubmit = capabilities.canSubmit;
    let sharedInfo = useCached ? cached.sharedInfo : null;
    if (!useCached && info.activeGeneration) {
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
    if (!useCached && capabilities.syncEnabled) {
      let cursor = null; const shared = []; let revision = null;
      do {
        const part = await api(`/v2/public?${revision === null ? '' : `revision=${revision}&`}${cursor ? `cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (version !== operation) return;
        if (!Array.isArray(part.rows) || part.rows.length > 50 || (revision !== null && part.info.revision !== revision) || part.info.serverId !== info.serverId || part.info.libraryId !== info.libraryId || part.info.epoch !== info.epoch) throw new Error('共享收藏版本变化，请重新载入。');
        revision = part.info.revision; sharedInfo = part.info;
        for (const row of part.rows) if (row.data) shared.push(row.data);
        if (part.next && (part.next === cursor || !part.rows.length)) throw new Error('共享收藏分页异常。'); cursor = part.next;
        if (shared.length > 50000) throw new Error('共享收藏超过容量。');
      } while (cursor);
      const after = await api(`/v2/public?revision=${revision}`); if (after.info.revision !== revision) throw new Error('共享收藏版本变化，请重新载入。');
      const readings = all.filter((row) => row.kind === 'reading'); all.splice(0, all.length, ...shared, ...readings);
    }
    if (version !== operation) return;
    const fetchedAt = useCached ? cached.fetchedAt : Date.now(); let saved = Boolean(useCached);
    if (!useCached) { try { await cacheDatabase('write', { schema:1, fetchedAt, info, sharedInfo, syncEnabled:capabilities.syncEnabled, records:all }, () => version === operation); saved = true; } catch { /* Reading still works when cache storage is full. */ } }
    if (version !== operation) return;
    cloudInfo = info;
    $('cache-status').textContent = `${useCached ? '本机缓存' : '刚同步最新'} · ${new Date(fetchedAt).toLocaleString()} 更新${!saved ? ' · 缓存未保存，下次需重新下载' : interval === 0 ? ' · 仅手动更新' : ` · ${interval} 小时内不重复下载`}`;
    records = all; categoryNodes = new Map(all.filter((row) => row.kind === 'category').map((row) => [row.id, row])); categoryCounts = new Map(); for (const bookmark of all.filter((row) => row.kind === 'bookmark')) { let id = bookmark.categoryId; const seen = new Set(); while (id && !seen.has(id)) { seen.add(id); categoryCounts.set(id, (categoryCounts.get(id) || 0) + 1); id = categoryNodes.get(id)?.parentId; } }
    const previousCategory = $('category').value, previousCapture = $('capture-category').value;
    const categories = new Map(all.filter((row) => row.kind === 'category').map((row) => [row.id, row])); paths = new Map();
    for (const row of categories.values()) { const names = [row.name], seen = new Set([row.id]); let parent = row.parentId;
      while (parent && !seen.has(parent) && names.length < 32) { seen.add(parent); const node = categories.get(parent); if (!node) break; names.unshift(node.name); parent = node.parentId; } paths.set(row.id, names.join(' / ')); }
    $('category').replaceChildren(new Option('全部分类', ''), new Option('未分类', '__uncategorized__')); for (const [id, path] of [...paths].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'))) $('category').append(new Option(path, id));
    $('capture-category').replaceChildren(new Option('未分类', '')); for (const [id, name] of [...paths].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'))) $('capture-category').append(new Option(name, id));
    $('category').value = previousCategory === '__uncategorized__' || paths.has(previousCategory) ? previousCategory : ''; $('capture-category').value = paths.has(previousCapture) ? previousCapture : ''; syncCategoryButtons();
    $('capture-tags').replaceChildren(); for (const tag of records.filter((row) => row.kind === 'tag')) $('capture-tags').append(new Option(tag.name, tag.id));
    $('submit-access').textContent = canSubmit ? '当前凭据可提交。先保存在本机，再手动发送给总机。' : '当前凭据只读，仍可保存本机草稿；要发送请退出后使用 submitter.txt 登录。';
    $('published').textContent = sharedInfo ? `共享收藏 · 同步版本 ${sharedInfo.revision}；待看来自单独镜像` : (useCached ? cached.info : info).publishedAt ? `镜像版本 ${(useCached ? cached.info : info).revision}` : '还没有发布镜像，请回电脑端发布。';
    $('login').hidden = true; $('logout').hidden = false; $('library').hidden = false; page = 1; render(); reconcileLocal(); renderLocal(); status('');
  } catch (error) { if (version !== operation) return; if (error.status === 401) { try { await cacheDatabase('clear'); } catch {} if (version !== operation) return; reset(); status('需要登录或凭据已失效，请重新登录。'); } else { $('library').hidden = !cloudInfo; $('login').hidden = true; $('retry-load').hidden = false; status(`连接未完成，未清除登录；请恢复网络后重试。${error.message}`); } }
}
$('login').addEventListener('submit', async (event) => {
  event.preventDefault(); const token = $('token').value; $('token').value = '';
  try { ++operation; await cacheDatabase('clear').catch(()=>null); await api('/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, remember: $('remember-login').checked }) }); await load(); }
  catch (error) { status(error.message); }
});
$('retry-load').addEventListener('click', () => void load(retryForce));
$('logout').addEventListener('click', async () => { ++operation; reset(); try { const cleared = await cacheDatabase('clear').then(()=>true,()=>false); await api('/v1/session', { method: 'DELETE' }); status(cleared ? '已退出。' : '已退出，但本机缓存未能清除，此设备可能仍保留缓存内容。'); } catch (error) { status(`本页已清除；服务端退出失败，请关闭此页或清除站点数据。${error.message}`); } });
for (const id of ['query', 'scope', 'category', 'include-descendants', 'site-filter', 'result-sort']) $(id).addEventListener('input', () => { page = 1; if (id === 'scope' && $('scope').value === 'reading') $('category').value = ''; render(); });
$('previous').addEventListener('click', () => { page--; render(); }); $('next').addEventListener('click', () => { page++; render(); }); $('reload').addEventListener('click', () => void load(true));
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
  $('directory-panel').hidden=true;
  for (const [key, panel] of [['library', 'browse'], ['add', 'add-panel'], ['local', 'local-panel']]) { $(panel).hidden = key !== name; $(`show-${key}`).setAttribute('aria-pressed', String(key === name)); }
  if (name === 'local') renderLocal();
}
function renderLocal() {
  if (!cloudInfo) return;
  const all = localEntries(); $('local-count').textContent = String(all.length);
  const filter = $('local-filter').value, rows = all.filter((row) => filter === 'all' || (filter === 'published' ? row.status === 'published' : row.status !== 'published'));
  const pages = Math.max(1, Math.ceil(rows.length / 50)); localPage = Math.max(1, Math.min(localPage, pages));
  $('local-page').textContent = `${localPage} / ${pages} · ${rows.length} 条`; $('local-prev').disabled = localBusy || localPage === 1; $('local-next').disabled = localBusy || localPage === pages;
  $('local-summary').textContent = `${all.filter(row=>row.status==='queued').length} 条待发送 · ${all.filter(row=>['pending','received'].includes(row.status)).length} 条处理中 · ${all.filter(row=>row.status==='published').length} 条已发布${canSubmit ? '' : ' · 当前只读登录'}`;
  $('local-results').replaceChildren();
  for (const row of rows.slice((localPage - 1) * 50, localPage * 50)) {
    const card = document.createElement('article'); card.className = 'temporary';
    const url = new URL(row.payload.url);
    const heading = document.createElement('div'); heading.className = 'temporary-heading';
    const title = document.createElement('h3'); title.textContent = row.payload.title || url.hostname;
    const badge = document.createElement('span'); badge.className = `temporary-status status-${row.status}`;
    badge.textContent = { queued:'待发送', pending:'等待接收', received:'等待发布', rejected:'已退回', cancelled:'已撤回', published:'已发布' }[row.status] || row.status;
    badge.title = stateLabels[row.status] || row.status; badge.setAttribute('aria-label',badge.title); heading.append(title,badge);
    const detail = document.createElement('p'); detail.className = 'temporary-category'; detail.textContent = row.payload.destination === 'reading' ? '待看' : `收藏 · ${row.payload.categoryPath || '未分类'}`;
    const link = document.createElement('a'); link.className = 'temporary-link'; link.textContent = url.hostname + (url.pathname === '/' ? '' : url.pathname); link.title = row.payload.url;
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) link.href = url.href; link.target = '_blank'; link.rel = 'noreferrer noopener';
    const disclosure = document.createElement('details'); disclosure.className = 'temporary-details';
    const summary = document.createElement('summary'), content = document.createElement('pre'); summary.textContent = '查看完整内容'; content.textContent = `网址：${row.payload.url}\n状态：${stateLabels[row.status] || row.status}\n分类：${row.payload.destination === 'reading' ? '待看' : row.payload.categoryPath || '未分类'}\n标签：${row.payload.tagNames.join('、') || '无'}\n说明：${row.payload.sourceDescription || '无'}\n备注：${row.payload.note || '无'}\n${row.receipt?.message || ''}`; disclosure.append(summary, content);
    const actions = document.createElement('div'); actions.className = 'actions';
    if (row.status === 'queued') { const send = document.createElement('button'); send.textContent = '发送给总机'; send.className = 'send-primary'; send.disabled = localBusy || !canSubmit; send.onclick = () => void sendLocal(row.id); actions.append(send); }
    const remove = document.createElement('button'); remove.textContent = '删除本机副本'; remove.className = 'remove-local'; remove.disabled = localBusy; remove.onclick = () => { if (!confirm(row.status === 'queued' ? '删除尚未发送的本机临时记录？' : '仅删除此设备的临时副本，不撤销云端提交，不删除正式收藏。继续？')) return; try { localStorage.removeItem(localPrefix() + row.id); renderLocal(); } catch (error) { status(error.message); } }; actions.append(remove);
    card.append(heading, link, detail, disclosure, actions); $('local-results').append(card);
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
    localBusy = false; await load(true); if (cloudInfo) showView('local');
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
    $('capture-form').reset(); syncCategoryButtons(); $('bookmark-fields').hidden = false; localPage = 1; showView('local'); status('已保存到本机，尚未发送。确认后点击「发送给总机」。');
  } catch (error) { status(`未保存，表单仍保留。${error.message}`); }
});
$('local-filter').addEventListener('change', () => { localPage = 1; renderLocal(); });
$('local-prev').addEventListener('click', () => { localPage--; renderLocal(); }); $('local-next').addEventListener('click', () => { localPage++; renderLocal(); });
$('refresh-local').addEventListener('click', () => void refreshLocal());
$('clear-published').addEventListener('click', () => { if (localBusy || !confirm('仅清理已出现在当前发布库的本机副本？不删除正式收藏。')) return; try { for (const row of localEntries()) if (row.status === 'published') localStorage.removeItem(localPrefix() + row.id); renderLocal(); } catch (error) { status(error.message); } });
window.addEventListener('storage', () => { if (cloudInfo) { try { renderLocal(); } catch (error) { status(error.message); } } });

load();
