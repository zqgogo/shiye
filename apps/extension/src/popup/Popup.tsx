import { useEffect, useState } from 'react';
import { isAppError, LIMITS, newId, toUserMessage, type Category } from '@shiye/core';
import type { WorkspaceService } from '@shiye/application';
import { notifyDataChanged } from '@shiye/application';

const hasChrome = typeof chrome !== 'undefined' && Boolean(chrome.tabs);

async function currentTab(): Promise<{ url: string; title: string; tabId: number | null; restricted: boolean }> {
  if (!hasChrome) return { url: '', title: '', tabId: null, restricted: false };
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  const url = tab?.url ?? '';
  const restricted = !/^https?:/i.test(url);
  return { url, title: tab?.title ?? '', tabId: tab?.id ?? null, restricted };
}

export function Popup({ service }: { service: WorkspaceService }) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedText, setSelectedText] = useState('');
  const [restricted, setRestricted] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState<{ kind: 'reading' | 'bookmark'; title: string } | null>(null);
  const [readingId, setReadingId] = useState<string | null>(null);
  const [bookmarkId, setBookmarkId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const tab = await currentTab();
      if (tab.url) {
        setUrl(tab.url);
        setTitle(tab.title);
        setRestricted(tab.restricted);
        if (tab.restricted) {
          setNotice('当前页面受浏览器保护，无法自动读取，请手动填写合法网址。');
        }
      }
      try {
        const snapshot = await service.snapshot();
        setCategories(snapshot.categories);
      } catch (cause) {
        setError(toUserMessage(cause));
      }
    })();
  }, [service]);

  const readSelection = async () => {
    setError('');
    if (!hasChrome) {
      setError('仅在选择网页文字后、于扩展弹窗中可用。');
      return;
    }
    const tab = await currentTab();
    if (tab.tabId === null || tab.restricted) {
      setError('该页面不允许读取所选文字，请手动粘贴。');
      return;
    }
    try {
      // 在页面上下文里按码点切：.slice 走 UTF-16，遇到 emoji 会在代理对中间断开，
      // 也会比真实字符数更早到达上限。超出时要告诉用户被截了，不能悄悄丢。
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.tabId },
        args: [LIMITS.selectedText],
        func: (limit: number) => {
          const raw = String(window.getSelection()?.toString() ?? '');
          const chars = Array.from(raw);
          return { total: chars.length, text: chars.slice(0, limit).join('') };
        },
      });
      const read = results[0]?.result as { total: number; text: string } | undefined;
      if (read && read.text.trim()) {
        setSelectedText(read.text);
        setNotice(
          read.total > LIMITS.selectedText
            ? `所选文字共 ${read.total} 个字符，超过 ${LIMITS.selectedText} 的上限，已截取前 ${LIMITS.selectedText} 个。保存的是截取后的内容。`
            : '已读取当前页面所选文字，仅在保存时写入。'
        );
      } else {
        setNotice('没有检测到所选文字。');
      }
    } catch {
      setError('读取所选文字失败，该页面可能受限。');
    }
  };

  const saveReading = async () => {
    setError('');
    if (!url.trim()) {
      setError('请输入网址。');
      return;
    }
    setBusy(true);
    const id = readingId ?? newId();
    setReadingId(id);
    try {
      const item = await service.addReading({ id, originalUrl: url, title, sourceType: 'extension' });
      setSaved({ kind: 'reading', title: item.title });
      notifyDataChanged();
    } catch (cause) {
      if (isAppError(cause) && cause.code === 'DUPLICATE') {
        setSaved({ kind: 'reading', title });
      } else {
        // 结果未知时用原 ID 核对，避免新建 ID 盲重试。
        const existing = await service.getReading(id);
        if (existing) setSaved({ kind: 'reading', title: existing.title });
        else setError(toUserMessage(cause));
      }
    } finally {
      setBusy(false);
    }
  };

  const saveBookmark = async () => {
    setError('');
    if (!url.trim()) {
      setError('请输入网址。');
      return;
    }
    setBusy(true);
    const id = bookmarkId ?? newId();
    setBookmarkId(id);
    try {
      const bookmark = await service.createBookmark({
        id,
        originalUrl: url,
        title,
        categoryId,
        selectedText,
        sourceType: 'extension',
      });
      setSaved({ kind: 'bookmark', title: bookmark.title });
      notifyDataChanged();
    } catch (cause) {
      if (isAppError(cause) && (cause.code === 'DUPLICATE' || cause.code === 'TOMBSTONED')) {
        setError(cause.message);
      } else {
        const existing = await service.getBookmark(id);
        if (existing) setSaved({ kind: 'bookmark', title: existing.title });
        else setError(toUserMessage(cause));
      }
    } finally {
      setBusy(false);
    }
  };

  const openWorkspace = (route = 'home') => {
    if (!hasChrome) return;
    void chrome.tabs.create({ url: chrome.runtime.getURL(`workspace.html#${route}`) });
    window.close();
  };

  const visibleCategories = categories.filter((category) =>
    category.name.toLowerCase().includes(categoryFilter.trim().toLowerCase())
  );

  return (
    <div className="popupframe">
      <div className="brand" style={{ marginBottom: 18 }}>
        <div className="brand-mark">拾</div>
        <div>
          <b>拾页</b>
          <small>SAVE FOR LATER</small>
        </div>
      </div>

      {saved ? (
        <>
          <h2>已保存到{ saved.kind === 'reading' ? '待看' : '收件箱' }</h2>
          <p className="micro">{saved.title || url}</p>
          <button className="btn primary" onClick={() => openWorkspace(saved.kind === 'reading' ? 'reading' : 'inbox')}>
            打开工作台查看 ↗
          </button>
          <button className="btn" onClick={() => window.close()}>
            关闭
          </button>
        </>
      ) : (
        <>
          <h2>收藏当前页面</h2>
          <p className="micro">待看与收藏独立；加入待看不需要分类。</p>

          <label className="field">
            <span>网址</span>
            <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
          </label>
          <label className="field">
            <span>标题</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="给它一个容易找回的名字"
            />
          </label>
          <label className="field">
            <span>分类（可选）</span>
            <input
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
              placeholder="搜索分类…"
              aria-label="搜索分类"
            />
            <select value={categoryId ?? ''} onChange={(event) => setCategoryId(event.target.value || null)}>
              <option value="">暂不分类</option>
              {visibleCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <small>保存后同时出现在收件箱与所选分类。</small>
          </label>
          <label className="field">
            <span>主动保存的选中文字</span>
            <textarea
              value={selectedText}
              onChange={(event) => setSelectedText(event.target.value)}
              placeholder="只在你主动选择时保存"
              style={{ minHeight: 60 }}
            />
            <small>{[...selectedText].length} / 4000 码点 · 不自动提取正文</small>
          </label>

          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button className="btn small" onClick={() => void readSelection()}>
              读取页面所选文字
            </button>
          </div>

          {notice ? <div className="notice">{notice}</div> : null}
          <p className="alert" role="alert">
            {error}
          </p>

          <button className="btn" onClick={() => void saveReading()} disabled={busy}>
            仅加入待看
          </button>
          <button className="btn primary" onClick={() => void saveBookmark()} disabled={busy}>
            {busy ? '写入中…' : '保存收藏'}
          </button>
          <button className="btn" onClick={() => openWorkspace('home')}>
            打开工作台 ↗
          </button>
          <p className="micro" style={{ textAlign: 'center', marginTop: 14 }}>
            仅本地 · 不使用 AI · 确认写入后才显示成功
          </p>
        </>
      )}
    </div>
  );
}

export function usePopupService(service: WorkspaceService): WorkspaceService {
  return service;
}

export type { WorkspaceService };
