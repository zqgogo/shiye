import { useEffect, useState } from 'react';
import {
  backupFileName,
  formatDateTime,
  isBatchCleanupActionable,
  parseBackup,
  toUserMessage,
  type BackupDocument,
  type BatchCleanupMode,
  type BatchCleanupPreview,
  type BatchCleanupResult,
  type BatchEntryState,
  type BatchEntryView,
  type ImportBatch,
  type PurgeSnapshot,
  type PurgeSnapshotDetail,
} from '@shiye/core';
import type { ImportBatchPage, ImportUndoPreview, ImportUndoResult } from '@shiye/application';
import { KeptList, Notice, PageHeader, NO_FOLDER, BATCH_STATE_LABEL } from './components.js';
import { useWorkspace } from './state.js';

function download(name: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 明细分页步长：默认列这么多，剩下的点按钮再列，避免一次把几千条塞进 DOM。 */
const DETAIL_PAGE = 50;

/** 一条都处理不了时说清是哪一种情况，而不是笼统地让人以为条件选错了。 */
function emptyCleanupHint(preview: BatchCleanupPreview): string {
  if (preview.matched === 0) return '当前筛选没有命中任何记录。';
  if (preview.mode === 'trash' && preview.byState.trashed === preview.matched) {
    return `匹配的 ${preview.byState.trashed} 条都在回收站里。要彻底删除并重新导入，请用「彻底删除」。`;
  }
  if (preview.byState.missing === preview.matched) return '匹配的记录都已经不在库里了，没有可删的东西。';
  if (preview.batch.destination === 'reading') {
    return '这些待看已经转成收藏或已完成，不在这个入口处理；转成收藏的请到收藏侧清理。';
  }
  return '这些记录不在这个动作的处理范围里。';
}

/**
 * 数据与备份。
 *
 * focus='cleanup' 来自「清空完成后」的提示按钮（路由 data:cleanup）：进页面直接滚到
 * 「最近清理」，不用让用户自己在长页面里找。
 */
export function DataPage({ focus }: { focus?: 'cleanup' } = {}) {
  const { data, service, run, reload, toast } = useWorkspace();
  const [includeLocalOnly, setIncludeLocalOnly] = useState(false);
  const [includeNote, setIncludeNote] = useState(true);
  const [includeText, setIncludeText] = useState(false);
  const [restoreFile, setRestoreFile] = useState<{ name: string; text: string } | null>(null);
  const [parsed, setParsed] = useState<BackupDocument | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | {
        mode: 'merge' | 'replace';
        bookmarksAdded: number;
        bookmarksSkipped: number;
        readingAdded: number;
        readingSkipped: number;
        tombstonesAdded: number;
        danglingReferences: number;
        handoffInvalidated: number;
        keptLocalDeletes: number;
        adoptedSettings: boolean;
        librarySwitch: { from: string; to: string } | null;
        safety: { exportedAt: string; bookmarks: number; reading: number; categories: number; tags: number } | null;
        warnings: string[];
      }
    | null
  >(null);
  /** 上一次替换前落库的安全备份：下载被拦或页面被关之后，还在这里。 */
  const [safetyCopy, setSafetyCopy] = useState<{ id: string; text: string; savedAt: string } | null>(
    null
  );
  /** 导入批次历史：支持搜索与分页，撤销入口要靠它找回「那一份文件」，而不是只给最近几批。 */
  const [batches, setBatches] = useState<ImportBatchPage | null>(null);
  const [batchSearch, setBatchSearch] = useState('');
  const [batchLimit, setBatchLimit] = useState(20);
  const [snapshots, setSnapshots] = useState<PurgeSnapshot[] | null>(null);
  /** 「看看能找回什么」：把这一份快照里删掉的条目逐条列出来，可按关键词 / 类型 / 状态 / 目录 / 站点筛。 */
  const [snapshotDetail, setSnapshotDetail] = useState<PurgeSnapshotDetail | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState('');
  const [snapshotSearch, setSnapshotSearch] = useState('');
  const [snapshotKind, setSnapshotKind] = useState<'' | 'bookmark' | 'reading'>('');
  const [snapshotStatus, setSnapshotStatus] = useState<'' | 'restore' | 'skip' | 'conflict'>('');
  const [snapshotFolder, setSnapshotFolder] = useState('');
  const [snapshotHost, setSnapshotHost] = useState('');
  const [snapshotSelected, setSnapshotSelected] = useState<string[]>([]);
  const [snapshotLimit, setSnapshotLimit] = useState(DETAIL_PAGE);
  const [undoing, setUndoing] = useState('');
  /** 待确认的撤回：先预演，把「会删几条、留几条」直接摆在确认按钮旁边。 */
  const [pendingUndo, setPendingUndo] = useState<ImportUndoPreview | null>(null);
  /** 刚执行完的撤回结果：常驻在页面上，不放 toast，也不随刷新丢掉。 */
  const [undoResult, setUndoResult] = useState<ImportUndoResult | null>(null);
  /** 预览数与实际执行数的差异：并发保护生效时如实报出来，而不是假装两边一致。 */
  const [undoDrift, setUndoDrift] = useState<{ previewRemoved: number; actualRemoved: number } | null>(null);
  /** 「查看本批」：这一批实际新建的记录与现状，按目录 / 站点 / 状态筛。 */
  const [detail, setDetail] = useState<BatchEntryView | null>(null);
  const [detailBusy, setDetailBusy] = useState('');
  const [folderFilter, setFolderFilter] = useState('');
  const [siteFilter, setSiteFilter] = useState('');
  const [stateFilter, setStateFilter] = useState<'all' | BatchEntryState>('untouched');
  /** 冻结后的处理范围：确认框里的数字就是它，执行时也只认它。 */
  const [cleanupPreview, setCleanupPreview] = useState<BatchCleanupPreview | null>(null);
  const [cleanupMode, setCleanupMode] = useState<BatchCleanupMode | null>(null);
  const [cleanupResult, setCleanupResult] = useState<BatchCleanupResult | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState('');
  /** 明细一次列多少条：大批次一次铺满 DOM 会卡，但又不能只给前 50 条不给后路。 */
  const [detailLimit, setDetailLimit] = useState(DETAIL_PAGE);

  const reloadBatches = async (options?: { search?: string; limit?: number }) => {
    const search = options?.search ?? batchSearch;
    const limit = options?.limit ?? batchLimit;
    try {
      setBatches(await service.listImportBatches({ search, limit }));
    } catch {
      setBatches({ rows: [], total: 0, hasMore: false });
    }
  };

  /** 打开一份快照的明细：筛选与勾选都要跟着重置，不能把上一份快照的条件带过来。 */
  const openSnapshotDetail = async (snapshotId: string) => {
    setSnapshotBusy(snapshotId);
    try {
      setSnapshotDetail(await service.readPurgeSnapshotDetail(snapshotId));
      setSnapshotSearch('');
      setSnapshotKind('');
      setSnapshotStatus('');
      setSnapshotFolder('');
      setSnapshotHost('');
      setSnapshotSelected([]);
      setSnapshotLimit(DETAIL_PAGE);
    } catch (error) {
      toast(toUserMessage(error), 'error');
    } finally {
      setSnapshotBusy('');
    }
  };

  /**
   * 只找回传进来的这几条：界面要么传勾选的，要么传当前筛选里可找回的。
   * 判定在事务内重算，预览之后刚被重新导入或刚被删掉的条目会按最新状态跳过。
   */
  const runPurgeRestore = async (ids: string[]) => {
    if (!snapshotDetail || ids.length === 0) return;
    setSnapshotBusy(snapshotDetail.snapshotId);
    try {
      const outcome = await service.restorePurgeSnapshot(snapshotDetail.snapshotId, ids);
      toast(
        `找回 ${outcome.restored} 条；跳过 ${outcome.preview.skipped} 条、冲突 ${outcome.preview.conflicted} 条。`,
        'ok'
      );
      setSnapshotDetail(null);
      setSnapshotSelected([]);
      await reload();
    } catch (error) {
      toast(toUserMessage(error), 'error');
    } finally {
      setSnapshotBusy('');
    }
  };

  useEffect(() => {
    void reloadBatches();
    void service
      .listPurgeSnapshots()
      .then(setSnapshots)
      .catch(() => setSnapshots([]));
    // 主库变化（导入、撤销、清理、恢复）后批次与清理快照都要跟着变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, data.bookmarks.length, data.pendingReading.length, data.completedReading.length]);

  // 从「清空完成」的提示进来时，直接把「最近清理」滚到视野里。
  // 上面的「最近导入」和快照列表都是异步加载的，内容一到位就把面板往下推；
  // 所以既在快照到货后重滚，也留两次延时校正，免得滚到一半被打回原处。
  useEffect(() => {
    if (focus !== 'cleanup') return;
    const scroll = (behavior: ScrollBehavior) =>
      document.getElementById('recent-cleanup')?.scrollIntoView({ block: 'start', behavior });
    const frame = window.requestAnimationFrame(() => scroll('smooth'));
    // 校正用瞬时滚动：内容加载完时如果还在做平滑动画，会被新高度顶回原处。
    const timers = [window.setTimeout(() => scroll('auto'), 400), window.setTimeout(() => scroll('auto'), 1000)];
    return () => {
      window.cancelAnimationFrame(frame);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [focus, snapshots, batches]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const copy = await service.readSafetyCopy().catch(() => null);
      if (alive) setSafetyCopy(copy);
    })();
    return () => {
      alive = false;
    };
  }, [service]);

  const libraryEmpty =
    data.bookmarks.length === 0 &&
    data.pendingReading.length === 0 &&
    data.categories.length === 0 &&
    data.tags.length === 0;

  const saveSafety = (text: string, savedAt: string) => {
    download(backupFileName(savedAt), text, 'application/json');
  };

  const exportBackup = async () => {
    setBusy(true);
    const bundle = await run(() => service.exportBackup(includeLocalOnly));
    setBusy(false);
    if (!bundle) return;
    download(bundle.fileName, bundle.text, 'application/json');
    toast('已发起下载；请确认文件确实保存到磁盘。');
  };

  const pickRestore = async (file: File | undefined) => {
    setError('');
    setResult(null);
    if (!file) return;
    const text = await file.text();
    setRestoreFile({ name: file.name, text });
    try {
      const raw = JSON.parse(text) as unknown;
      const document = parseBackup(raw) as unknown as BackupDocument;
      setParsed(document);
    } catch (cause) {
      setParsed(null);
      // 直接抛 V8 的 "Unexpected end of JSON input" 对用户没有意义，统一说人话。
      setError(
        cause instanceof SyntaxError
          ? '文件不是有效的 JSON，请确认选对了备份文件。'
          : toUserMessage(cause)
      );
    }
  };

  const doRestore = async () => {
    if (!restoreFile || !parsed) return;
    if (mode === 'replace' && !confirmed) {
      setError('替换整个主库前，请确认已了解影响并勾选确认。');
      return;
    }
    if (mode === 'replace' && safetyCopy) {
      // 服务层也会拒绝（SAFETY_COPY_PENDING）；先在界面上说清楚该做什么，
      // 免得用户点了确认才看到一句「还留着一份备份」。
      setError('上一份替换前的安全备份还没确认保存，请先保存到磁盘并清理本机副本，再做下一次替换。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const outcome = await service.restoreBackup(restoreFile.text, mode);
      const safety = outcome.safety;
      const safetyDoc = safety?.document ?? null;
      setResult({
        mode: outcome.result.mode,
        bookmarksAdded: outcome.result.bookmarksAdded,
        bookmarksSkipped: outcome.result.bookmarksSkipped,
        readingAdded: outcome.result.readingAdded,
        readingSkipped: outcome.result.readingSkipped,
        tombstonesAdded: outcome.result.tombstonesAdded,
        danglingReferences: outcome.result.danglingReferences,
        handoffInvalidated: outcome.result.handoffInvalidated,
        keptLocalDeletes: outcome.result.keptLocalDeletes,
        adoptedSettings: outcome.result.adoptedSettings,
        librarySwitch: outcome.result.librarySwitch,
        safety: safetyDoc
          ? {
              exportedAt: safetyDoc.exportedAt,
              bookmarks: safetyDoc.bookmarks.length,
              reading: safetyDoc.readingItems.length,
              categories: safetyDoc.categories.length,
              tags: safetyDoc.tags.length,
            }
          : null,
        warnings: outcome.result.warnings,
      });
      if (safety) {
        // 备份在替换之前就已经落库，这里只是再发起一次下载；下不下来都不影响取回。
        const savedAt = safetyDoc?.exportedAt ?? new Date().toISOString();
        if (outcome.safetyCopy) setSafetyCopy(outcome.safetyCopy);
        saveSafety(safety.text, savedAt);
      }
      await run(async () => undefined);
      setConfirmed(false);
    } catch (cause) {
      setError(toUserMessage(cause));
      // 替换失败时安全备份仍在 meta 里，立刻把它露出来，别等用户刷新页面才发现。
      const copy = await service.readSafetyCopy().catch(() => null);
      if (copy) setSafetyCopy(copy);
    } finally {
      setBusy(false);
    }
  };

  const exportSnapshot = async () => {    setBusy(true);
    const snapshot = await run(() => service.exportSnapshot({ includeNote, includeText }));
    setBusy(false);
    if (!snapshot) return;
    download(snapshot.fileName, snapshot.html, 'text/html');
    const preview = window.open('', '_blank');
    if (preview) {
      preview.document.write(snapshot.html);
      preview.document.close();
    }
    toast('已导出发送下载，并在新标签页打开预览。');
  };

  /** 点「撤回」先预演：不写库，只把结果算出来给用户看。 */
  const startUndo = async (batch: ImportBatch) => {
    setUndoing(batch.id);
    try {
      const preview = await service.previewUndoImport(batch.id);
      setPendingUndo(preview);
    } catch (error) {
      toast(toUserMessage(error), 'error');
    } finally {
      setUndoing('');
    }
  };

  const undoBatch = async (preview: ImportUndoPreview) => {
    setUndoing(preview.batch.id);
    const outcome = await run(() => service.undoImport(preview.batch.id));
    setUndoing('');
    setPendingUndo(null);
    if (!outcome) return;
    // 结果常驻在页面上：撤回了多少、留下多少、为什么留，都要能一眼看到并回查。
    setUndoResult(outcome);
    setUndoDrift(
      outcome.removed === preview.removed
        ? null
        : { previewRemoved: preview.removed, actualRemoved: outcome.removed }
    );
    await reloadBatches();
  };

  /** 打开「查看本批」：读的是编号映射，不是同目录下的记录。 */
  const openBatchDetail = async (batch: ImportBatch) => {
    setDetailBusy(batch.id);
    try {
      const view = await service.listBatchEntries(batch.id);
      setDetail(view);
      setFolderFilter('');
      setSiteFilter('');
      // 默认只看没动过的：这类才可能被处理，也不会一上来就把已加工的混进计数。
      setStateFilter('untouched');
      setDetailLimit(DETAIL_PAGE);
      setCleanupPreview(null);
      setCleanupMode(null);
      setCleanupResult(null);
    } catch (error) {
      toast(toUserMessage(error), 'error');
    } finally {
      setDetailBusy('');
    }
  };

  /** 先按动作冻结范围再确认：数字来自这次预览，不用界面里可能过期的列表估。 */
  const startCleanup = async (mode: BatchCleanupMode) => {
    if (!detail) return;
    setCleanupBusy(mode);
    setCleanupResult(null);
    try {
      const preview = await service.previewBatchCleanup({
        batchId: detail.batch.id,
        folders: folderFilter ? [folderFilter === NO_FOLDER ? '' : folderFilter] : [],
        sites: siteFilter ? [siteFilter] : [],
        states: stateFilter === 'all' ? [] : [stateFilter],
        mode,
      });
      if (preview.actionable === 0) {
        toast(emptyCleanupHint(preview), 'error');
        return;
      }
      setCleanupPreview(preview);
      setCleanupMode(mode);
    } catch (error) {
      toast(toUserMessage(error), 'error');
    } finally {
      setCleanupBusy('');
    }
  };

  const runCleanup = async () => {
    if (!cleanupPreview) return;
    const batchId = cleanupPreview.batch.id;
    setCleanupBusy(cleanupPreview.mode);
    const outcome = await run(() => service.cleanupBatch(cleanupPreview.token));
    setCleanupBusy('');
    if (!outcome) return;
    setCleanupResult(outcome);
    setCleanupPreview(null);
    setCleanupMode(null);
    try {
      setDetail(await service.listBatchEntries(batchId));
    } catch {
      setDetail(null);
    }
    await reloadBatches();
  };

  const detailRows = detail
    ? detail.rows.filter(
        (row) =>
          (!folderFilter ||
            (folderFilter === NO_FOLDER ? !row.folder : row.folder === folderFilter)) &&
          (!siteFilter || row.site === siteFilter) &&
          (stateFilter === 'all' || row.state === stateFilter)
      )
    : [];
  // 计数必须和仓库用同一个判定：界面写 30 条、实际处理 33 条，是这类功能最典型的翻车方式。
  const destination = detail?.batch.destination ?? 'library';
  const trashableRows = detailRows.filter((row) =>
    isBatchCleanupActionable(row.state, destination, 'trash')
  );
  const deletableRows = detailRows.filter((row) =>
    isBatchCleanupActionable(row.state, destination, 'delete')
  );
  const modifiedRows = detailRows.filter((row) => row.state === 'modified');
  const displayedRows = detailRows.slice(0, detailLimit);
  const hiddenRows = detailRows.length - displayedRows.length;
  // 彻底删除是范围最宽的动作，它都处理不了的就是真的不在这里动（已转收藏 / 已完成 / 已不存在）。
  const outOfScopeRows = detailRows.length - deletableRows.length;

  /* ---------- 「看看能找回什么」的逐条明细 ---------- */

  const snapshotEntries = snapshotDetail?.entries ?? [];
  const snapshotTerm = snapshotSearch.trim().toLowerCase();
  const snapshotFolders = [...new Set(snapshotEntries.map((row) => row.folder).filter(Boolean))] as string[];
  const snapshotHosts = [...new Set(snapshotEntries.map((row) => row.host))].sort((a, b) => a.localeCompare(b));
  const filteredSnapshotEntries = snapshotEntries.filter((row) => {
    if (snapshotKind && row.kind !== snapshotKind) return false;
    // 「已找回」在状态筛选里当作单独一档：它已经不在可找回的范围里了，但仍值得标出来。
    if (snapshotStatus === 'restore' && (row.action !== 'restore' || row.restored)) return false;
    if (snapshotStatus === 'skip' && row.action !== 'skip') return false;
    if (snapshotStatus === 'conflict' && row.action !== 'conflict') return false;
    if (snapshotFolder && (snapshotFolder === NO_FOLDER ? Boolean(row.folder) : row.folder !== snapshotFolder)) {
      return false;
    }
    if (snapshotHost && row.host !== snapshotHost) return false;
    if (snapshotTerm) {
      const haystack = `${row.title} ${row.url} ${row.folder ?? ''} ${row.categoryName ?? ''}`.toLowerCase();
      if (!haystack.includes(snapshotTerm)) return false;
    }
    return true;
  });
  const snapshotPageRows = filteredSnapshotEntries.slice(0, snapshotLimit);
  const snapshotHidden = filteredSnapshotEntries.length - snapshotPageRows.length;
  // 勾选只对「还能回来且还没回来」的条目开放：勾了也回不来的条目不该给出选项。
  const restorableSnapshotEntries = filteredSnapshotEntries.filter((row) => row.action === 'restore' && !row.restored);
  const selectedSnapshotIds = new Set(snapshotSelected);
  // 勾选只来自「可找回」的行，所以勾选数就是这一次要恢复的条数。
  const selectedRestorable = snapshotSelected.length;

  return (
    <>
      <PageHeader title="数据在手里，才放心。" description="完整 JSON 用于恢复，手机 HTML 用于只读查看。" />

      <div className="griddata">
        <div className="panel">
          <h2>完整备份</h2>
          <p>包含收藏、待看与完成状态、分类、标签、策略、设置与墓碑；不包含任何凭据。</p>
          <div className="metric">
            {data.bookmarks.length} <span>条收藏 · {data.pendingReading.length} 条待看</span>
          </div>
          <label className="checkline">
            <input
              type="checkbox"
              checked={includeLocalOnly}
              onChange={(event) => setIncludeLocalOnly(event.target.checked)}
            />
            包含本地专用条目（仅本设备备份）
          </label>
          <button className="btn" onClick={() => void exportBackup()} disabled={busy}>
            导出完整 JSON ↓
          </button>
          <p className="micro" style={{ marginTop: 10 }}>
            发起下载不等于确认文件已保存；请在下载目录核对。
          </p>
        </div>

        <div className="panel">
          <h2>手机只读快照</h2>
          <p>默认排除本地专用与回收站；快照是明文副本，不自动同步。</p>
          <label className="checkline">
            <input
              type="checkbox"
              checked={includeNote}
              onChange={(event) => setIncludeNote(event.target.checked)}
            />
            包含人工备注
          </label>
          <label className="checkline">
            <input
              type="checkbox"
              checked={includeText}
              onChange={(event) => setIncludeText(event.target.checked)}
            />
            包含选中文字
          </label>
          <button className="btn primary" onClick={() => void exportSnapshot()} disabled={busy}>
            导出可搜索 HTML ↓
          </button>
          <p className="micro" style={{ marginTop: 10 }}>
            无脚本时仍展示完整静态列表；筛选只在本文件内生效。
          </p>
        </div>
      </div>

      <div className="panel">
        <h2>最近导入</h2>
        <p>
          导错了文件或选错了目标时，在这里整批撤回。撤回只移除这一批新建的条目；导入后被改过、
          转成收藏、已完成或已进回收站的会保留，并逐条说明原因。
        </p>

        <div className="field">
          <span>搜索批次</span>
          <input
            aria-label="搜索导入批次"
            placeholder="按文件名搜索，例如 bookmarks.html"
            value={batchSearch}
            onChange={(event) => {
              const next = event.target.value;
              setBatchSearch(next);
              void reloadBatches({ search: next });
            }}
          />
        </div>

        {undoResult ? (
          <Notice tone="ok">
            <strong>
              已撤回「{undoResult.batch.fileName}」：移除 {undoResult.removed} 条，保留 {undoResult.kept} 条
              {undoResult.missing > 0 ? `，${undoResult.missing} 条已不在库里` : ''}。
            </strong>
            {undoDrift ? (
              <span>
                预览时是 {undoDrift.previewRemoved} 条，实际移除 {undoDrift.actualRemoved} 条：
                确认前有 {undoDrift.previewRemoved - undoDrift.actualRemoved} 条被修改、转过收藏或删除，已按最新状态保留。
              </span>
            ) : null}
            <KeptList items={undoResult.items} />
            <span>这份结果也存进了批次记录，刷新或关页之后仍能在下面查到。</span>
            <button
              className="btn small"
              onClick={() => {
                setUndoResult(null);
                setUndoDrift(null);
              }}
            >
              知道了
            </button>
          </Notice>
        ) : null}

        {pendingUndo ? (
          <Notice tone="danger">
            <strong>确认撤回「{pendingUndo.batch.fileName}」？</strong>
            <span>
              将移除 {pendingUndo.removed} 条，保留 {pendingUndo.kept} 条
              {pendingUndo.missing > 0 ? `，另有 ${pendingUndo.missing} 条已不在库里` : ''}。
            </span>
            <span className="micro">
              这是此刻的算法结果，不是承诺：执行时会重新读一遍，确认前被修改、转过收藏或删掉的条目会保留，
              实际移除数可能少于这个数字，执行后会如实报出差额。
            </span>
            {pendingUndo.blockedReason ? <span>{pendingUndo.blockedReason}</span> : null}
            <KeptList items={pendingUndo.items} />
            <button
              className="btn small danger"
              disabled={Boolean(undoing)}
              onClick={() => void undoBatch(pendingUndo)}
            >
              {undoing ? '撤回中…' : `确认撤回 ${pendingUndo.removed} 条`}
            </button>
            <button className="btn small" onClick={() => setPendingUndo(null)}>
              取消
            </button>
          </Notice>
        ) : null}

        {batches === null ? (
          <p className="micro">正在读取导入记录…</p>
        ) : batches.rows.length === 0 ? (
          <p className="micro">
            {batchSearch
              ? `没有文件名匹配「${batchSearch}」的导入记录。`
              : '还没有导入记录。从「粘贴 / 导入」页导入后，批次会出现在这里。'}
          </p>
        ) : (
          <div className="listbox">
            <div className="listhead">
              <span>批次</span>
              <span>新增 · 跳过 · 时间</span>
            </div>
            {batches.rows.map((batch) => (
              <article className="bookmark" key={batch.id}>
                <div className="favicon" aria-hidden="true">
                  {batch.destination === 'library' ? '藏' : '看'}
                </div>
                <div className="rowbody" role="group">
                  <h3>{batch.fileName}</h3>
                  <div className="rowmeta">
                    <span>{batch.destination === 'library' ? '收藏库' : '待看'}</span>
                    <span>·</span>
                    <span>新增 {batch.inserted} 条</span>
                    <span>·</span>
                    <span>跳过 {batch.skipped} 条</span>
                    <span>·</span>
                    <span>{formatDateTime(batch.createdAt)}</span>
                    {batch.status === 'reverted' ? (
                      <span>
                        · 已撤回 {batch.revertedAt ? formatDateTime(batch.revertedAt) : ''}
                        {batch.undoCounts
                          ? `（移除 ${batch.undoCounts.removed} · 保留 ${batch.undoCounts.kept}${
                              batch.undoCounts.missing > 0 ? ` · 缺失 ${batch.undoCounts.missing}` : ''
                            }）`
                          : ''}
                      </span>
                    ) : null}
                  </div>
                  {batch.status === 'reverted' && batch.undoKept.length > 0 ? (
                    <KeptList items={batch.undoKept} />
                  ) : null}
                </div>
                <div className="rowactions">
                  {batch.inserted > 0 ? (
                    <button
                      className="btn small"
                      disabled={detailBusy === batch.id}
                      onClick={() => void openBatchDetail(batch)}
                    >
                      {detailBusy === batch.id ? '读取中…' : '查看本批'}
                    </button>
                  ) : null}
                  {batch.status === 'applied' && batch.inserted > 0 ? (
                    <button
                      className="btn small"
                      disabled={undoing === batch.id}
                      onClick={() => void startUndo(batch)}
                    >
                      {undoing === batch.id ? '正在预演…' : '撤回这次导入'}
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}

        {batches && batches.total > 0 ? (
          <div className="undolist">
            <p className="micro">
              共 {batches.total} 批，当前显示 {batches.rows.length} 批。
            </p>
            {batches.hasMore ? (
              <button
                className="btn small"
                onClick={() => {
                  const next = batchLimit + 20;
                  setBatchLimit(next);
                  void reloadBatches({ limit: next });
                }}
              >
                再加载 20 批
              </button>
            ) : null}
          </div>
        ) : null}

        {detail ? (
          <div className="notice">
            <strong>本批明细：{detail.batch.fileName}</strong>
            <span>
              {detail.note ??
                `这一批实际新建 ${detail.total} 条。只列本批新建的记录：导入时被判成重复而跳过、或库里原有的同目录条目不会混进来。`}
            </span>

            {detail.total > 0 ? (
              <>
                <div className="field">
                  <span>原始目录</span>
                  <select
                    aria-label="本批原始目录"
                    value={folderFilter}
                    onChange={(event) => {
                      setFolderFilter(event.target.value);
                      setCleanupPreview(null);
                    }}
                  >
                    <option value="">全部目录</option>
                    {detail.folders.map((folder) => (
                      <option key={folder} value={folder}>
                        {folder}
                      </option>
                    ))}
                    {detail.rows.some((row) => !row.folder) ? (
                      <option value={NO_FOLDER}>（无目录 / 已不存在）</option>
                    ) : null}
                  </select>
                </div>
                <div className="field">
                  <span>站点</span>
                  <select
                    aria-label="本批站点"
                    value={siteFilter}
                    onChange={(event) => {
                      setSiteFilter(event.target.value);
                      setCleanupPreview(null);
                    }}
                  >
                    <option value="">全部站点</option>
                    {detail.sites.map((site) => (
                      <option key={site} value={site}>
                        {site}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <span>状态</span>
                  <select
                    aria-label="本批状态"
                    value={stateFilter}
                    onChange={(event) => {
                      setStateFilter(event.target.value as 'all' | BatchEntryState);
                      setCleanupPreview(null);
                    }}
                  >
                    <option value="untouched">未改动</option>
                    <option value="all">全部状态</option>
                    <option value="modified">已改动</option>
                    <option value="trashed">已删除（回收站）</option>
                    <option value="converted">已转收藏</option>
                    <option value="completed">已完成</option>
                    <option value="missing">已不存在</option>
                  </select>
                </div>

                <span>
                  匹配 {detailRows.length} 条，当前显示 {displayedRows.length} 条
                  {hiddenRows > 0 ? `，还有 ${hiddenRows} 条未列出` : ''}；
                  {detail.batch.destination === 'library' ? (
                    <>
                      可移入回收站 {trashableRows.length} 条，可彻底删除 {deletableRows.length} 条
                      {modifiedRows.length > 0 ? `（其中已改动 ${modifiedRows.length} 条）` : ''}
                    </>
                  ) : (
                    <>
                      可从待看移除 {deletableRows.length} 条
                      {modifiedRows.length > 0 ? `（其中已改动 ${modifiedRows.length} 条）` : ''}
                    </>
                  )}
                  {outOfScopeRows > 0
                    ? `；另有 ${outOfScopeRows} 条已转收藏、已完成或已不存在，不在这里处理`
                    : ''}
                  。
                </span>

                {modifiedRows.length > 0 && stateFilter !== 'untouched' ? (
                  <span className="micro">
                    已改动的记录也会按当前内容处理：确认前会冻结版本，冻结之后又被改过的仍会跳过并报出来。
                  </span>
                ) : null}
                {stateFilter === 'trashed' ? (
                  <span className="micro">
                    回收站里的记录只能「彻底删除」：移入回收站对它们没有意义。彻底删除会连删除标记一起清，
                    之后同一批书签可以重新导入；动手前会先留一份清理快照。
                  </span>
                ) : null}

                <div className="listbox">
                  {displayedRows.map((row) => (
                    <article className="bookmark" key={row.entityId}>
                      <div className="favicon" aria-hidden="true">
                        {row.folder ? row.folder.slice(0, 1) : '—'}
                      </div>
                      <div className="rowbody" role="group">
                        <h3>{row.title || '（记录已不存在）'}</h3>
                        <div className="rowmeta">
                          <span>{BATCH_STATE_LABEL[row.state]}</span>
                          {row.site ? (
                            <>
                              <span>·</span>
                              <span>{row.site}</span>
                            </>
                          ) : null}
                          {row.folder ? (
                            <>
                              <span>·</span>
                              <span>{row.folder}</span>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>

                {hiddenRows > 0 ? (
                  <div className="actions" style={{ justifyContent: 'flex-start' }}>
                    <button
                      className="btn small"
                      onClick={() => setDetailLimit((current) => current + DETAIL_PAGE)}
                    >
                      再显示 {Math.min(DETAIL_PAGE, hiddenRows)} 条
                      {hiddenRows > DETAIL_PAGE ? `（还有 ${hiddenRows} 条未列出）` : ''}
                    </button>
                  </div>
                ) : null}

                {detail.batch.destination === 'library' ? (
                  <div className="actions" style={{ justifyContent: 'flex-start' }}>
                    <button
                      className="btn small"
                      disabled={trashableRows.length === 0 || cleanupBusy !== ''}
                      onClick={() => void startCleanup('trash')}
                    >
                      移入回收站 {trashableRows.length} 条
                    </button>
                    <button
                      className="btn small danger"
                      disabled={deletableRows.length === 0 || cleanupBusy !== ''}
                      onClick={() => void startCleanup('delete')}
                    >
                      彻底删除 {deletableRows.length} 条…
                    </button>
                  </div>
                ) : (
                  <div className="actions" style={{ justifyContent: 'flex-start' }}>
                    <button
                      className="btn small danger"
                      disabled={deletableRows.length === 0 || cleanupBusy !== ''}
                      onClick={() => void startCleanup('delete')}
                    >
                      从待看移除 {deletableRows.length} 条…
                    </button>
                  </div>
                )}
                <span className="micro">
                  按的是「全部匹配」，不是上面列出的这些条数——列表一页 {DETAIL_PAGE} 条，够不够看都不影响处理范围。
                  彻底删除会连删除标记一起清（含回收站里的），
                  所以之后能重新导入；待看没有回收站，移除即彻底删除。两种硬删除都会先留一份清理快照。
                </span>
              </>
            ) : null}

            <button className="btn small" onClick={() => setDetail(null)}>
              收起本批明细
            </button>
          </div>
        ) : null}

        {cleanupResult ? (
          <Notice tone="ok">
            <strong>已处理 {cleanupResult.removed} 条。</strong>
            {cleanupResult.skipped.length > 0 ? (
              <span>
                跳过 {cleanupResult.skipped.length} 条：
                {cleanupResult.skipped
                  .slice(0, 6)
                  .map((row) => `${row.title || row.entityId}（${row.reason}）`)
                  .join('；')}
                {cleanupResult.skipped.length > 6 ? ' 等' : ''}。
              </span>
            ) : null}
            <span>
              {cleanupResult.snapshotId
                ? '已留下清理快照，可在下面「最近清理」里按次找回。'
                : '这些条目在回收站里，需要时可以单独恢复。'}
            </span>
            <button className="btn small" onClick={() => setCleanupResult(null)}>
              知道了
            </button>
          </Notice>
        ) : null}

        {cleanupPreview && cleanupMode ? (
          <Notice tone="danger">
            <strong>确认处理 {cleanupPreview.actionable} 条？</strong>
            <span>
              范围：{cleanupPreview.token.label}；命中 {cleanupPreview.matched} 条
              {cleanupPreview.actionableByState.modified > 0
                ? `，其中 ${cleanupPreview.actionableByState.modified} 条导入后改过，会按当前内容一起处理`
                : ''}
              {cleanupPreview.protectedCount > 0
                ? `；另有 ${cleanupPreview.protectedCount} 条不在这个动作的处理范围里`
                : ''}
              。
            </span>
            <span>
              {cleanupMode === 'delete' || detail?.batch.destination === 'reading'
                ? `彻底删除：连删除标记一起清${
                    cleanupPreview.actionableByState.trashed > 0
                      ? `（含 ${cleanupPreview.actionableByState.trashed} 条已在回收站里的）`
                      : ''
                  }，之后可以重新导入；动手前会先写一份本机清理快照，写不进去就一条都不删。`
                : '移入回收站：可以撤销，需要时在回收站里单独恢复；已经在回收站里的记录不在这次范围里。'}
            </span>
            <span className="micro">
              范围冻结于 {formatDateTime(cleanupPreview.frozenAt)}。此后新增的命中不会纳入这次处理；
              预览后又被改动或挪进回收站的条目会自动跳过并报出来。
            </span>
            <button
              className="btn small danger"
              disabled={cleanupBusy !== ''}
              onClick={() => void runCleanup()}
            >
              {cleanupBusy ? '处理中…' : `确认处理 ${cleanupPreview.actionable} 条`}
            </button>
            <button
              className="btn small"
              onClick={() => {
                setCleanupPreview(null);
                setCleanupMode(null);
              }}
            >
              取消
            </button>
          </Notice>
        ) : null}

        <p className="micro">
          撤回不会进回收站。需要找回时，可在下面「最近清理」里按次从本机快照恢复（只留最近 5 份）；
          导入后改过或已删除的记录会保留，重新导入同一批书签时它们仍可能被判成重复或已删除。
        </p>
      </div>

      <div className="panel" id="recent-cleanup">
        <h2>最近清理</h2>
        <p>
          彻底清空、清空待看、清理完成历史和撤销导入都是硬删除，动手前会自动在本机留一份快照（保留最近 5
          份，只在本机、不随备份导出）。这里只能把<strong>这一次</strong>删掉的条目找回来：同网址已经重新导入的一律跳过，
          不覆盖当前数据。
        </p>
        {snapshots === null ? (
          <p className="micro">正在读取清理快照…</p>
        ) : snapshots.length === 0 ? (
          <p className="micro">还没有清理快照。清空范围或撤销导入之后会出现在这里。</p>
        ) : (
          <div className="listbox">
            <div className="listhead">
              <span>清理范围</span>
              <span>条数 · 时间</span>
            </div>
            {snapshots.map((snapshot) => (
              <article className="bookmark" key={snapshot.id}>
                <div className="favicon" aria-hidden="true">
                  清
                </div>
                <div className="rowbody" role="group">
                  <h3>{snapshot.scopeLabel}</h3>
                  <div className="rowmeta">
                    <span>收藏 {snapshot.counts.bookmarks}</span>
                    <span>·</span>
                    <span>待看 {snapshot.counts.readingItems}</span>
                    <span>·</span>
                    <span>删除标记 {snapshot.counts.tombstones}</span>
                    <span>·</span>
                    <span>{formatDateTime(snapshot.createdAt)}</span>
                    {snapshot.restoredAt ? (
                      <span>
                        · 已找回 {snapshot.restoredIds?.length ?? snapshot.restoredCounts?.restored ?? 0} 条（
                        {formatDateTime(snapshot.restoredAt)}）
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="rowactions">
                  <button
                    className="btn small"
                    disabled={snapshotBusy === snapshot.id}
                    onClick={() => void openSnapshotDetail(snapshot.id)}
                  >
                    {snapshotBusy === snapshot.id ? '读取中…' : '看看能找回什么'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {snapshotDetail ? (
          <div className="snapshotview">
            <Notice>
              <strong>
                这次清理共 {snapshotDetail.totals.candidates} 条：可找回 {snapshotDetail.totals.restorable} 条，跳过{' '}
                {snapshotDetail.totals.skipped} 条，冲突 {snapshotDetail.totals.conflicted} 条。
              </strong>
              <span>
                {snapshotDetail.scopeLabel} · {formatDateTime(snapshotDetail.createdAt)}。
                可以按关键词、类型、状态、原目录或站点先筛，再勾选要找回的那几条；没勾的留在快照里等下次。
              </span>
              <span>
                冲突表示同网址已经在库里，找回不会覆盖它；在回收站里的条目会回到回收站，不会直接冒出来。
              </span>
              <div className="actions" style={{ justifyContent: 'flex-start' }}>
                <button
                  className="btn small primary"
                  disabled={
                    snapshotBusy !== '' ||
                    (selectedRestorable === 0 && restorableSnapshotEntries.length === 0)
                  }
                  onClick={() =>
                    void runPurgeRestore(
                      selectedRestorable > 0
                        ? snapshotSelected
                        : restorableSnapshotEntries.map((row) => row.id)
                    )
                  }
                >
                  {selectedRestorable > 0
                    ? `恢复选中的 ${selectedRestorable} 条`
                    : `恢复这 ${restorableSnapshotEntries.length} 条`}
                </button>
                <button
                  className="btn small"
                  onClick={() => {
                    setSnapshotDetail(null);
                    setSnapshotSelected([]);
                  }}
                >
                  关闭
                </button>
              </div>
            </Notice>

            <div className="toolbar">
              <input
                aria-label="搜索清理记录"
                placeholder="搜索标题或网址…"
                value={snapshotSearch}
                onChange={(event) => {
                  setSnapshotSearch(event.target.value);
                  setSnapshotLimit(DETAIL_PAGE);
                }}
              />
              <select
                aria-label="清理记录类型"
                value={snapshotKind}
                onChange={(event) => setSnapshotKind(event.target.value as typeof snapshotKind)}
              >
                <option value="">全部类型</option>
                <option value="bookmark">收藏</option>
                <option value="reading">待看</option>
              </select>
              <select
                aria-label="清理记录状态"
                value={snapshotStatus}
                onChange={(event) => setSnapshotStatus(event.target.value as typeof snapshotStatus)}
              >
                <option value="">全部状态</option>
                <option value="restore">可找回</option>
                <option value="skip">跳过</option>
                <option value="conflict">冲突</option>
              </select>
              <select
                aria-label="清理记录目录"
                value={snapshotFolder}
                onChange={(event) => setSnapshotFolder(event.target.value)}
              >
                <option value="">全部目录</option>
                {snapshotFolders.map((folder) => (
                  <option key={folder} value={folder}>
                    {folder}
                  </option>
                ))}
                <option value={NO_FOLDER}>（无目录）</option>
              </select>
              <select
                aria-label="清理记录站点"
                value={snapshotHost}
                onChange={(event) => setSnapshotHost(event.target.value)}
              >
                <option value="">全部站点</option>
                {snapshotHosts.map((host) => (
                  <option key={host} value={host}>
                    {host}
                  </option>
                ))}
              </select>
              <span className="micro">
                匹配 {filteredSnapshotEntries.length} 条，当前显示 {snapshotPageRows.length} 条
                {snapshotHidden > 0 ? `，还有 ${snapshotHidden} 条未列出` : ''}
              </span>
            </div>

            <ul className="snapentries">
              {snapshotPageRows.map((row) => {
                const selectable = row.action === 'restore' && !row.restored;
                return (
                  <li className="snapentry" key={`${row.kind}:${row.id}`}>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${row.title}`}
                      checked={selectable && selectedSnapshotIds.has(row.id)}
                      disabled={!selectable}
                      onChange={(event) =>
                        setSnapshotSelected((current) =>
                          event.target.checked
                            ? [...current, row.id]
                            : current.filter((id) => id !== row.id)
                        )
                      }
                    />
                    <div className="snapentrybody">
                      <strong>{row.title}</strong>
                      <span className="micro">
                        {row.kind === 'reading' ? '待看' : row.folder ? `目录：${row.folder}` : '无原始目录'}
                        {row.kind === 'bookmark' ? ` · ${row.categoryName ?? '未分类'}` : ''} · {row.host}
                        {row.trashed ? ' · 清理时在回收站' : ''}
                      </span>
                      {row.action !== 'restore' ? <span className="micro">· {row.reason}</span> : null}
                    </div>
                    <span className={`tag ${row.action}`}>
                      {row.restored ? '已找回' : row.action === 'restore' ? '可找回' : row.action === 'skip' ? '跳过' : '冲突'}
                    </span>
                  </li>
                );
              })}
              {snapshotPageRows.length === 0 ? (
                <li className="snapentry">
                  <span className="micro">当前筛选没有命中任何记录。</span>
                </li>
              ) : null}
            </ul>

            <div className="actions" style={{ justifyContent: 'flex-start' }}>
              <button
                className="btn small"
                disabled={restorableSnapshotEntries.length === 0}
                onClick={() =>
                  setSnapshotSelected((current) => [
                    ...new Set([...current, ...restorableSnapshotEntries.map((row) => row.id)]),
                  ])
                }
              >
                全选可找回（{restorableSnapshotEntries.length}）
              </button>
              <button
                className="btn small"
                disabled={snapshotSelected.length === 0}
                onClick={() => setSnapshotSelected([])}
              >
                清空勾选
              </button>
              {snapshotHidden > 0 ? (
                <button className="btn small" onClick={() => setSnapshotLimit(snapshotLimit + DETAIL_PAGE)}>
                  再显示 {Math.min(DETAIL_PAGE, snapshotHidden)} 条（还有 {snapshotHidden} 条）
                </button>
              ) : null}
              <span className="micro">已勾选 {snapshotSelected.length} 条</span>
            </div>
          </div>
        ) : null}
      </div>

      <div className="panel">
        <h2>恢复备份</h2>
        <p>先预览数量与数据截止时间，再选择合并或替换。替换前会自动导出一份当前主库备份。</p>

        {safetyCopy ? (
          <div className="notice danger">
            <strong>有一份替换前的安全备份还没确认保存</strong>
            <span>
              保存于 {formatDateTime(safetyCopy.savedAt)}，存在本机库里，不随替换清空。
              在它被保存并确认之前，替换会被挡下——下一份副本不会覆盖它。
            </span>
            <div className="actions" style={{ justifyContent: 'flex-start' }}>
              <button className="btn small" onClick={() => saveSafety(safetyCopy.text, safetyCopy.savedAt)}>
                保存这份安全备份 ↓
              </button>
              <button
                className="btn small"
                onClick={() => {
                  void (async () => {
                    await service.clearSafetyCopy(safetyCopy.id);
                    setSafetyCopy(null);
                    toast('已清理本机临时副本（磁盘上的文件不受影响）。');
                  })();
                }}
              >
                已确认保存，清理本机副本
              </button>
            </div>
          </div>
        ) : null}

        <label className="field">
          <span>备份文件</span>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) => void pickRestore(event.target.files?.[0])}
          />
        </label>

        {restoreFile ? (
          parsed ? (
            <>
              <div className="stats">
                <div className="stat">
                  <strong>{parsed.schemaVersion}</strong>
                  <span>格式版本</span>
                </div>
                <div className="stat">
                  <strong>{parsed.bookmarks.length}</strong>
                  <span>条收藏</span>
                </div>
                <div className="stat">
                  <strong>{parsed.readingItems.length}</strong>
                  <span>条待看</span>
                </div>
                <div className="stat">
                  <strong>{parsed.tombstones?.length ?? 0}</strong>
                  <span>条删除标记</span>
                </div>
              </div>
              <p className="micro">
                导出时间 {formatDateTime(parsed.exportedAt)} · 当前主库：{data.bookmarks.length} 条收藏、
                {data.pendingReading.length} 条待看
              </p>
              {parsed.exclusions?.readingForLocalOnly ? (
                <p className="micro">
                  这份备份导出时排除了 {parsed.exclusions.readingForLocalOnly} 条关联本地专用收藏的待看，
                  恢复后不会有这些。
                </p>
              ) : null}
              <label className="field">
                <span>恢复方式</span>
                <select value={mode} onChange={(event) => setMode(event.target.value as 'merge' | 'replace')}>
                  <option value="merge">
                    {libraryEmpty
                      ? '合并（当前主库为空，等同于完整导入，含设置与整理策略）'
                      : '合并（只新增本机没有的条目，已有内容不覆盖）'}
                  </option>
                  <option value="replace">替换整个主库（先自动备份）</option>
                </select>
              </label>
              {mode === 'merge' && !libraryEmpty ? (
                <p className="micro">
                  合并不会改动本机已有的收藏、待看、设置与整理策略；本机删掉的条目也不会被备份复活。
                  要完整变回备份那一刻请用替换。
                </p>
              ) : null}
              {mode === 'replace' ? (
                <div className="notice danger">
                  <strong>替换会清空当前主库</strong>
                  <span>
                    包括收藏、待看、分类、标签、导入批次与 AI 日志；在途 AI 交接批次也会作废，旧库应停止写入。
                  </span>
                  <span>替换前会先导出一份当前主库的完整备份（含时间与条数），未能保存时可就地再次保存。</span>
                  <label className="checkline" style={{ margin: 0 }}>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    我了解影响并确认替换
                  </label>
                </div>
              ) : null}
              <div className="actions">
                <button className="btn" onClick={() => { setParsed(null); setRestoreFile(null); }}>
                  取消
                </button>
                <button className="btn primary" onClick={() => void doRestore()} disabled={busy}>
                  {busy ? '恢复中…' : mode === 'replace' ? '替换并恢复' : '合并恢复'}
                </button>
              </div>
              {/* 文件已选好时，写入前/写入中的失败也必须就地可见，
                  否则「替换未勾选确认」这类拒绝只会写进 state，用户看不到。 */}
              {error ? <p className="alert">{error}</p> : null}
            </>
          ) : (
            <p className="alert">{error}</p>
          )
        ) : null}

        {result ? (
          <>
            {result.safety ? (
              <div className="notice">
                <strong>替换前已自动备份当前主库</strong>
                <span>
                  导出时间 {formatDateTime(result.safety.exportedAt)} · {result.safety.bookmarks} 条收藏 /{' '}
                  {result.safety.reading} 条待看 / {result.safety.categories} 个分类 / {result.safety.tags} 个标签
                </span>
                <span>
                  这份备份在替换之前就已写入本机库，并已发起下载；即使下载被拦或页面被关，也能在「数据」页重新保存。
                </span>
                {safetyCopy ? (
                  <button
                    className="btn small"
                    onClick={() => saveSafety(safetyCopy.text, safetyCopy.savedAt)}
                  >
                    再次保存安全备份 ↓
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="notice">
              <strong>恢复完成（{result.mode === 'replace' ? '替换' : '合并'}）</strong>
              <span>
                新增收藏 {result.bookmarksAdded} 条，跳过 {result.bookmarksSkipped} 条，待看 {result.readingAdded} 条
                {result.readingSkipped > 0 ? `（另有 ${result.readingSkipped} 条因网址重复跳过）` : ''}，
                删除标记 {result.tombstonesAdded} 条。
              </span>
              {result.keptLocalDeletes > 0 ? (
                <span>
                  其中 {result.keptLocalDeletes} 条在本机已删除、备份里仍为活跃，已保留本机的删除。
                </span>
              ) : null}
              {result.adoptedSettings && result.mode === 'merge' ? (
                <span>当前主库原本为空，已一并恢复备份里的设置与整理策略。</span>
              ) : null}
              {result.danglingReferences > 0 ? (
                <span>有 {result.danglingReferences} 处引用指向备份里没有的分类或标签，已清空。</span>
              ) : null}
              {result.warnings.map((warning) => (
                <span key={warning}>{warning}</span>
              ))}
            </div>
            {result.librarySwitch ? (
              <div className="notice danger">
                <strong>主库身份已切换</strong>
                <span>
                  {result.librarySwitch.from} → {result.librarySwitch.to}
                </span>
                <span>
                  旧设备或旧配置上的 AI 交接映射已失效（{result.handoffInvalidated} 个在途批次作废）。请只保留这一份主库继续整理，
                  在另一处停止写入并关闭旧工作台，避免同一收藏在两份库里分叉。
                </span>
              </div>
            ) : null}
          </>
        ) : null}
        {error && !restoreFile ? <p className="alert">{error}</p> : null}
      </div>

      <Notice>
        云同步（v1b）尚未启用。单机使用不依赖登录或服务器，本版本不会建立任何远程服务。
      </Notice>
    </>
  );
}
