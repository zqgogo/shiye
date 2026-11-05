import { useState } from 'react';
import { toUserMessage } from '@shiye/core';
import { notifyDataChanged } from '@shiye/application';
import { sameIdentity, type MirrorInfo } from '../../../packages/sync/src/protocol.js';
import type { MirrorClient } from '../../../packages/sync/src/client.js';
import type { InboxEntry } from '../../../packages/sync/src/inbox.js';
import { useWorkspace } from './state.js';
type Execute = (action: (signal: AbortSignal, current: () => boolean) => Promise<void>, remote?: boolean) => Promise<void>;
export function CloudInbox({ client, info, busy, execute }: { client: () => MirrorClient; info: MirrorInfo; busy: boolean; execute: Execute }) {
  const { data, service, reload } = useWorkspace();
  const [entries, setEntries] = useState<InboxEntry[]>([]), [selected, setSelected] = useState<string[]>([]);
  const [after, setAfter] = useState(0), [history, setHistory] = useState<number[]>([]), [more, setMore] = useState(false);
  const [nextAfter, setNextAfter] = useState(0);
  const [message, setMessage] = useState('点击检查，接收手机和其他设备发来的收藏。'), [loaded, setLoaded] = useState(false);
  const load = (cursor = 0, back = false) => execute(async (signal, current) => {
    const transport = client(); const fresh = await transport.info(signal);
    if (!sameIdentity(fresh, info)) throw new Error('云端库身份变化，请重新连接。');
    const page = await transport.inbox(signal, cursor);
    if (!current()) return;
    if (page.entries.some((entry) => !sameIdentity(entry.identity, info))) throw new Error('提交属于其他云库，未接收。');
    setEntries(page.entries); setSelected(page.entries.map((entry) => entry.id)); setMore(page.hasMore); setLoaded(true);
    if (!back && cursor) setHistory((values) => [...values, after]); else if (!cursor) setHistory([]);
    setAfter(cursor); setNextAfter(page.entries.at(-1)?.seq ?? cursor); setMessage(`本页 ${page.entries.length} 条待接收。接收入本机后仍需重新发布，其他设备才会看到正式记录。`);
  });
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
          const receipt = reject ? { status: 'rejected' as const, recordKind: null, recordId: null, message: '总机退回，请在临时列表检查后重新添加。' } : await service.receiveCloudInbox(entry, localLibraryId);
          await transport.acknowledge(entry, receipt, signal); finished.add(entry.id); done++;
        } catch (cause) { errors.push(`${entry.payload.title || entry.payload.url}：${toUserMessage(cause)}`); }
      }
      await reload(); notifyDataChanged();
      if (!current()) return;
      setEntries((values) => values.filter((entry) => !finished.has(entry.id))); setSelected((values) => values.filter((id) => !finished.has(id)));
      setMessage(`${reject ? '已退回' : '已接收'} ${done} 条。${errors.length ? ` ${errors.length} 条未确认，可重试；本机已入库的不会重复创建。\n${errors.join('\n')}` : reject ? '' : '请重新准备预览并发布。重复网址保留总机原内容。'}`);
    });
  };
  return <div className="panel cloud-inbox"><h2>云端收件箱</h2><p>手机可按分类添加收藏或直接放待看。本机确认接收后再发布；备注会随提交暂存在云端，接收确认后云端清除提交正文。</p>
    <div className="toolbar"><button className="btn" disabled={busy} onClick={() => void load()}>检查云端收件箱</button>
      <button className="btn primary" disabled={busy || !selected.length} onClick={() => receive()}>接收选中（{selected.length}）</button>
      <button className="btn" disabled={busy || !selected.length} onClick={() => receive(true)}>退回选中</button></div>
    <p role="status" style={{ whiteSpace: 'pre-wrap' }}>{message}</p>
    {entries.length > 0 && <><label><input type="checkbox" checked={selected.length === entries.length} onChange={(event) => setSelected(event.target.checked ? entries.map((entry) => entry.id) : [])} /> 选择本页</label>
      {entries.map((entry) => <div className="notice" key={entry.id}><label><input type="checkbox" checked={selected.includes(entry.id)} onChange={(event) => setSelected((values) => event.target.checked ? [...values, entry.id] : values.filter((id) => id !== entry.id))} /> <strong>{entry.payload.title || entry.payload.url}</strong></label>
        <a href={entry.payload.url} target="_blank" rel="noreferrer noopener">{entry.payload.url}</a><span>{entry.payload.destination === 'reading' ? '待看' : entry.payload.categoryPath || '未分类'} · {entry.payload.tagNames.join('、') || '无标签'} · {new Date(entry.createdAt).toLocaleString('zh-CN')}</span>
        <details><summary>查看提交内容</summary><p>说明：{entry.payload.sourceDescription || '无'}</p><p style={{ whiteSpace: 'pre-wrap' }}>备注：{entry.payload.note || '无'}</p><p>置顶 {entry.payload.pinned ? '是' : '否'} · 未读 {entry.payload.unread ? '是' : '否'} · 禁止 AI {entry.payload.aiBlocked ? '是' : '否'}</p></details></div>)}</>}
    {loaded && <div className="toolbar"><button className="btn" disabled={busy || !history.length} onClick={() => { const cursor = history.at(-1)!; setHistory((values) => values.slice(0, -1)); void load(cursor, true); }}>上一页</button><span>每页最多 50 条</span><button className="btn" disabled={busy || !more} onClick={() => void load(nextAfter)}>下一页</button></div>}
  </div>;
}
