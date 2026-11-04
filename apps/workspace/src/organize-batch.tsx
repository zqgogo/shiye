import { useEffect, useMemo, useRef, useState } from 'react';
import { ORGANIZE_SYSTEM, categoryPath, newId, paginate, toUserMessage, type Bookmark, type OrganizePlan } from '@shiye/core';
import { useAiConnection } from './ai-connection.js';
import { useWorkspace } from './state.js';
import { Notice, PageHeader, Pager } from './components.js';

type Suggestion = { part: number; batchId: string; n: number; bookmark: Bookmark; patch: { categoryId?: string | null | undefined; tagIds?: string[] | undefined; aiPurpose?: string | undefined }; reason: string };
const labels = { ready: '待发送', inflight: '请求中', completed: '回复已保存', failed: '失败，需手动重试', unknown: '结果未知，需确认后重试' };

export function BatchOrganizePage() {
  const ai = useAiConnection(); const aiCurrent = useRef(ai); aiCurrent.current = ai;
  const { data, service, navigate, reload } = useWorkspace();
  const [scope, setScope] = useState<'all' | 'uncategorized'>('uncategorized');
  const [includeNote, setIncludeNote] = useState(false), [includeText, setIncludeText] = useState(false), [includeDictionary, setIncludeDictionary] = useState(false);
  const [plan, setPlan] = useState<OrganizePlan | null>(null), [recent, setRecent] = useState<OrganizePlan[]>([]);
  const [partIndex, setPartIndex] = useState(0), [partPage, setPartPage] = useState(1);
  const [pack, setPack] = useState<Awaited<ReturnType<typeof service.openOrganizePart>> | null>(null);
  const [running, setRunning] = useState(false), [working, setWorking] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]), [excluded, setExcluded] = useState<Set<string>>(new Set()), [reviewed, setReviewed] = useState(false);
  const [rejectedItems, setRejectedItems] = useState<{ part: number; n: number; title: string; reason: string }[]>([]);
  const [rejectedPage, setRejectedPage] = useState(1);
  const [reviewPage, setReviewPage] = useState(1), [rejected, setRejected] = useState(0), [applied, setApplied] = useState(0);
  const requestLock = useRef(false);
  const owner = useRef(newId()), stop = useRef(false), mounted = useRef(true), selectionVersion = useRef(0);
  useEffect(() => { mounted.current = true; void service.listOrganizePlans().then(setRecent).catch((cause) => setError(toUserMessage(cause)));
    return () => { mounted.current = false; stop.current = true; aiCurrent.current.cancel(); };
  }, [service]);
  const refresh = async (id: string) => { const next = await service.getOrganizePlan(id); if (mounted.current) setPlan(next); return next; };
  useEffect(() => {
    const version = ++selectionVersion.current; setPack(null);
    if (!plan || plan.closed) return;
    void service.openOrganizePart(plan.id, partIndex).then((next) => { if (mounted.current && version === selectionVersion.current) setPack(next); })
      .catch((cause) => { if (mounted.current && version === selectionVersion.current) setError(toUserMessage(cause)); });
  }, [service, plan, partIndex]);
  const resetReview = () => { setSuggestions([]); setExcluded(new Set()); setReviewed(false); setApplied(0); setRejected(0); setRejectedItems([]); setRejectedPage(1); setReviewPage(1); };
  const prepare = async () => {
    setWorking(true); setError(''); resetReview();
    try { const next = await service.buildOrganizePlan({ scope, selectedIds: [], includeNote, includeText, includeDictionary,
      inputChars: ai.profile.inputChars, outputTokens: ai.profile.outputTokens }); setPlan(next); setPartIndex(0); setPartPage(1);
      setRecent(await service.listOrganizePlans()); setMessage(`完整规划 ${next.itemCount} 条，共 ${next.parts.length} 片，尚未发送。`);
    } catch (cause) { setError(toUserMessage(cause)); } finally { setWorking(false); }
  };
  const open = async (id: string) => { setError(''); resetReview(); setPartIndex(0); setPartPage(1); try { await refresh(id); setMessage('已续接本机计划，不会自动发送。刷新后请重新配置并测试 AI。'); } catch (cause) { setError(toUserMessage(cause)); } };
  const send = async (mode: 'remaining' | 'failed' | 'current') => {
    if (!plan || running || requestLock.current) return;
    if (!ai.enabled || !ai.jsonTested) { setError('请先配置、测试并开启内置 AI。'); return; }
    if (ai.profile.inputChars < plan.inputChars || ai.profile.outputTokens < plan.outputTokens) { setError('当前模型预算小于此计划的冻结预算，请重新规划或恢复预算并测试。'); return; }
    requestLock.current = true;
    let latestPlan: OrganizePlan | null;
    try { latestPlan = await service.getOrganizePlan(plan.id); } catch (cause) { requestLock.current = false; setError(toUserMessage(cause)); return; }
    if (!latestPlan || latestPlan.closed) { requestLock.current = false; setError('计划已结束，请重新打开。'); return; }
    setPlan(latestPlan);
    const selected = latestPlan.parts.map((part, index) => ({ part, index })).filter(({ part, index }) =>
      mode === 'failed' ? ['failed', 'unknown'].includes(part.state) : mode === 'current' ? index === partIndex && part.state !== 'completed' : part.state !== 'completed');
    if (!selected.length) { requestLock.current = false; setMessage('没有需要发送的分片，已完成分片不会重复发送。'); return; }
    if (selected.some(({ part }) => part.state === 'failed' || part.state === 'unknown') && !window.confirm('失败或中断的请求可能已经被服务商处理并计费。确认手动重试这些分片？已保存回复的分片不会重发。')) { requestLock.current = false; return; }
    stop.current = false; setRunning(true); setError(''); resetReview();
    const id = plan.id, fingerprint = ai.fingerprint;
    let acquired = false;
    try {
      await service.startOrganizeRun(id, owner.current); acquired = true;
      for (const { index } of selected) {
        if (stop.current || aiCurrent.current.fingerprint !== fingerprint || !aiCurrent.current.enabled) break;
        const next = await refresh(id);
        if (!next || next.parts[index]?.state === 'completed') continue;
        let attempt: string | null = null, task: string | null = null, responseReceived = false;
        try {
          attempt = await service.claimOrganizePart(id, index, owner.current);
          const currentPack = await service.openOrganizePart(id, index);
          if (mounted.current) { setPartIndex(index); setMessage(`正在请求第 ${index + 1} / ${next.parts.length} 片，已保存 ${next.parts.filter((part) => part.state === 'completed').length} 片。`); }
          const text = await aiCurrent.current.send(ORGANIZE_SYSTEM, currentPack.materialText, true, async () => {
            await service.assertHandoffSendable(currentPack.batchId, currentPack.materialText);
            task = await service.beginAiTask('organize', fingerprint, currentPack.items.map((item) => item.bookmark.id));
            await service.assertHandoffSendable(currentPack.batchId, currentPack.materialText);
            if (stop.current || aiCurrent.current.fingerprint !== fingerprint) throw new Error('已暂停或配置已变化。');
          });
          responseReceived = true;
          if (stop.current || aiCurrent.current.fingerprint !== fingerprint) throw new Error('配置已变化，迟到结果未采用。');
          await service.completeOrganizePart(id, index, owner.current, attempt, text);
          if (task) await service.finishAiTask(task, 'completed');
          await refresh(id);
        } catch (cause) {
          if (attempt) await service.failOrganizePart(id, index, owner.current, attempt, Boolean(task) && !responseReceived, responseReceived).catch(() => undefined);
          if (mounted.current) setError(`${toUserMessage(cause)} 已停止后续分片；可手动重试未完成部分。`);
          break;
        }
      }
    } catch (cause) { if (mounted.current) setError(toUserMessage(cause)); }
    finally {
      if (acquired) await service.releaseOrganizeRun(id, owner.current).catch(() => undefined);
      try { const latest = await service.getOrganizePlan(id);
        if (mounted.current) { setPlan(latest); setMessage(`已保存 ${latest?.parts.filter((part) => part.state === 'completed').length ?? 0} / ${latest?.parts.length ?? 0} 片回复。建议尚未应用，请校验预览。`); }
      } catch (cause) { if (mounted.current) setError(toUserMessage(cause)); }
      finally { requestLock.current = false; if (mounted.current) setRunning(false); }
    }
  };
  const review = async () => {
    if (!plan) return; setWorking(true); setError(''); resetReview();
    const accepted: Suggestion[] = []; const rejectedRows: typeof rejectedItems = []; let invalid = 0, alreadyApplied = 0;
    try {
      const latest = await service.getOrganizePlan(plan.id); if (!latest) throw new Error('计划已清除。');
      for (const [index, part] of latest.parts.entries()) {
        if (part.state !== 'completed') continue;
        const current = await service.openOrganizePart(plan.id, index);
        alreadyApplied += current.appliedNumbers.length;
        if (current.status === 'applied' || current.status === 'invalidated') continue;
        const envelope = JSON.parse(current.reply) as { results: { n: number }[] };
        envelope.results = envelope.results.filter((row) => !current.appliedNumbers.includes(row.n));
        const checked = await service.validateAiReply({ text: JSON.stringify(envelope), ...current });
        rejectedRows.push(...checked.rejected.map((row) => ({ ...row, part: index })));
        invalid += checked.rejected.length;
        accepted.push(...checked.applied.map((row) => ({ ...row, part: index, batchId: part.batchId })));
      }
      setSuggestions(accepted); setRejectedItems(rejectedRows); setRejected(invalid); setApplied(alreadyApplied); setReviewed(true); setMessage(`校验完成：可应用 ${accepted.length} 条，拒绝 ${invalid} 条；仍需你确认写入。`);
    } catch (cause) { setError(toUserMessage(cause)); } finally { setWorking(false); }
  };
  const apply = async () => {
    if (!plan) return; const selected = suggestions.filter((row) => !excluded.has(`${row.part}:${row.n}`));
    if (!selected.length) return;
    if (!window.confirm(`确认应用已预览的 ${selected.length} 条建议？只改分类、标签与 AI 用途，每条写入前仍检查版本，可撤销未被后续修改的部分。`)) return;
    setWorking(true); setError(''); let count = 0, skipped = 0;
    try {
      for (const [index, part] of plan.parts.entries()) {
        const chosen = selected.filter((row) => row.part === index); if (!chosen.length) continue;
        const result = await service.applySuggestions(part.batchId, chosen);
        count += result.applied.length; skipped += result.skipped.length;
      }
      setApplied((value) => value + count); setSuggestions([]); setReviewed(false);
      await reload(); setMessage(`已应用 ${count} 条，跳过 ${skipped} 条。没有请求 AI，可重新校验剩余建议。`);
    } catch (cause) { setError(toUserMessage(cause)); }
    finally { setWorking(false); }
  };
  const undo = async () => {
    if (!plan) return; setWorking(true); setError(''); let count = 0, conflicts = 0;
    try { const result = await service.undoOrganizePlan(plan.id); count = result.reverted; conflicts = result.conflicts.length;
      await reload(); resetReview(); setMessage(`已撤销 ${count} 条；${conflicts} 条因后续修改而保留。撤销过的分片不会自动重发。`);
    } catch (cause) { setError(toUserMessage(cause)); } finally { setWorking(false); }
  };
  const partView = paginate(plan?.parts.map((part, index) => ({ ...part, index })) ?? [], partPage, data.settings.pageSize);
  const reviewView = paginate(suggestions, reviewPage, data.settings.pageSize);
  const rejectedView = paginate(rejectedItems, rejectedPage, data.settings.pageSize);
  const busy = running || working;
  const complete = plan?.parts.filter((part) => part.state === 'completed').length ?? 0;
  const eligible = useMemo(() => data.bookmarks.filter((row) => !row.privacy.localOnly && !row.privacy.aiBlocked && (scope === 'all' || !row.categoryId)).length, [data.bookmarks, scope]);
  return <>
    <PageHeader title="一次规划，分批整理。" description="完整覆盖所选范围；AI 直接连接你的服务，Cloudflare 不参与。" action={<button className="btn" onClick={() => navigate('organize')}>手动单批交接 ↗</button>} />
    <div className="panel"><h2>规划本次范围</h2><p>可发送 {eligible} 条。按每片最多 20 条及当前输入/输出预算切分，所有分片先在本地生成；字符和输出预算是估算，不代表精确费用。</p>
      <label className="field"><span>整理范围</span><select disabled={busy} value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="uncategorized">仅未分类</option><option value="all">全部可发送收藏</option></select></label>
      <label className="checkline"><input type="checkbox" disabled={busy} checked={includeNote} onChange={(event) => setIncludeNote(event.target.checked)} />包含人工备注</label>
      <label className="checkline"><input type="checkbox" disabled={busy} checked={includeText} onChange={(event) => setIncludeText(event.target.checked)} />包含主动摘录</label>
      <label className="checkline"><input type="checkbox" disabled={busy} checked={includeDictionary} onChange={(event) => setIncludeDictionary(event.target.checked)} />允许参考现有分类和标签（排除受保护资料关联目录）</label>
      <p className="micro">目标 {ai.profile.baseUrl} · {ai.profile.model} · 输入 {ai.profile.inputChars} 字符／片 · 输出上限 {ai.profile.outputTokens} token／片。Key 仅在当前工作台内存，不进入计划、备份或云端。</p>
      <div className="toolbar"><button className="btn primary" disabled={busy || !eligible} onClick={() => void prepare()}>生成完整分片计划</button><button className="btn" disabled={running} onClick={() => navigate('aiconfig')}>配置内置 AI</button></div>
    </div>
    {recent.length > 0 && <details className="panel"><summary>最近 20 份未结束计划（仅本机）</summary>{recent.map((row) => <div className="toolbar" key={row.id}><span>{new Date(row.createdAt).toLocaleString('zh-CN')} · {row.itemCount} 条／{row.parts.length} 片</span><button className="btn small" disabled={busy} onClick={() => void open(row.id)}>继续此计划</button></div>)}</details>}
    <p role="status">{message}</p><p className="alert" role="alert">{error}</p>
    {plan && <>
      <div className="panel"><h2>完整计划：{plan.itemCount} 条 · {plan.parts.length} 片</h2><p>已保存回复 {complete} / {plan.parts.length} 片。只上传本次逐片材料，回复全部保存在本机；完成请求不会自动应用。</p>
        {plan.lease && <Notice>执行权保留至 {new Date(plan.lease.until).toLocaleTimeString('zh-CN')}。页面意外关闭后，等待到期再刷新；中断片显示结果未知，不会自动重试。</Notice>}
        <div className="toolbar"><button className="btn primary" disabled={busy || !ai.enabled || !ai.jsonTested || complete === plan.parts.length} onClick={() => void send('remaining')}>确认发送／重试全部未完成分片</button><button className="btn" disabled={busy || !ai.enabled || !ai.jsonTested || !plan.parts.some((part) => ['failed', 'unknown'].includes(part.state))} onClick={() => void send('failed')}>只重试失败／中断分片</button>
          {running && <button className="btn" onClick={() => { stop.current = true; aiCurrent.current.cancel(); }}>暂停并取消当前请求</button>}
          <button className="btn" disabled={busy} onClick={() => void refresh(plan.id)}>刷新计划状态</button>
        </div>
        <p className="micro">网络中断或取消可能已经计费。一次只由一个页面执行，失败即暂停后续分片；再次发送需主动确认。关闭或刷新页面均不自动续费重发。</p>
        <div className="table-scroll"><table className="table batch-part-table"><thead><tr><th>分片</th><th>条数</th><th>请求状态</th><th>材料</th></tr></thead><tbody>{partView.rows.map((part) => <tr key={part.batchId}><td>{part.index + 1}</td><td>{part.itemCount}</td><td>{labels[part.state]}</td><td><button className="btn small" disabled={busy} onClick={() => setPartIndex(part.index)}>查看第 {part.index + 1} 片</button></td></tr>)}</tbody></table></div>
        <Pager {...partView} onPage={setPartPage} onPageSize={(size) => { void service.setPageSize(size).then(reload); setPartPage(1); }} />
        {pack && <details key={pack.batchId}><summary>第 {partIndex + 1} 片实际发送材料与已保存回复</summary><pre className="code">{pack.materialText}</pre>{pack.reply && <pre className="code">{pack.reply}</pre>}
          <button className="btn" disabled={busy || !ai.enabled || plan.parts[partIndex]?.state === 'completed'} onClick={() => void send('current')}>仅发送当前片</button></details>}
      </div>
      <div className="panel"><h2>校验、预览与应用</h2><p>可以先处理已完成片，其余分片保留。隐私、内容或锁定状态变化的建议会被拒绝；不会请求 AI 再生成一遍。</p>
        <div className="toolbar"><button className="btn" disabled={busy || complete === 0} onClick={() => void review()}>校验所有已完成回复</button><button className="btn" disabled={busy} onClick={() => void undo()}>撤销此计划已应用建议</button></div>
        {reviewed && <><p>可应用 {suggestions.length} 条 · 拒绝 {rejected} 条 · 累计应用 {applied} 条（含已撤销）</p><div className="toolbar"><button className="btn small" onClick={() => setExcluded(new Set())}>全选可应用建议</button><button className="btn small" onClick={() => setExcluded(new Set(suggestions.map((row) => `${row.part}:${row.n}`)))}>取消全部选择</button></div>
          {reviewView.rows.map((row) => <div className="diff" key={`${row.part}:${row.n}`}><label className="checkline"><input type="checkbox" checked={!excluded.has(`${row.part}:${row.n}`)} onChange={(event) => setExcluded((current) => { const next = new Set(current); if (event.target.checked) next.delete(`${row.part}:${row.n}`); else next.add(`${row.part}:${row.n}`); return next; })} /><strong>第 {row.part + 1} 片 #{row.n} {row.bookmark.title}</strong></label>
            <p>分类：{categoryPath(data.categories, row.bookmark.categoryId) || '未分类'} → {row.patch.categoryId === undefined ? '不修改' : categoryPath(data.categories, row.patch.categoryId) || '未分类'}</p>
            <p>标签：{row.patch.tagIds === undefined ? '不修改' : row.patch.tagIds.map((id) => data.tags.find((tag) => tag.id === id)?.name ?? '未知标签').join('、') || '清空标签'}</p>
            {row.patch.aiPurpose !== undefined && <p>用途：{row.patch.aiPurpose || '清空 AI 用途'}</p>}<p className="micro">{row.reason}</p>
          </div>)}
          <Pager {...reviewView} onPage={setReviewPage} onPageSize={(size) => { void service.setPageSize(size).then(reload); setReviewPage(1); }} />
          {rejectedItems.length > 0 && <details><summary>查看 {rejectedItems.length} 条拒绝原因</summary>{rejectedView.rows.map((row) => <p className="alert" key={`${row.part}:${row.n}:${row.reason}`}>第 {row.part + 1} 片 #{row.n} {row.title}：{row.reason}</p>)}<Pager {...rejectedView} onPage={setRejectedPage} onPageSize={(size) => { void service.setPageSize(size).then(reload); setRejectedPage(1); }} /></details>}
          <button className="btn primary" disabled={busy || suggestions.length === excluded.size} onClick={() => void apply()}>确认应用已勾选 {suggestions.length - excluded.size} 条建议</button>
        </>}
      </div>
      <button className="btn danger" disabled={busy} onClick={async () => { if (!window.confirm('结束这份计划？不会撤销已应用的建议；如需撤销，请先使用上方撤销入口。')) return; await service.closeOrganizePlan(plan.id); setPlan(null); setPack(null); setRecent(await service.listOrganizePlans()); }}>结束此计划</button>
    </>}
  </>;
}
