import { useState } from 'react';
import { notifyDataChanged } from '@shiye/application';
import { paginate } from '@shiye/core';
import { TwoWayClient } from '../../../packages/sync/src/two-way-client.js';
import { prepareSharedPlan, resolveShared, type SharedPlan } from '../../../packages/sync/src/two-way-local.js';
import { type SharedData, type SharedInfo, sameData } from '../../../packages/sync/src/two-way.js';
import { Pager } from './components.js';
import { useWorkspace } from './state.js';
type Execute = (action: (signal: AbortSignal, current: () => boolean) => Promise<void>, remote?: boolean) => Promise<void>;
export function TwoWayPanel({ address, token, execute, busy, onSynced }: { address: string; token: string; execute: Execute; busy: boolean; onSynced?: (info: SharedInfo) => void }) {
  const { service, data, reload, setPageSize } = useWorkspace();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [plan, setPlan] = useState<SharedPlan | null>(null), [message, setMessage] = useState('家里和工作电脑填写同一个后端地址与发布凭据，先检查，再确认同步。'), [page, setPage] = useState(1);
  const check = () => execute(async (signal, current) => {
    const local = await service.readTwoWay(address), remote = await new TwoWayClient(address, token).read(signal, local.state);
    const prepared = await prepareSharedPlan(address, local, remote.rows, remote.info);
    if (!current()) return; setPlan(prepared); setPage(1); setMessage((!remote.info.readingEnabled ? '本次会将本机待看并入共享库；首次请先在保存完整待看的电脑确认同步。' : '') + (local.state ? '已检查本机与云端变化。确认后才交换数据。' : '首次连接将合并已有收藏与待看，不以本机空库删除另一台的数据。请核对差异后确认。'));
  });
  const confirm = () => execute(async (signal, current) => {
    if (!plan) return;
    await service.assertTwoWay(plan);
    const result = await new TwoWayClient(address, token).upload(plan, signal, (keys) => service.assertTwoWay(plan, keys), (done, total) => { if (current()) setMessage(`已确认 ${done} / ${total} 批变更，正在核对同步结果…`); });
    if (!current()) return;
    await service.applyTwoWay(plan, result.rows, result.info.revision); await reload(); notifyDataChanged();
    if (current()) onSynced?.(result.info);
    if (current()) { setPlan(null); setMessage(`两台电脑同步完成 · 云端版本 ${result.info.revision}。另一台点击检查同步即可接收。手机“同步最新”后读取共享收藏与待看，不再单独发布待看镜像。`); }
  });
  const result = plan ? resolveShared(plan) : null, localRows = new Map(plan?.projection ?? []);
  const pulls = result ? [...result.merged].filter(([key, value]) => !sameData(localRows.get(key) ?? null, value)) : [];
  const unresolved = result?.conflicts.filter((row) => !plan?.choices[row.key]).length ?? 0;
  const conflicts = paginate(result?.conflicts ?? [], page, data.settings.pageSize);
  return <section className="panel two-way"><h2>收藏与待看双向同步</h2><p>同步收藏、分类、标签、备注、摘录、置顶和排序，以及待看的新增、标题、备注、完成/重新加入和移除。仅本机专用收藏及其关联待看不发送；AI Key、AI 会话和本机设置不参与。同步的收藏与待看正文（含备注）会进入你自己的 Cloudflare；手机公开列表仅显示标题、网址和状态。</p>
    <p>收藏或待看新增、修改、完成或移除后：先检查 → 核对发送与接收数量 → 确认同步。检查只读取差异；确认会同时推送本机变更、拉取云端变更。另一台电脑也需检查并确认，才会收到更新。</p><div className="toolbar"><button className="btn" disabled={busy} onClick={() => void check()}>检查两台电脑同步</button><button className="btn primary" disabled={busy || !plan || Boolean(unresolved)} onClick={() => void confirm()}>确认双向同步</button></div>
    <p role="status">{message}</p>
    {plan && result && <><div className="notice"><span>发送变更 {result.pushes.length} 项（删除/撤回 {result.pushes.filter((row) => !row.data).length}） · 接收变更 {pulls.length} 项 · 差异 {result.conflicts.length} 项，待选择 {unresolved} 项</span><span>待看：发送 {result.pushes.filter(row=>row.key.startsWith('r:')).length} 项 · 接收 {pulls.filter(([key])=>key.startsWith('r:')).length} 项；收藏：发送 {result.pushes.filter(row=>row.key.startsWith('b:')).length} 项 · 接收 {pulls.filter(([key])=>key.startsWith('b:')).length} 项。</span><span>本地专用隔离 {plan.excluded.length} 项 · 按上次共同版本比较；不是整库替换。项数包含收藏、待看、分类和标签。</span></div>
      {conflicts.rows.map((row) => <div className="notice" key={row.key}><strong>{row.key.startsWith('r:') ? '待看 · ' : ''}{row.local && 'title' in row.local ? row.local.title : row.remote && 'title' in row.remote ? row.remote.title : row.local && 'name' in row.local ? row.local.name : row.remote && 'name' in row.remote ? row.remote.name : row.key}</strong>
        <p>两边内容不同，请明确保留哪一份。删除与编辑冲突也需选择；保留删除时，收藏移入回收站，待看从列表移除并保留本机清理快照。</p><div className="toolbar"><button className={`btn ${plan.choices[row.key] === 'local' ? 'primary' : ''}`} disabled={busy} onClick={() => setPlan({ ...plan, choices: { ...plan.choices, [row.key]: 'local' } })}>保留本机{row.local ? '' : '删除'}</button><button className={`btn ${plan.choices[row.key] === 'remote' ? 'primary' : ''}`} disabled={busy} onClick={() => setPlan({ ...plan, choices: { ...plan.choices, [row.key]: 'remote' } })}>保留云端{row.remote ? '' : '删除'}</button></div>
        <details><summary>查看两份内容</summary><h3>本机</h3><RecordDetails value={row.local} values={new Map(plan.projection)} /><h3>云端</h3><RecordDetails value={row.remote} values={new Map(plan.remote.map((item) => [item.key, item.data]))} /></details></div>)}
      {result.conflicts.length > 0 && <Pager {...conflicts} onPage={setPage} onPageSize={(size) => { void setPageSize(size); setPage(1); }} />}
      <details onToggle={(event) => setPreviewOpen(event.currentTarget.open)}><summary>查看完整同步预览（分页）</summary>{previewOpen && <SyncPreview plan={plan} />}</details>
    </>}
    <details><summary>更换后端或从备份重建后，重新建立同步基线</summary><p>只解除此电脑的同步基线，保留本机及云端收藏。下次重新合并，旧删除判据失效，已有差异需重新确认。</p><button className="btn" disabled={busy} onClick={() => { if (!window.confirm('解除此电脑的同步基线？收藏保留，下次将重新合并，不能按旧基线传播删除。')) return; void execute(async (_signal, current) => { await service.disconnectTwoWay(address); if (current()) { setPlan(null); setMessage('已解除本机同步基线，下次检查会重新合并。'); } }, false); }}>解除此电脑同步基线</button></details>
  </section>;
}
function SyncPreview({ plan }: { plan: SharedPlan }) {
  const { data, setPageSize } = useWorkspace(); const [page, setPage] = useState(1), result = resolveShared(plan), local = new Map(plan.projection);
  const sent = new Set(result.pushes.map((row) => row.key));
  const rows = [...result.merged].filter(([key, value]) => !sameData(local.get(key) ?? null, value) || sent.has(key)).map(([key, value]) => ({ key, action: sent.has(key) ? '发送' : '接收', value }));
  const preview = paginate(rows, page, data.settings.pageSize);
  return <><div>{preview.rows.map((row) => <details className="notice" key={row.key}><summary>{row.action} · {row.key.startsWith('r:') ? '待看 · ' : ''}{row.value ? 'title' in row.value ? row.value.title : row.value.name : '删除或撤回共享'}</summary><RecordDetails value={row.value} values={result.merged} /></details>)}</div><Pager {...preview} onPage={setPage} onPageSize={(size) => { void setPageSize(size); setPage(1); }} /></>;
}

function RecordDetails({ value, values }: { value: SharedData | null; values: Map<string, SharedData | null> }) {
  if (!value) return <p>删除或撤回此共享记录；收到删除后收藏移入回收站，待看移除前留本机清理快照。</p>;
  const path = (key: string | null, seen = new Set<string>()): string => { if (!key || seen.has(key)) return ''; seen.add(key); const row = values.get(key); return row?.kind === 'category' ? [path(row.parent, seen), row.name].filter(Boolean).join(' / ') : ''; };
  const fields: Record<string, string> = value.kind==='reading' ? {类型:'待看',标题:value.title,网址:value.url,备注:value.note || '无',状态:value.status==='pending'?'待看':'已完成',加入时间:value.addedAt,完成时间:value.completedAt || '未完成'} : value.kind === 'bookmark' ? { 标题: value.title, 网址: value.url, 分类: path(value.category) || '未分类', 标签: value.tags.map((key) => { const row = values.get(key); return row?.kind === 'tag' ? row.name : '已变动标签'; }).join('、') || '无', 备注: value.note || '无', 来源说明: value.sourceDescription || '无', 摘录: value.selectedText || '无', 用途: value.aiPurpose || '无', 置顶: value.pinned ? '是' : '否', 禁止AI: value.aiBlocked ? '是' : '否', 排序位置: `同分类第 ${1 + [...values.values()].filter((row) => row?.kind === 'bookmark' && row.category === value.category && row.order < value.order).length} 位` } : value.kind === 'category' ? { 分类: value.name, 上级: path(value.parent) || '顶层', 说明: value.description || '无' } : { 标签: value.name };
  return <dl className="sync-record">{Object.entries(fields).map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}</dl>;
}
