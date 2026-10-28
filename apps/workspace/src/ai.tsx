import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LIMITS,
  codePointLength,
  domainOf,
  isAiEligible,
  toUserMessage,
  type Bookmark,
} from '@shiye/core';
import { Notice, PageHeader } from './components.js';
import { useWorkspace } from './state.js';

interface ApplyItem {
  n: number;
  bookmark: Bookmark;
  patch: { categoryId?: string | null | undefined; tagIds?: string[] | undefined; aiPurpose?: string | undefined };
  reason: string;
}

export function AiPage() {
  const { navigate, data } = useWorkspace();
  const card = (icon: string, title: string, description: string, route: string) => (
    <button className="hubcard" onClick={() => navigate(route)}>
      <span className="hubicon">{icon}</span>
      <span className="hubtext">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className="hubarrow">↗</span>
    </button>
  );
  const eligible = data.bookmarks.filter((bookmark) => isAiEligible(bookmark)).length;
  return (
    <>
      <PageHeader title="让收藏重新派上用场。" description="默认手动交接；内置 AI 是默认关闭的可选模块。" />
      <Notice>
        当前可用 {eligible} 条可发送收藏。本地专用与禁止 AI 的条目不会进入材料包；选全不等于授权发送。
      </Notice>
      <div className="hubgrid">
        {card('✧', '整理收藏', '导出整理包、校验回复并预览应用', 'organize')}
        {card('⌕', '查找与提问', '检索收藏，生成提问包手动交接', 'ask')}
        {card('⚙', 'AI 通道设置', '内置 AI 尚未接入（P7 阶段）', 'aiconfig')}
      </div>
      <div className="panel" style={{ marginTop: 16 }}>
        <h2>两条通道的边界</h2>
        <p>
          手动交接与内置 AI 共用隐私过滤、字段白名单、锁定与版本校验。AI 只能建议分类、标签与 AI 用途，
          不会修改未读、待看状态、人工备注或隐私设置。
        </p>
        <div className="notice">本版本未接入真实模型：不会发起网络请求，也不会产生供应商费用。</div>
      </div>
    </>
  );
}

export function AiConfigPage() {
  const { navigate } = useWorkspace();
  return (
    <>
      <PageHeader
        title="选择适合你的 AI 方式。"
        description="默认手动交接；内置 AI 需要配置、真实测试通过并主动开启。"
        action={
          <button className="btn" onClick={() => navigate('ai')}>
            ← 返回 AI 助手
          </button>
        }
      />
      <div className="panel">
        <h2>
          手动交接 <span className="tag">默认可用</span>
        </h2>
        <p>生成整理包或提问包，交给你习惯使用的 AI。回复导入前必须通过本地严格校验。</p>
        <button className="btn primary" onClick={() => navigate('organize')}>
          去整理收藏
        </button>
      </div>
      <div className="panel">
        <h2>
          内置 AI <span className="tag">未启用</span>
        </h2>
        <p>
          按技术说明 P7，内置通道需要供应商端点、模型、凭据、主机权限与真实测试。当前版本尚未实现适配器，
          因此这里不接收密钥，也不会显示“测试通过”。
        </p>
        <div className="notice">
          密钥不会进入备份、日志、材料包或 content script；未来接入时也只在可信扩展上下文使用。
        </div>
        <div className="toolbar">
          <button className="btn" disabled>
            测试连接（未实现）
          </button>
          <button className="btn" disabled>
            启用内置 AI（未实现）
          </button>
        </div>
      </div>
      <Notice>需要真实模型时，请使用手动交接：生成材料包 → 在外部 AI 使用 → 严格校验后应用。</Notice>
    </>
  );
}

export function OrganizePage() {
  const { data, service, run, toast } = useWorkspace();
  const [step, setStep] = useState(1);
  const [scope, setScope] = useState<'uncategorized' | 'all'>('uncategorized');
  const [pack, setPack] = useState<{
    batchId: string;
    materialText: string;
    items: { n: number; bookmark: Bookmark; inputHash: string }[];
    policyVersion: number;
    notice: string | null;
  } | null>(null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState<ApplyItem[]>([]);
  const [rejected, setRejected] = useState<{ n: number; title: string; reason: string }[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [appliedCount, setAppliedCount] = useState<number | null>(null);
  const [resume, setResume] = useState<
    | { kind: 'none' }
    | { kind: 'stale'; batchId: string; reason: string }
    | {
        kind: 'ok';
        batchId: string;
        materialText: string;
        policyVersion: number;
        createdAt: string;
        items: { n: number; bookmark: Bookmark; inputHash: string }[];
        invalidCount: number;
      }
  >({ kind: 'none' });
  const [revertResult, setRevertResult] = useState<{
    reverted: number;
    conflicts: { bookmarkId: string; reason: string }[];
  } | null>(null);
  const resumeChecked = useRef(false);

  const eligibleCount = data.bookmarks.filter(
    (bookmark) => isAiEligible(bookmark) && (scope === 'all' || !bookmark.categoryId)
  ).length;

  /**
   * 挂载时查一次在途批次：材料包与编号映射已落库，刷新不该让用户从头再导一遍。
   * 换主库或映射缺失时明确给出原因，而不是静默当成没有。
   */
  useEffect(() => {
    if (resumeChecked.current) return;
    resumeChecked.current = true;
    void service.findResumableHandoff().then((found) => {
      if (found.status === 'none') return;
      if (found.status === 'stale') {
        setResume({ kind: 'stale', batchId: found.batchId, reason: found.reason });
        return;
      }
      setResume({
        kind: 'ok',
        batchId: found.batchId,
        materialText: found.materialText,
        policyVersion: found.policyVersion,
        createdAt: found.createdAt,
        items: found.items,
        invalidCount: found.invalidCount,
      });
    });
  }, [service]);

  const continueResume = () => {
    if (resume.kind !== 'ok') return;
    setPack({
      batchId: resume.batchId,
      materialText: resume.materialText,
      items: resume.items,
      policyVersion: resume.policyVersion,
      notice:
        resume.invalidCount > 0
          ? `有 ${resume.invalidCount} 条资料已删除，导入映射时会自动拒绝。`
          : null,
    });
    setReply('');
    setAccepted([]);
    setRejected([]);
    setWarnings([]);
    setAppliedCount(null);
    setRevertResult(null);
    setStep(2);
  };

  const dropResume = async () => {
    if (resume.kind === 'none') return;
    await run(() => service.discardHandoff(resume.batchId), '已丢弃上次的交接批次。');
    setResume({ kind: 'none' });
  };

  const generate = async () => {
    setBusy(true);
    setError('');
    const result = await run(() =>
      service.buildOrganizePack({ scope, selectedIds: [], maxItems: LIMITS.aiItemsPerPart })
    );
    setBusy(false);
    if (!result) return;
    setPack(result);
    setStep(2);
    setReply('');
    setAccepted([]);
    setRejected([]);
    setWarnings([]);
    setAppliedCount(null);
    setRevertResult(null);
    setResume({ kind: 'none' });
  };

  const validate = async () => {
    if (!pack) return;
    setBusy(true);
    setError('');
    try {
      const checked = await service.validateAiReply({
        text: reply,
        batchId: pack.batchId,
        items: pack.items,
        policyVersion: pack.policyVersion,
      });
      setAccepted(checked.applied);
      setRejected(checked.rejected);
      setWarnings(checked.warnings);
      setExcluded(new Set());
      setStep(3);
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!pack) return;
    const selected = accepted.filter((item) => !excluded.has(item.n));
    if (selected.length === 0) {
      setError('请至少勾选一条可应用的建议。');
      return;
    }
    setBusy(true);
    const outcome = await service.applySuggestions(
      pack.batchId,
      selected.map((item) => ({ n: item.n, bookmark: item.bookmark, patch: item.patch }))
    );
    setBusy(false);
    setAppliedCount(outcome.applied.length);
    setRevertResult(null);
    await run(async () => undefined);
    toast(
      `已应用 ${outcome.applied.length} 条，跳过 ${outcome.skipped.length} 条。应用日志可用于核对。`
    );
  };

  const revert = async () => {
    if (!pack) return;
    setBusy(true);
    try {
      const outcome = await service.revertBatch(pack.batchId);
      setRevertResult(outcome);
      await run(async () => undefined);
      toast(
        outcome.conflicts.length === 0
          ? `已撤销 ${outcome.reverted} 条修改。`
          : `已撤销 ${outcome.reverted} 条，${outcome.conflicts.length} 条存在冲突未撤销。`,
        outcome.conflicts.length === 0 ? 'ok' : 'error'
      );
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const copyPack = async () => {
    if (!pack) return;
    try {
      await navigator.clipboard.writeText(pack.materialText);
      toast('材料包已复制。');
    } catch {
      toast('剪贴板不可用，请直接选中下方文本复制。', 'error');
    }
  };

  return (
    <>
      <PageHeader
        title="整理，让收藏各归其位。"
        description="主动触发，人工确认。本页不会连接模型。"
        action={
          <button className="btn" onClick={() => setStep(1)}>
            重新开始
          </button>
        }
      />
      <div className="steps">
        {['选择范围', '交换材料', '预览应用'].map((label, index) => (
          <div key={label} className={`step ${step === index + 1 ? 'active' : ''}`}>
            {String(index + 1).padStart(2, '0')} {label}
          </div>
        ))}
      </div>

      {step === 1 && resume.kind === 'stale' ? (
        <Notice>
          上次的交接无法续接：{resume.reason}
          <button className="btn small" style={{ marginLeft: 12 }} onClick={() => void dropResume()}>
            清掉这一批
          </button>
        </Notice>
      ) : null}

      {step === 1 && resume.kind === 'ok' ? (
        <div className="panel" aria-label="在途批次">
          <h2>上次的交接还在</h2>
          <p>
            批次 {resume.batchId.slice(0, 8)}… · {resume.items.length} 条 · 生成于{' '}
            {new Date(resume.createdAt).toLocaleString('zh-CN')}
            {resume.invalidCount > 0 ? ` · 其中 ${resume.invalidCount} 条资料已删除` : ''}
          </p>
          <p className="micro">
            材料包与编号映射存在本地，刷新或重开浏览器后可以接着用；换了主库则不能续接。
          </p>
          <div className="actions">
            <button className="btn primary" onClick={continueResume}>
              继续这一批
            </button>
            <button className="btn" onClick={() => void dropResume()}>
              丢弃
            </button>
          </div>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="two">
          <div className="panel">
            <h2>本次整理范围</h2>
            <p>私密与禁止 AI 的条目自动排除；单批最多 {LIMITS.aiItemsPerPart} 条，超出需分批。</p>
            <label className="field">
              <span>范围</span>
              <select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
                <option value="uncategorized">仅未分类（{eligibleCount} 条可发送）</option>
                <option value="all">全部可发送收藏</option>
              </select>
            </label>
            <label className="field">
              <span>整理策略 · v{data.policy.policyVersion}</span>
              <textarea value={data.policy.instruction} readOnly style={{ minHeight: 100 }} />
              <small>策略在「设置 › 分类与策略」中修改；修改后旧结果自动失效。</small>
            </label>
            <div className="actions">
              <button className="btn primary" onClick={() => void generate()} disabled={busy}>
                {busy ? '准备中…' : '生成材料包 →'}
              </button>
            </div>
          </div>
          <div className="panel">
            <h2>人工信息始终优先</h2>
            <p>程序保存编号映射与输入指纹，AI 无需回显哈希。模型回复只提供建议，应用前仍需你确认。</p>
            <div className="notice">
              应用只写分类、标签与 AI 用途；不会改动未读、待看状态、人工备注或隐私设置。
            </div>
            <p className="micro">本地专用、禁止 AI 的内容会被排除；类别和标签使用稳定 ID，避免同名误配。</p>
            <div className="sample">不额外产生本工具的 API 账单，但仍消耗外部 AI 订阅额度。</div>
          </div>
        </div>
      ) : null}

      {step === 2 && pack ? (
        <div className="panel">
          <h2>把材料交给你订阅的 AI</h2>
          <p>
            批次 {pack.batchId.slice(0, 8)}… · {pack.items.length} 条 · 要求返回 protocolVersion 2 的 JSON
          </p>
          {pack.notice ? <Notice>{pack.notice}</Notice> : null}
          <pre className="code" aria-label="整理材料包">
            {pack.materialText}
          </pre>
          <div className="actions">
            <button className="btn" onClick={() => setStep(1)}>
              ← 重新选择
            </button>
            <button className="btn" onClick={() => void copyPack()}>
              复制材料包
            </button>
          </div>

          <h3>粘贴 AI 返回的 JSON</h3>
          <p>支持去掉一层 Markdown 代码围栏。未知编号、未知字段、过期或锁定字段只会拒绝对应条目。</p>
          <textarea
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            style={{ minHeight: 200, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
            aria-label="AI 回复"
            placeholder='{"protocolVersion":2,"batchId":"…","part":1,"results":[…]}'
          />
          <p className="alert">{error}</p>
          <div className="actions">
            <button className="btn primary" onClick={() => void validate()} disabled={busy || !reply.trim()}>
              {busy ? '校验中…' : '校验并预览 →'}
            </button>
          </div>
        </div>
      ) : null}

      {step === 3 && pack ? (
        <div className="panel">
          <h2>逐条确认修改</h2>
          <p>
            可应用 {accepted.length} 条 · 需处理 {rejected.length} 条 · 漏项保持不变
            {appliedCount !== null ? ` · 已应用 ${appliedCount} 条` : ''}
          </p>
          {warnings.map((warning) => (
            <Notice key={warning}>{warning}</Notice>
          ))}
          {accepted.length === 0 && rejected.length === 0 ? <Notice>回复中没有可识别的结果。</Notice> : null}

          {accepted.map((item) => (
            <div className="diff" key={`ok-${item.n}`}>
              <label className="checkline">
                <input
                  type="checkbox"
                  checked={!excluded.has(item.n)}
                  onChange={(event) =>
                    setExcluded((previous) => {
                      const next = new Set(previous);
                      if (event.target.checked) next.delete(item.n);
                      else next.add(item.n);
                      return next;
                    })
                  }
                />
                <b>
                  #{item.n} {item.bookmark.title}
                </b>
                <span className="good">可应用</span>
              </label>
              <div className="diff-grid">
                <div>
                  <small>当前分类</small>
                  <p>
                    {data.categories.find((category) => category.id === item.bookmark.categoryId)?.name ??
                      '未分类'}
                  </p>
                </div>
                <div>
                  <small>建议分类</small>
                  <p>
                    {item.patch.categoryId === undefined
                      ? '不修改'
                      : item.patch.categoryId === null
                        ? '未分类'
                        : data.categories.find((category) => category.id === item.patch.categoryId)?.name ??
                          '（未知分类，将被拒绝）'}
                  </p>
                </div>
              </div>
              {item.patch.aiPurpose ? <p>用途建议：{item.patch.aiPurpose}</p> : null}
              <p className="micro">模型理由：{item.reason}</p>
            </div>
          ))}

          {rejected.map((item) => (
            <div className="diff" key={`bad-${item.n}-${item.reason}`}>
              <label className="checkline">
                <input type="checkbox" disabled />
                <b>
                  #{item.n} {item.title || '未知条目'}
                </b>
                <span className="bad">{item.reason}</span>
              </label>
            </div>
          ))}

          <p className="alert">{error}</p>
          <div className="actions">
            <button className="btn" onClick={() => setStep(2)}>
              返回修正
            </button>
            <button className="btn primary" onClick={() => void apply()} disabled={busy || accepted.length === 0}>
              {busy ? '应用中…' : '应用勾选项'}
            </button>
            <button className="btn" onClick={() => void revert()} disabled={busy || appliedCount === null}>
              撤销本次应用
            </button>
          </div>
          {revertResult ? (
            <div className="notice" aria-label="撤销结果">
              已撤销 {revertResult.reverted} 条
              {revertResult.conflicts.length > 0
                ? `；${revertResult.conflicts.length} 条未撤销（应用后又被修改，不覆盖）`
                : ''}
              。
            </div>
          ) : null}
          <p className="micro">
            每条建议单独提交一个事务，并在应用日志中留下前后值与版本；撤销只在「应用后没有再改过」时写回，
            否则记为冲突并保持现状。
          </p>
        </div>
      ) : null}
    </>
  );
}

function MaterialPicker({
  items,
  categories,
  selected,
  onChange,
  onClose,
}: {
  items: Bookmark[];
  categories: { id: string; name: string }[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((bookmark) => {
      if (category === 'selected' && !selected.has(bookmark.id)) return false;
      if (category && category !== 'selected' && bookmark.categoryId !== category) return false;
      if (!term) return true;
      return [bookmark.title, bookmark.sourceDescription, bookmark.note]
        .join(' ')
        .toLowerCase()
        .includes(term);
    });
  }, [items, search, category, selected]);

  const selectAllVisible = () => {
    const next = new Set(selected);
    for (const bookmark of visible) next.add(bookmark.id);
    onChange(next);
  };

  const unselectVisible = () => {
    const next = new Set(selected);
    for (const bookmark of visible) next.delete(bookmark.id);
    onChange(next);
  };

  return (
    <div className="modalshade" role="presentation">
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="picker-title">
        <div className="modalheader">
          <h2 id="picker-title">选择提问资料</h2>
          <button className="btn small" onClick={onClose}>
            完成
          </button>
        </div>
        <p className="micro">
          按分类筛选或搜索标题、描述与备注。跨分类勾选会保留；本地专用和禁止 AI 的条目不在列表中。
        </p>
        <div className="two">
          <input
            placeholder="搜索资料…"
            aria-label="搜索资料"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select aria-label="分类筛选" value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">全部分类</option>
            <option value="selected">仅已选（{selected.size}）</option>
            {categories.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
        <div className="toolbar">
          <span className="micro">匹配 {visible.length} 条</span>
          <span className="spacer" />
          <button className="btn small" onClick={selectAllVisible}>
            全选匹配集
          </button>
          <button className="btn small" onClick={unselectVisible}>
            取消匹配集选择
          </button>
          <button className="btn small" onClick={() => onChange(new Set())}>
            清空已选
          </button>
        </div>
        <div style={{ maxHeight: '48vh', overflow: 'auto' }}>
          {visible.length === 0 ? <p className="micro">没有匹配资料，试试其他分类或关键词。</p> : null}
          {visible.map((bookmark) => (
            <label className="checkline" key={bookmark.id} style={{ padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
              <input
                type="checkbox"
                checked={selected.has(bookmark.id)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(bookmark.id);
                  else next.delete(bookmark.id);
                  onChange(next);
                }}
              />
              <span>
                <b>{bookmark.title}</b>
                <small className="micro" style={{ display: 'block' }}>
                  {categories.find((entry) => entry.id === bookmark.categoryId)?.name ?? '未分类'} ·{' '}
                  {domainOf(bookmark.originalUrl)}
                </small>
              </span>
            </label>
          ))}
        </div>
        <div className="actions">
          <span className="micro">已选 {selected.size} 条 · 选择不等于授权发送</span>
          <button className="btn primary" onClick={onClose}>
            完成选择
          </button>
        </div>
      </div>
    </div>
  );
}

export function AskPage() {
  const { data, service, toast, navigate } = useWorkspace();
  const [question, setQuestion] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pack, setPack] = useState<{ text: string; chars: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const eligible = data.bookmarks.filter((bookmark) => isAiEligible(bookmark));
  const chosen = eligible.filter((bookmark) => selected.has(bookmark.id));

  /**
   * 隐私开关或删除状态一变，已不合格的资料必须立即移出选择集。
   * 否则「已选 N 条」会把看不见的条目算进去，与真正能生成的资料不一致。
   */
  useEffect(() => {
    setSelected((previous) => {
      const allowed = new Set(data.bookmarks.filter((bookmark) => isAiEligible(bookmark)).map((bookmark) => bookmark.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of previous) {
        if (allowed.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : previous;
    });
  }, [data.bookmarks]);

  const generate = async () => {
    setError('');
    setBusy(true);
    try {
      const result = await service.buildAskPack({
        question,
        bookmarkIds: [...selected],
      });
      setPack({ text: result.text, chars: result.chars });
    } catch (cause) {
      setError(toUserMessage(cause));
      setPack(null);
    } finally {
      setBusy(false);
    }
  };

  const recallByQuestion = async () => {
    if (!question.trim()) {
      toast('先写下问题，再做本地检索。', 'error');
      return;
    }
    const hits = await service.search(question);
    const top = hits.slice(0, 12);
    setSelected((previous) => {
      const next = new Set(previous);
      for (const hit of top) {
        if (eligible.some((bookmark) => bookmark.id === hit.bookmarkId)) next.add(hit.bookmarkId);
      }
      return next;
    });
    toast(`本地关键词召回 ${top.length} 条，已加入已选；这只是检索，不是语义理解。`);
  };

  return (
    <>
      <PageHeader
        title="问一问，已有的收藏。"
        description="选择资料后生成提问包，或不启用内置 AI 时在外部查看回答。"
        action={
          <button className="btn" onClick={() => navigate('ai')}>
            ← 返回 AI 助手
          </button>
        }
      />
      <div className="panel">
        <h2>你想了解什么？</h2>
        <label className="field">
          <span>问题（最多 {LIMITS.questionChars} 字符）</span>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="例如：有哪些资料适合实现阅读器分页？"
          />
          <small>{codePointLength(question)} / {LIMITS.questionChars}</small>
        </label>
        <div className="notice">
          <span className="tag">已选 {chosen.length} 条资料</span>
          <span className="micro">
            {chosen.slice(0, 3).map((bookmark) => bookmark.title).join(' · ')}
            {chosen.length > 3 ? ' …' : ''}
          </span>
          <button className="btn small" onClick={() => setPickerOpen(true)}>
            选择资料
          </button>
          <button className="btn small" onClick={() => void recallByQuestion()}>
            按问题检索
          </button>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setPickerOpen(true)} disabled={!eligible.length}>
            选择资料
          </button>
          <button className="btn primary" onClick={() => void generate()} disabled={busy || chosen.length === 0}>
            {busy ? '生成中…' : '生成提问包'}
          </button>
        </div>
        <p className="alert">{error}</p>
      </div>

      {pack ? (
        <div className="panel">
          <h2>提问包</h2>
          <p>
            {pack.chars} 字符 · 已选 {chosen.length} 条 · 复制到外部 AI 使用，回答不需要导回。
          </p>
          <pre className="code">{pack.text}</pre>
          <div className="actions">
            <button
              className="btn"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(pack.text);
                  toast('提问包已复制。');
                } catch {
                  toast('剪贴板不可用，请直接选中文本复制。', 'error');
                }
              }}
            >
              复制提问包
            </button>
          </div>
        </div>
      ) : null}

      <div className="panel">
        <h2>回答区</h2>
        <p className="micro">
          内置 AI 未启用时，回答在你使用的外部 AI 中查看。回答区保留给已启用的内置通道，资料列表不会挤占这里。
        </p>
        <div className="notice">
          尚未接入真实模型；本版本不会自动发送所选资料，也不会生成固定或模拟回答。
        </div>
      </div>

      {pickerOpen ? (
        <MaterialPicker
          items={eligible}
          categories={data.categories}
          selected={selected}
          onChange={setSelected}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </>
  );
}
