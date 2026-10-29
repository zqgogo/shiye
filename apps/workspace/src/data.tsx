import { useState } from 'react';
import {
  backupFileName,
  formatDateTime,
  parseBackup,
  toUserMessage,
  type BackupDocument,
} from '@shiye/core';
import { Notice, PageHeader } from './components.js';
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
  const { data, service, run, toast } = useWorkspace();
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
        tombstonesAdded: number;
        danglingReferences: number;
        handoffInvalidated: number;
        librarySwitch: { from: string; to: string } | null;
        safety: { exportedAt: string; bookmarks: number; reading: number; categories: number; tags: number } | null;
        warnings: string[];
        safetyText?: string;
      }
    | null
  >(null);

  const libraryEmpty = data.bookmarks.length === 0 && data.pendingReading.length === 0;

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
        tombstonesAdded: outcome.result.tombstonesAdded,
        danglingReferences: outcome.result.danglingReferences,
        handoffInvalidated: outcome.result.handoffInvalidated,
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
        ...(safety ? { safetyText: safety.text } : {}),
      });
      if (safety) download(backupFileName(new Date().toISOString()), safety.text, 'application/json');
      await run(async () => undefined);
      setConfirmed(false);
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const exportSnapshot = async () => {
    setBusy(true);
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
        <h2>恢复备份</h2>
        <p>先预览数量与数据截止时间，再选择合并或替换。替换前会自动导出一份当前主库备份。</p>
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
              <label className="field">
                <span>恢复方式</span>
                <select value={mode} onChange={(event) => setMode(event.target.value as 'merge' | 'replace')}>
                  <option value="merge">
                    {libraryEmpty
                      ? '合并（当前主库为空，等同于导入）'
                      : '合并（保留现有，按 ID 与修订号跳过较旧记录）'}
                  </option>
                  <option value="replace">替换整个主库（先自动备份）</option>
                </select>
              </label>
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
                <span>备份文件已发起下载；请在下载目录核对是否保存成功。</span>
                {result.safetyText ? (
                  <button
                    className="btn small"
                    onClick={() =>
                      download(backupFileName(new Date().toISOString()), result.safetyText ?? '', 'application/json')
                    }
                  >
                    再次保存安全备份
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="notice">
              <strong>恢复完成（{result.mode === 'replace' ? '替换' : '合并'}）</strong>
              <span>
                新增收藏 {result.bookmarksAdded} 条，跳过 {result.bookmarksSkipped} 条，待看 {result.readingAdded} 条，
                删除标记 {result.tombstonesAdded} 条。
              </span>
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
