import { useEffect, useState } from 'react';
import {
  backupFileName,
  formatDateTime,
  parseBackup,
  toUserMessage,
  type BackupDocument,
  type ImportBatch,
  type PurgeRestorePreview,
  type PurgeSnapshot,
} from '@shiye/core';
import type { ImportBatchPage, ImportUndoPreview, ImportUndoResult } from '@shiye/application';
import { KeptList, Notice, PageHeader } from './components.js';
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

export function DataPage() {
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
  const [purgePreview, setPurgePreview] = useState<PurgeRestorePreview | null>(null);
  const [purgeBusy, setPurgeBusy] = useState('');
  const [undoing, setUndoing] = useState('');
  /** 待确认的撤回：先预演，把「会删几条、留几条」直接摆在确认按钮旁边。 */
  const [pendingUndo, setPendingUndo] = useState<ImportUndoPreview | null>(null);
  /** 刚执行完的撤回结果：常驻在页面上，不放 toast，也不随刷新丢掉。 */
  const [undoResult, setUndoResult] = useState<ImportUndoResult | null>(null);

  const reloadBatches = async (options?: { search?: string; limit?: number }) => {
    const search = options?.search ?? batchSearch;
    const limit = options?.limit ?? batchLimit;
    try {
      setBatches(await service.listImportBatches({ search, limit }));
    } catch {
      setBatches({ rows: [], total: 0, hasMore: false });
    }
  };

  /** 只读预览：算出这一次删掉的东西里哪些能找回、哪些会跳过或冲突。 */
  const previewPurgeRestore = async (snapshotId: string) => {
    setPurgeBusy(snapshotId);
    try {
      setPurgePreview(await service.previewPurgeRestore(snapshotId));
    } catch (error) {
      toast(toUserMessage(error), 'error');
    } finally {
      setPurgeBusy('');
    }
  };

  /** 只加回这份快照的条目；冲突一律跳过，不覆盖当前数据。 */
  const runPurgeRestore = async () => {
    if (!purgePreview) return;
    setPurgeBusy(purgePreview.snapshotId);
    try {
      const outcome = await service.restorePurgeSnapshot(purgePreview.snapshotId);
      toast(
        `找回 ${outcome.restored} 条；跳过 ${outcome.preview.skipped} 条、冲突 ${outcome.preview.conflicted} 条。`,
        'ok'
      );
      setPurgePreview(null);
      await reload();
    } catch (error) {
      toast(toUserMessage(error), 'error');
    } finally {
      setPurgeBusy('');
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
    await reloadBatches();
  };

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
            <KeptList items={undoResult.items} />
            <span>这份结果也存进了批次记录，刷新或关页之后仍能在下面查到。</span>
            <button className="btn small" onClick={() => setUndoResult(null)}>
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

        <p className="micro">
          撤回会连这批条目的删除标记一起清掉，所以之后可以重新导入同一批书签；代价是撤回本身不可恢复。
        </p>
      </div>

      <div className="panel">
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
                        · 已恢复 {snapshot.restoredCounts?.restored ?? 0} 条（{formatDateTime(snapshot.restoredAt)}）
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="rowactions">
                  <button
                    className="btn small"
                    disabled={purgeBusy === snapshot.id}
                    onClick={() => void previewPurgeRestore(snapshot.id)}
                  >
                    {purgeBusy === snapshot.id ? '读取中…' : '看看能找回什么'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {purgePreview ? (
          <Notice>
            <strong>
              这次清理共 {purgePreview.candidates} 条：可找回 {purgePreview.restorable} 条，跳过{' '}
              {purgePreview.skipped} 条，冲突 {purgePreview.conflicted} 条。
            </strong>
            <span>只加回这份快照里的条目；冲突表示同网址已经在库里，恢复不会覆盖它。</span>
            {purgePreview.decisions
              .filter((row) => row.action !== 'restore')
              .slice(0, 8)
              .map((row) => (
                <span key={row.id} className="micro">
                  · {row.title}：{row.reason}
                </span>
              ))}
            <button
              className="btn small primary"
              disabled={purgeBusy !== '' || purgePreview.restorable === 0}
              onClick={() => void runPurgeRestore()}
            >
              恢复这 {purgePreview.restorable} 条
            </button>
            <button className="btn small" onClick={() => setPurgePreview(null)}>
              取消
            </button>
          </Notice>
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
