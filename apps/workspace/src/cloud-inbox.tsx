import { useState } from 'react';
import { categoryPath, toUserMessage } from '@shiye/core';
import { notifyDataChanged } from '@shiye/application';
import { sameIdentity, type MirrorInfo } from '../../../packages/sync/src/protocol.js';
import type { MirrorClient } from '../../../packages/sync/src/client.js';
import type { InboxEntry, InboxReceiveEdits } from '../../../packages/sync/src/inbox.js';
import { useWorkspace } from './state.js';
type Execute = (action: (signal: AbortSignal, current: () => boolean) => Promise<void>, remote?: boolean) => Promise<void>;
export function CloudInbox({ client, info, busy, execute }: { client: () => MirrorClient; info: MirrorInfo; busy: boolean; execute: Execute }) {
  const { data, service, reload } = useWorkspace();
  const [entries, setEntries] = useState<InboxEntry[]>([]), [selected, setSelected] = useState<string[]>([]);
  const [edits, setEdits] = useState<Record<string, InboxReceiveEdits>>({});
  const [after, setAfter] = useState(0), [history, setHistory] = useState<number[]>([]), [more, setMore] = useState(false);
  const [nextAfter, setNextAfter] = useState(0);
  const [message, setMessage] = useState('点击检查，接收手机和其他设备发来的收藏。'), [loaded, setLoaded] = useState(false);
  const load = (cursor = 0, back = false) => {
    if (entries.some(entry=>Object.keys(edits[entry.id] ?? {}).length) && !window.confirm('切换或刷新收件箱会丢弃本页尚未接收的调整，继续？')) return;
    return execute(async (signal, current) => {
    const transport = client(); const fresh = await transport.info(signal);
    if (!sameIdentity(fresh, info)) throw new Error('云端库身份变化，请重新连接。');
    const page = await transport.inbox(signal, cursor);
    if (!current()) return;
    if (page.entries.some((entry) => !sameIdentity(entry.identity, info))) throw new Error('提交属于其他云库，未接收。');
    setEdits({}); setEntries(page.entries); setSelected(page.entries.map((entry) => entry.id)); setMore(page.hasMore); setLoaded(true);
    if (!back && cursor) setHistory((values) => [...values, after]); else if (!cursor) setHistory([]); else if (back) setHistory((values) => values.slice(0, -1));
    setAfter(cursor); setNextAfter(page.entries.at(-1)?.seq ?? cursor); setMessage(`本页 ${page.entries.length} 条待接收。收藏接收后请同步，待看接收后请发布单独镜像。`);
    });
  };
  const receive = (reject = false) => {
    const chosen = entries.filter((entry) => selected.includes(entry.id)); if (!chosen.length) return;
    if (reject && !window.confirm(`退回选中的 ${chosen.length} 条提交？不会加入本机库，提交设备仍保留临时副本。`)) return;
    const localLibraryId = data.settings.libraryId;
    void execute(async (signal, current) => {
      const transport = client(), fresh = await transport.info(signal);
      if (!sameIdentity(fresh, info)) throw new Error('云端库身份变化，请重新连接。');
      let done = 0; const errors: string[] = [], finished = new Set<string>();
      for (const entry of chosen) {
        if (!current()) break;
        try {
          const receipt = reject ? { status: 'rejected' as const, recordKind: null, recordId: null, message: '总机退回，请在临时列表检查后重新添加。' } : await service.receiveCloudInbox(entry, localLibraryId, edits[entry.id]);
          await transport.acknowledge(entry, receipt, signal); finished.add(entry.id); done++;
        } catch (cause) { errors.push(`${entry.payload.title || entry.payload.url}：${toUserMessage(cause)}`); }
      }
      await reload(); notifyDataChanged();
      if (!current()) return;
      setEntries((values) => values.filter((entry) => !finished.has(entry.id))); setSelected((values) => values.filter((id) => !finished.has(id)));
      setMessage(`${reject ? '已退回' : '已接收'} ${done} 条。${errors.length ? ` ${errors.length} 条未确认，可重试；本机已入库的不会重复创建。\n${errors.join('\n')}` : reject ? '' : '收藏请检查并确认同步；待看请发布单独镜像。重复网址保留本机原内容；已入库但回执未确认的记录，重试保留首次接收结果。'}`);
    });
  };
  return <div className="panel cloud-inbox"><h2>云端收件箱</h2><p>手机可先提交，接收前可展开“调整后接收”修改分类等信息；修改仅用于这次入库，不回写手机提交。本机确认接收后再发布；备注会随提交暂存在云端，接收确认后云端清除提交正文。</p>
    <div className="toolbar"><button className="btn" disabled={busy} onClick={() => void load()}>检查云端收件箱</button>
      <button className="btn primary" disabled={busy || !selected.length} onClick={() => receive()}>接收选中（{selected.length}）</button>
      <button className="btn" disabled={busy || !selected.length} onClick={() => receive(true)}>退回选中</button></div>
    <p role="status" style={{ whiteSpace: 'pre-wrap' }}>{message}</p>
    {entries.length > 0 && <><label><input type="checkbox" checked={selected.length === entries.length} onChange={(event) => setSelected(event.target.checked ? entries.map((entry) => entry.id) : [])} /> 选择本页</label>
      {entries.map((entry) => <div className="notice" key={entry.id}><label><input type="checkbox" checked={selected.includes(entry.id)} onChange={(event) => setSelected((values) => event.target.checked ? [...values, entry.id] : values.filter((id) => id !== entry.id))} /> <strong>{entry.payload.title || entry.payload.url}</strong></label>
        <a href={entry.payload.url} target="_blank" rel="noreferrer noopener">{entry.payload.url}</a><span>{entry.payload.destination === 'reading' ? '待看' : entry.payload.categoryPath || '未分类'} · {entry.payload.tagNames.join('、') || '无标签'} · {new Date(entry.createdAt).toLocaleString('zh-CN')}</span>
        <details><summary>查看提交内容</summary><p>说明：{entry.payload.sourceDescription || '无'}</p><p style={{ whiteSpace: 'pre-wrap' }}>备注：{entry.payload.note || '无'}</p><p>置顶 {entry.payload.pinned ? '是' : '否'} · 禁止 AI {entry.payload.aiBlocked ? '是' : '否'}</p></details><InboxEditor entry={entry} edits={edits[entry.id] ?? {}} busy={busy} onChange={(value) => setEdits((current) => ({ ...current, [entry.id]: value }))} /></div>)}</>}
    {loaded && <div className="toolbar"><button className="btn" disabled={busy || !history.length} onClick={() => { const cursor = history.at(-1)!; void load(cursor, true); }}>上一页</button><span>每页最多 50 条</span><button className="btn" disabled={busy || !more} onClick={() => void load(nextAfter)}>下一页</button></div>}
  </div>;
}

function InboxEditor({ entry, edits, busy, onChange }: { entry: InboxEntry; edits: InboxReceiveEdits; busy: boolean; onChange: (value: InboxReceiveEdits) => void }) {
  const { data } = useWorkspace(); const [query, setQuery] = useState('');
  const value = { ...entry.payload, ...edits };
  const patch = (next: InboxReceiveEdits) => onChange({ ...edits, ...next });
  return <details className="inbox-editor"><summary>调整后接收{Object.keys(edits).length ? ' · 已修改' : '（可选）'}</summary>
    <p>修改会随“接收选中”一起保存。重复网址保留本机已有内容；回执重试不会再次覆盖已入库记录。</p>
    <fieldset disabled={busy}>
      <label className="field">保存到<select value={value.destination} onChange={(event) => patch({ destination: event.target.value as 'bookmark' | 'reading' })}><option value="bookmark">收藏</option><option value="reading">待看</option></select></label>
      <label className="field">标题<input maxLength={300} value={value.title} onChange={(event) => patch({ title: event.target.value })} /></label>
      {value.destination === 'bookmark' && <>
        <label className="field">分类<input type="search" placeholder="搜索本机分类名称或完整路径…" value={query} onChange={(event) => setQuery(event.target.value)} /><select aria-label="接收分类" value={edits.categoryId === undefined ? '__original__' : edits.categoryId || ''} onChange={(event) => { if(event.target.value==='__original__') { const next={...edits}; delete next.categoryId; onChange(next); } else patch({categoryId:event.target.value || null}); }}><option value="__original__">沿用手机分类：{entry.payload.categoryPath || '未分类'}</option><option value="">未分类</option>{data.categories.filter(row=>row.id===edits.categoryId || categoryPath(data.categories,row.id).toLowerCase().includes(query.trim().toLowerCase())).map(row=><option key={row.id} value={row.id}>{categoryPath(data.categories,row.id)}</option>)}</select></label>
        <label className="field">标签处理<select value={edits.tagIds === undefined ? 'original' : 'edit'} onChange={(event)=>{if(event.target.value==='original'){const next={...edits};delete next.tagIds;onChange(next);}else patch({tagIds:[]});}}><option value="original">沿用手机标签：{entry.payload.tagNames.join('、') || '无'}</option><option value="edit">重新选择本机标签</option></select></label>
        {edits.tagIds !== undefined && <label className="field">选择标签（最多30个）<select multiple value={edits.tagIds} onChange={event=>patch({tagIds:[...event.target.selectedOptions].map(option=>option.value).slice(0,30)})}>{data.tags.map(tag=><option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label>}
        <label className="field">来源说明<textarea maxLength={2000} value={value.sourceDescription} onChange={event=>patch({sourceDescription:event.target.value})} /></label>
        <div className="toolbar">{(['pinned','aiBlocked'] as const).map((key,index)=><label key={key}><input type="checkbox" checked={value[key]} onChange={event=>patch({[key]:event.target.checked})} />{['置顶','禁止 AI'][index]}</label>)}</div>
      </>}
      <label className="field">备注<textarea maxLength={10000} value={value.note} onChange={event=>patch({note:event.target.value})} /></label>
      <button className="btn" type="button" onClick={()=>{onChange({});setQuery('');}}>恢复手机提交内容</button>
    </fieldset>
  </details>;
}
