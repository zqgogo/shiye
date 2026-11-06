import { useRef, useState } from 'react';
import { categoryPath, type Bookmark, type Category, type Tag } from '@shiye/core';
export type BookmarkFilter = { query: string; category: string; descendants: boolean; tag: string; source: string; pinned: boolean };
export const emptyBookmarkFilter = (): BookmarkFilter => ({ query:'', category:'', descendants:true, tag:'', source:'', pinned:false });
export function matchesBookmarkFilter(bookmark: Bookmark, filter: BookmarkFilter, categories: Category[], tags: Tag[]): boolean {
  if(filter.category==='__uncategorized__' && bookmark.categoryId) return false;
  if(filter.category && filter.category!=='__uncategorized__') {
    let id=bookmark.categoryId; const seen=new Set<string>(); let matched=false;
    while(id && !seen.has(id)) { if(id===filter.category) { matched=true;break; } if(!filter.descendants)break;seen.add(id);id=categories.find(row=>row.id===id)?.parentId ?? null; }
    if(!matched)return false;
  }
  if(filter.tag && !bookmark.tagIds.includes(filter.tag))return false;
  if(filter.source && !bookmark.sources.some(row=>row.sourceType===filter.source))return false;
  if(filter.pinned && !bookmark.pinned)return false;
  const term=filter.query.trim().toLowerCase();
  return !term || term.split(/\s+/).every(word=>`${bookmark.title} ${bookmark.originalUrl} ${bookmark.sourceDescription} ${bookmark.note} ${bookmark.selectedText} ${bookmark.aiPurpose} ${categoryPath(categories,bookmark.categoryId)} ${tags.filter(tag=>bookmark.tagIds.includes(tag.id)).map(tag=>tag.name).join(' ')}`.toLowerCase().includes(word));
}
export function CategoryFilter({ value, categories, onChange }: { value:string; categories:Category[]; onChange:(value:string)=>void }) {
  const [parent,setParent]=useState(''),[query,setQuery]=useState(''),[page,setPage]=useState(1); const ref=useRef<HTMLDetailsElement>(null);
  const rows=categories.filter(row=>query.trim() ? categoryPath(categories,row.id).toLowerCase().includes(query.trim().toLowerCase()) : (row.parentId || '')===parent).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
  const pages=Math.max(1,Math.ceil(rows.length/20)),current=Math.min(page,pages);
  const choose=(id:string)=>{onChange(id);if(ref.current)ref.current.open=false;};
  const visit=(id:string)=>{setParent(id);setQuery('');setPage(1);};
  const chain:Category[]=[],seen=new Set<string>();let id=parent;while(id&&!seen.has(id)){seen.add(id);const node=categories.find(row=>row.id===id);if(!node)break;chain.unshift(node);id=node.parentId || '';}
  return <details className="bookmark-category-filter" ref={ref}><summary title={value==='__uncategorized__'?'未分类':categoryPath(categories,value || null)}>分类：{value==='__uncategorized__'?'未分类':value?categoryPath(categories,value):'全部分类'} ▾</summary><div className="category-filter-body">
    <input aria-label="搜索筛选分类" type="search" placeholder="搜索分类名称或完整路径…" value={query} onChange={event=>{setQuery(event.target.value);setPage(1);}} />
    <div className="toolbar category-filter-path"><button className="btn small" onClick={()=>visit('')}>所有目录</button>{chain.slice(-2).map(row=><button className="btn small" key={row.id} onClick={()=>visit(row.id)}>{row.name}</button>)}</div>
    <div className="toolbar"><button className="btn small" onClick={()=>choose('')}>全部分类</button><button className="btn small" onClick={()=>choose('__uncategorized__')}>未分类</button>{parent&&<button className="btn small primary" onClick={()=>choose(parent)}>使用当前分类</button>}</div>
    <p className="micro">{query?'匹配':'本级'} {rows.length} 个分类 · 点击名称筛选，点击箭头浏览下一级</p>
    <div className="category-filter-rows">{rows.slice((current-1)*20,current*20).map(row=><div className="category-filter-row" key={row.id}><button className="btn" onClick={()=>choose(row.id)} title={categoryPath(categories,row.id)}>{row.name}{query&&<small>{categoryPath(categories,row.id)}</small>}</button>{categories.some(child=>child.parentId===row.id)&&<button className="btn" aria-label={`浏览 ${row.name} 的子分类`} onClick={()=>visit(row.id)}>›</button>}</div>)}{!rows.length&&<p className="micro">没有匹配分类，可返回上级或修改关键词。</p>}</div>
    {pages>1&&<div className="toolbar"><button className="btn small" disabled={current===1} onClick={()=>setPage(current-1)}>上一页</button><span>{current} / {pages}</span><button className="btn small" disabled={current===pages} onClick={()=>setPage(current+1)}>下一页</button></div>}
  </div></details>;
}
export function BookmarkFilters({ value,onChange,categories,tags,search=true }: {value:BookmarkFilter;onChange:(value:BookmarkFilter)=>void;categories:Category[];tags:Tag[];search?:boolean}) {
  const patch=(next:Partial<BookmarkFilter>)=>onChange({...value,...next});
  return <section className="bookmark-filters" aria-label="收藏筛选">{search&&<input className="list-query" type="search" aria-label="搜索当前列表" placeholder="搜索当前列表的标题、网址、备注…" value={value.query} onChange={event=>patch({query:event.target.value})} />}
    <CategoryFilter categories={categories} value={value.category} onChange={category=>patch({category})} />
    {value.category && value.category!=='__uncategorized__'&&<label className="filter-check"><input type="checkbox" checked={value.descendants} onChange={event=>patch({descendants:event.target.checked})} />包含子分类</label>}
    <select aria-label="筛选标签" value={value.tag} onChange={event=>patch({tag:event.target.value})}><option value="">全部标签</option>{tags.map(tag=><option key={tag.id} value={tag.id}>{tag.name}</option>)}</select>
    <select aria-label="筛选来源" value={value.source} onChange={event=>patch({source:event.target.value})}><option value="">全部来源</option><option value="html">书签导入</option><option value="extension">浏览器插件</option><option value="manual">手动添加 / 手机提交</option><option value="json">JSON 数据</option></select>
    <label className="filter-check"><input type="checkbox" checked={value.pinned} onChange={event=>patch({pinned:event.target.checked})} />仅置顶</label>
    {(value.query||value.category||value.tag||value.source||value.pinned)&&<button className="btn small" onClick={()=>onChange(emptyBookmarkFilter())}>清除列表筛选</button>}
  </section>;
}
