import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LIMITS,
  computeStats,
  foldersOf,
  newId,
  toUserMessage,
  type ImportDestination,
  type ImportParseResult,
  type ImportRow,
  type ImportUndoItem,
} from '@shiye/core';
import type { ImportUndoPreview } from '@shiye/application';
import { KeptList, PageHeader, Notice } from './components.js';
import { useWorkspace } from './state.js';

let pendingPaste = '';

export function setPendingPaste(text: string): void {
  pendingPaste = text;
}

export function takePendingPaste(): string {
  const text = pendingPaste;
  pendingPaste = '';
  return text;
}

interface PreviewState {
  rows: ImportRow[];
  entries: ImportParseResult['entries'];
  warnings: ImportParseResult['warnings'];
  fileName: string;
  fileHash: string | null;
  mode: 'paste' | 'bookmarkHtml';
  destination: ImportDestination;
  batchId: string;
}

export function CapturePage({ initialMode = 'paste' }: { initialMode?: 'paste' | 'file' }) {
  const { service, data, navigate, run, toast } = useWorkspace();
  const [mode, setMode] = useState<'paste' | 'file'>(initialMode);
  const [text, setText] = useState(() => takePendingPaste());
  const [fileName, setFileName] = useState('');
  // 默认目标跟着入口走：浏览器书签本质是「收藏」，导入收藏夹就该进收藏库。
  // 之前统一默认成待看，用户不手动改下拉，整批书签会静默进待看——
  // 而待看没有分类字段，目录映射区也不渲染，看起来就像「分类丢了」。
  const [destination, setDestination] = useState<ImportDestination>(
    initialMode === 'file' ? 'library' : 'reading'
  );
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [view, setView] = useState<'all' | 'new' | 'duplicate' | 'invalid'>('all');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ inserted: number; skipped: number; skippedReasons: { line: number; reason: string }[]; destination: ImportDestination; batchId: string } | null>(null);
  const [undone, setUndone] = useState<{ removed: number; kept: number; missing: number; items: ImportUndoItem[] } | null>(null);
  /** 撤回前先预演：结果面板上直接写清楚会删几条、留几条。 */
  const [pendingUndo, setPendingUndo] = useState<ImportUndoPreview | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!preview) return;
    // 切换目标后必须按新目标重新计算去重，并重置选择。
    let cancelled = false;
    void (async () => {
      const plan = await service.buildImportPlan(
        preview.entries,
        destination,
        new Map(Object.entries(mapping).filter(([, value]) => Boolean(value)))
      );
      if (cancelled) return;
      setPreview({ ...preview, rows: plan.rows, destination, batchId: preview.batchId });
      setView('all');
    })();
    return () => {
      cancelled = true;
    };
    // 只在目标变化时重算，避免输入时抖动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination]);

  const stats = useMemo(() => computeStats(preview?.rows ?? []), [preview]);
  const autoPreviewed = useRef(false);

  const parse = async (source?: { mode: 'bookmarkHtml'; text: string; fileName: string }) => {
    setError('');
    setResult(null);
    setUndone(null);
    setBusy(true);
    try {
      if (source) {
        const next = await service.previewImport({
          mode: 'bookmarkHtml',
          text: source.text,
          fileName: source.fileName,
          destination,
        });
        setPreview({
          rows: next.plan.rows,
          entries: next.entries,
          warnings: next.warnings,
          fileName: next.fileName,
          fileHash: next.fileHash,
          mode: 'bookmarkHtml',
          destination,
          batchId: newId(),
        });
      } else {
        if (!text.trim()) {
          setError('请先粘贴链接。');
          return;
        }
        const next = await service.previewImport({
          mode: 'paste',
          text,
          destination,
        });
        setPreview({
          rows: next.plan.rows,
          entries: next.entries,
          warnings: next.warnings,
          fileName: next.fileName,
          fileHash: next.fileHash,
          mode: 'paste',
          destination,
          batchId: newId(),
        });
      }
      setView('all');
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 从首页「预览链接」带着粘贴内容进来时直接出预览。
   * 首页那一步已经把「粘贴→预览」表达完了，落到这里再让用户点一次同名按钮是多余的。
   */
  useEffect(() => {
    if (autoPreviewed.current) return;
    autoPreviewed.current = true;
    if (initialMode === 'paste' && text.trim()) void parse();
    // 只在挂载时判定一次，之后由用户主动触发解析。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFile = async (file: File | undefined) => {
    setError('');
    if (!file) return;
    if (file.size > LIMITS.importFileBytes) {
      setError('文件超过 3 MB，请拆分后导入。');
      return;
    }
    setFileName(file.name);
    const content = await file.text();
    await parse({ mode: 'bookmarkHtml', text: content, fileName: file.name });
  };

  const toggle = (sourceKey: string, checked: boolean) => {
    if (!preview) return;
    setPreview({
      ...preview,
      rows: preview.rows.map((row) =>
        row.sourceKey === sourceKey && row.status === 'new' ? { ...row, selected: checked } : row
      ),
    });
  };

  const selectAllNew = () => {
    if (!preview) return;
    setPreview({ ...preview, rows: preview.rows.map((row) => ({ ...row, selected: row.status === 'new' })) });
  };

  const clearAll = () => {
    if (!preview) return;
    setPreview({ ...preview, rows: preview.rows.map((row) => ({ ...row, selected: false })) });
  };

  const setFolderMapping = (folder: string, categoryId: string) => {
    if (!preview) return;
    const nextMapping = { ...mapping, [folder]: categoryId };
    setMapping(nextMapping);
    setPreview({
      ...preview,
      rows: preview.rows.map((row) =>
        row.sourceFolder === folder ? { ...row, targetCategoryId: categoryId || null } : row
      ),
    });
  };

  const commit = async () => {
    if (!preview) return;
    const selected = preview.rows.filter((row) => row.selected && row.status === 'new');
    if (selected.length === 0) {
      setError('请至少勾选一条可新增的条目。');
      return;
    }
    setError('');
    setBusy(true);
    const committed = await run(() =>
      service.commitImport({
        batchId: preview.batchId,
        source: preview.mode,
        fileName: preview.fileName,
        fileHash: preview.fileHash,
        destination: preview.destination,
        rows: preview.rows,
      })
    );
    setBusy(false);
    if (!committed) return;
    setUndone(null);
    setResult({
      inserted: committed.inserted,
      skipped: committed.skipped,
      skippedReasons: committed.skippedReasons,
      destination: preview.destination,
      batchId: preview.batchId,
    });
    setPreview(null);
    setText('');
    toast(`已保存 ${committed.inserted} 条，跳过 ${committed.skipped} 条。`);
  };

  /**
   * 撤销刚才这一批。
   *
   * 只删「导入后原样留着」的条目：改过的、应用过 AI 的、转成收藏的会保留并如实报数。
   * 撤销后同时清掉这批的删除标记，否则同一批书签重新导入会被自己留下的墓碑挡住。
   */
  const startUndo = async () => {
    if (!result) return;
    setBusy(true);
    try {
      setPendingUndo(await service.previewUndoImport(result.batchId));
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const undoImport = async (preview: ImportUndoPreview) => {
    setBusy(true);
    const outcome = await run(() => service.undoImport(preview.batch.id));
    setBusy(false);
    setPendingUndo(null);
    if (!outcome) return;
    setUndone({
      removed: outcome.removed,
      kept: outcome.kept,
      missing: outcome.missing,
      items: outcome.items,
    });
    setResult(null);
  };

  const visibleRows = (preview?.rows ?? []).filter((row) => (view === 'all' ? true : row.status === view));
  const folders = preview && preview.destination === 'library' ? foldersOf(preview.rows) : [];

  return (
    <>
      <PageHeader
        title={mode === 'paste' ? '粘贴链接' : '导入浏览器收藏夹'}
        description="先核对，再保存。重复与无效链接会逐行说明。"
        action={
          <button className="btn" onClick={() => navigate('home')}>
            ← 返回首页
          </button>
        }
      />

      <div className="toolbar">
        <button
          className={`chip ${mode === 'paste' ? 'active' : ''}`}
          onClick={() => {
            setMode('paste');
            setDestination('reading');
            setPreview(null);
            setResult(null);
          }}
        >
          粘贴链接
        </button>
        <button
          className={`chip ${mode === 'file' ? 'active' : ''}`}
          onClick={() => {
            setMode('file');
            setDestination('library');
            setPreview(null);
            setResult(null);
          }}
        >
          导入收藏夹
        </button>
      </div>

      {result ? (
        <div className="panel">
          <h2>导入完成</h2>
          <div className="stats">
            <div className="stat">
              <strong>{result.inserted}</strong>
              <span>条新增</span>
            </div>
            <div className="stat">
              <strong>{result.skipped}</strong>
              <span>条跳过</span>
            </div>
          </div>
          {result.skippedReasons.length ? (
            <div className="notice">
              <strong>跳过的条目</strong>
              {result.skippedReasons.map((entry) => (
                <span key={`${entry.line}-${entry.reason}`}>
                  第 {entry.line} 行：{entry.reason}
                </span>
              ))}
            </div>
          ) : null}
          <div className="actions">
            <button className="btn" onClick={() => setResult(null)}>
              继续导入
            </button>
            <button
              className="btn primary"
              onClick={() => navigate(result.destination === 'reading' ? 'reading' : 'inbox')}
            >
              查看保存结果 →
            </button>
            {result.inserted > 0 ? (
              // 误选了「待看」或导错了文件时，这是最直接的一步：把刚建出来的条目整批撤掉，
              // 不必去列表里逐条删，也不会留下挡住重新导入的痕迹。
              <button className="btn danger" onClick={() => void startUndo()} disabled={busy}>
                {busy ? '正在预演…' : '撤回这次导入'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {pendingUndo ? (
        <Notice tone="danger">
          <strong>确认撤回「{pendingUndo.batch.fileName}」？</strong>
          <span>
            将移除 {pendingUndo.removed} 条，保留 {pendingUndo.kept} 条
            {pendingUndo.missing > 0 ? `，另有 ${pendingUndo.missing} 条已不在库里` : ''}。
          </span>
          {pendingUndo.blockedReason ? <span>{pendingUndo.blockedReason}</span> : null}
          <KeptList items={pendingUndo.items} />
          <button
            className="btn small danger"
            disabled={busy}
            onClick={() => void undoImport(pendingUndo)}
          >
            {busy ? '撤回中…' : `确认撤回 ${pendingUndo.removed} 条`}
          </button>
          <button className="btn small" onClick={() => setPendingUndo(null)}>
            取消
          </button>
        </Notice>
      ) : null}

      {undone ? (
        <Notice tone="ok">
          <strong>
            已撤回这次导入：移除 {undone.removed} 条，保留 {undone.kept} 条
            {undone.missing > 0 ? `，${undone.missing} 条已不在库里` : ''}。
          </strong>
          <KeptList items={undone.items} />
          <span>这批的删除标记也一并清掉了，同一批书签可以重新导入。</span>
          <span>批次记录里也留着这次撤回的时间与条数，可以在「数据与备份」页回查。</span>
        </Notice>
      ) : null}

      <div className="panel">
        {mode === 'paste' ? (
          <>
            <h2>一次收下多个链接</h2>
            <p>一行一个，先预览状态；不会联网抓取标题，也不会自动打开链接。</p>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={'https://developer.apple.com/documentation/swift\nhttps://github.com/example/project'}
              style={{ minHeight: 150 }}
              aria-label="粘贴链接"
            />
            <div className="actions">
              <button
                className="btn"
                onClick={() =>
                  setText(
                    'https://developer.apple.com/documentation/swift\nhttps://github.com/example/project\nhttps://github.com/example/project\ninvalid-link'
                  )
                }
              >
                填入示例
              </button>
              <button className="btn primary" onClick={() => void parse()} disabled={busy}>
                {busy ? '解析中…' : '预览链接 →'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>选择浏览器导出的书签 HTML</h2>
            <p>在 Chrome / Edge 书签管理器中导出 HTML 后再选择文件。导入只是一次复制，不会修改浏览器收藏夹。</p>
            <label className="field">
              <span>书签文件</span>
              <input
                ref={fileRef}
                type="file"
                accept=".html,.htm,text/html"
                onChange={(event) => void onFile(event.target.files?.[0])}
              />
              <small>
                仅在当前页面本地解析；上限 3 MB、每批 {LIMITS.importRows} 条，不执行文件脚本、不加载图片或样式。
              </small>
            </label>
            {fileName ? <p className="micro">已选择：{fileName}</p> : null}
            <div className="actions">
              <button className="btn primary" onClick={() => fileRef.current?.click()} disabled={busy}>
                {busy ? '解析中…' : '选择文件并解析 →'}
              </button>
            </div>
          </>
        )}
        <p className="alert" role="alert">
          {error}
        </p>
      </div>

      {preview?.warnings.length ? (
        <Notice tone="danger">
          {preview.warnings.map((warning) => (
            <span key={`${warning.code}-${warning.message}`}>{warning.message}</span>
          ))}
        </Notice>
      ) : null}

      {preview ? (
        <div className="panel">
          <div className="sectiontitle" style={{ marginTop: 0 }}>
            <h2>核对导入内容</h2>
            <span>{preview.fileName}</span>
          </div>

          <div className="stats">
            <div className="stat">
              <strong>{stats.total}</strong>
              <span>总条数</span>
            </div>
            <div className="stat">
              <strong>{stats.newCount}</strong>
              <span>可新增</span>
            </div>
            <div className="stat">
              <strong>{stats.duplicate}</strong>
              <span>重复</span>
            </div>
            <div className="stat">
              <strong>{stats.invalid}</strong>
              <span>无效</span>
            </div>
            {stats.suspected ? (
              <div className="stat">
                <strong>{stats.suspected}</strong>
                <span>需确认</span>
              </div>
            ) : null}
          </div>

          <div className="two">
            <label className="field">
              <span>保存到</span>
              <select
                value={destination}
                onChange={(event) => setDestination(event.target.value as ImportDestination)}
                aria-label="保存目标"
              >
                <option value="reading">待看 · 暂不分类</option>
                <option value="library">收藏库 · 进入收件箱</option>
              </select>
            </label>
            <div className="notice">
              {destination === 'reading'
                ? '只是想找时间看一眼？先放到待看，看完再决定是否收藏。切换目标会重新去重并重置勾选。'
                : '保存后进入收件箱。原目录会保留为来源信息；分类可在下方逐组映射。切换目标会重新去重并重置勾选。'}
            </div>
          </div>

          {destination === 'library' ? (
            folders.length ? (
              <>
                <h3>目录与分类</h3>
                <p className="micro">不会自动新建分类；可为每个原目录选择目标分类，也可以保持未分类。</p>
                <div style={{ overflowX: 'auto' }}>
                  <table className="capturetable">
                    <thead>
                      <tr>
                        <th>原目录</th>
                        <th>可新增</th>
                        <th>保存至分类</th>
                      </tr>
                    </thead>
                    <tbody>
                      {folders.map((folder) => (
                        <tr key={folder.folder || 'none'}>
                          <td>{folder.folder || '无目录 / 粘贴链接'}</td>
                          <td>{folder.count}</td>
                          <td>
                            <select
                              aria-label={`${folder.folder || '无目录'} 的目标分类`}
                              value={mapping[folder.folder] ?? ''}
                              onChange={(event) => setFolderMapping(folder.folder, event.target.value)}
                            >
                              <option value="">未分类</option>
                              {data.categories.map((category) => (
                                <option key={category.id} value={category.id}>
                                  {category.name}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null
          ) : null}

          <div className="toolbar">
            {(
              [
                ['all', '全部'],
                ['new', '可新增'],
                ['duplicate', '重复'],
                ['invalid', '无效'],
              ] as const
            ).map(([key, label]) => (
              <button key={key} className={`chip ${view === key ? 'active' : ''}`} onClick={() => setView(key)}>
                {label}
              </button>
            ))}
            <span className="spacer" />
            <span className="micro">已选 {stats.selected} 条</span>
            <button className="btn small" onClick={selectAllNew}>
              全选可新增
            </button>
            <button className="btn small" onClick={clearAll}>
              清空选择
            </button>
          </div>

          <div style={{ maxHeight: '46vh', overflow: 'auto' }}>
            <table className="capturetable">
              <thead>
                <tr>
                  <th>选择</th>
                  <th>标题 / 完整链接</th>
                  <th>状态</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.length === 0 ? (
                  <tr>
                    <td colSpan={4}>当前筛选没有条目。</td>
                  </tr>
                ) : (
                  visibleRows.map((row) => (
                    <tr key={row.sourceKey}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`选择第 ${row.line} 行 ${row.title}`}
                          checked={row.selected}
                          disabled={row.status !== 'new'}
                          onChange={(event) => toggle(row.sourceKey, event.target.checked)}
                        />
                      </td>
                      <td style={{ minWidth: 260 }}>
                        <b>{row.title}</b>
                        <div className="url">{row.originalUrl}</div>
                        {row.sourceFolder ? <div className="url">原目录：{row.sourceFolder}</div> : null}
                      </td>
                      <td>
                        <span
                          className={
                            row.status === 'new'
                              ? 'status-new'
                              : row.status === 'duplicate'
                                ? 'status-duplicate'
                                : row.status === 'suspected'
                                  ? 'status-suspected'
                                  : 'status-invalid'
                          }
                        >
                          {row.status === 'new'
                            ? '新增'
                            : row.status === 'duplicate'
                              ? '重复'
                              : row.status === 'suspected'
                                ? '需确认'
                                : '无效'}
                        </span>
                      </td>
                      <td className="micro">{row.reason}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="batchbar">
            <span>
              将写入 {stats.selected} 条到{destination === 'reading' ? '待看' : '收藏库'} · 未勾选与无效行不会入库
            </span>
            <button className="btn" onClick={() => setPreview(null)}>
              取消预览
            </button>
            <button className="btn primary" onClick={() => void commit()} disabled={busy || stats.selected === 0}>
              {busy ? '写入中…' : '确认写入'}
            </button>
          </div>
          <p className="micro">
            写入在一个数据库事务中完成；失败会整体回滚。重复点击不会重复新增，批次 ID 稳定为 {preview.batchId.slice(0, 8)}…
          </p>
        </div>
      ) : null}
    </>
  );
}
