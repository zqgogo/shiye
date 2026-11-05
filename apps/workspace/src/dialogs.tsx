import { categoryPath, categoryFingerprint, paginate } from '@shiye/core';
import { useEffect, useMemo, useState } from 'react';
import {
  LIMITS,
  codePointLength,
  domainOf,
  formatDateTime,
  isAppError,
  isBatchCleanupActionable,
  isHttpUrl,
  matchesCleanupCriteria,
  toUserMessage,
  type Bookmark,
  type Category,
  type CleanupCriteria,
  type CleanupModification,
  type CleanupPresence,
  type CleanupPreview,
  type CleanupResult,
  type CleanupScope,
  type CleanupScopeKind,
  type CleanupScopeView,
  type BatchCleanupMode,
  type BatchEntryState,
} from '@shiye/core';
import { notifyDataChanged } from '@shiye/application';
import { useWorkspace } from './state.js';
import { BATCH_STATE_LABEL, ICONS, NO_FOLDER, Pager } from './components.js';

function CategoryPicker({
  value,
  onChange,
  categories,
  label = '分类（可选）',
  disabled,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  categories: Category[];
  label?: string;
  disabled?: boolean;
}) {
  const [filter, setFilter] = useState('');
  const visible = categories.filter((category) =>
    category.name.toLowerCase().includes(filter.trim().toLowerCase())
  );
  return (
    <div className="field">
      <span>{label}</span>
      <input
        placeholder="搜索分类…"
        aria-label="搜索分类"
        value={filter}
        disabled={disabled}
        onChange={(event) => setFilter(event.target.value)}
      />
      <select
        aria-label="选择分类"
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">暂不分类</option>
        {visible.map((category) => (
          <option key={category.id} value={category.id}>
            {categoryPath(categories, category.id)}
          </option>
        ))}
      </select>
    </div>
  );
}

export function NewBookmarkModal({ initialUrl = '' }: { initialUrl?: string }) {
  const { service, closeModal, navigate, reload, toast } = useWorkspace();
  const { categories } = useWorkspace().data;
  const [url, setUrl] = useState(initialUrl);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [localOnly, setLocalOnly] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError('');
    if (!url.trim()) {
      setError('请输入网址。');
      return;
    }
    if (!title.trim()) {
      setError('请输入标题。');
      return;
    }
    setBusy(true);
    try {
      await service.createBookmark({
        originalUrl: url,
        title,
        sourceDescription: description,
        categoryId,
        privacy: { localOnly },
        sourceType: 'manual',
      });
      await reload();
      notifyDataChanged();
      toast('已保存到收件箱。', 'ok');
      closeModal();
      navigate('inbox');
    } catch (cause) {
      // 重复、墓碑等失败原因需常驻在弹窗内，不能只靠几秒后消失的 toast。
      setError(toUserMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modalshade" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeModal();
    }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-title">
        <div className="modalheader">
          <h2 id="new-title">收藏一个链接</h2>
          <button className="iconbtn" onClick={closeModal} aria-label="关闭">
            ×
          </button>
        </div>
        <p className="micro">先保存到收件箱，整理可以稍后再做。</p>
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
          <span>描述（可选）</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="它可以帮你做什么？"
            style={{ minHeight: 70 }}
          />
        </label>
        <CategoryPicker value={categoryId} onChange={setCategoryId} categories={categories} />
        <label className="checkline">
          <input
            type="checkbox"
            checked={localOnly}
            onChange={(event) => setLocalOnly(event.target.checked)}
          />
          本地专用（不进入 AI 材料与手机快照）
        </label>
        <p className="alert" role="alert">
          {error}
        </p>
        <div className="actions">
          <button className="btn" onClick={closeModal}>
            取消
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={busy}>
            {busy ? '保存中…' : '保存到收件箱'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AddReadingModal() {
  const { service, closeModal, reload, toast } = useWorkspace();
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!url.trim()) {
      setError('请输入网址。');
      return;
    }
    setError('');
    setBusy(true);
    try {
      await service.addReading({ originalUrl: url, title, note });
      await reload();
      notifyDataChanged();
      toast('已加入待看，不影响收藏库。', 'ok');
      closeModal();
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modalshade" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeModal();
    }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="reading-title">
        <div className="modalheader">
          <h2 id="reading-title">添加到待看</h2>
          <button className="iconbtn" onClick={closeModal} aria-label="关闭">
            ×
          </button>
        </div>
        <p className="micro">先保存链接，不必选择分类；看完后再决定是否收藏。</p>
        <label className="field">
          <span>网址</span>
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
        </label>
        <label className="field">
          <span>标题</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="给它一个容易想起的名字"
          />
        </label>
        <label className="field">
          <span>备注（可选）</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="为什么想看？"
            style={{ minHeight: 70 }}
          />
        </label>
        <p className="alert">{error}</p>
        <div className="actions">
          <button className="btn" onClick={closeModal}>
            取消
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={busy}>
            {busy ? '保存中…' : '加入待看'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConvertReadingModal({ readingId, categoryId: initialCategoryId }: { readingId: string; categoryId?: string | null }) {
  const { data, service, closeModal, run, openBookmark, navigate } = useWorkspace();
  const item = data.pendingReading.find((entry) => entry.id === readingId);
  const existing = item
    ? data.bookmarks.find((bookmark) => bookmark.canonicalUrl === item.canonicalUrl)
    : undefined;
  const [title, setTitle] = useState(item?.title ?? '');
  const [note, setNote] = useState(item?.note ?? '');
  const [categoryId, setCategoryId] = useState<string | null>(initialCategoryId ?? null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * 同 URL 的墓碑要先查出来：仓库层会直接拒绝新建，
   * 界面上必须让用户明确选择「恢复原收藏」还是「保持待看」，不能只丢一条报错。
   */
  const [tombstone, setTombstone] = useState<Bookmark | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    if (!item) return;
    service
      .findDeletedByUrl(item.originalUrl)
      .then((found) => {
        if (!cancelled) setTombstone(found ?? null);
      })
      .catch(() => {
        if (!cancelled) setTombstone(null);
      });
    return () => {
      cancelled = true;
    };
  }, [item, service]);

  if (!item) return null;

  if (tombstone) {
    return (
      <div className="modalshade" role="presentation">
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="tomb-title">
          <div className="modalheader">
            <h2 id="tomb-title">这条网址有已删除的收藏</h2>
            <button className="iconbtn" onClick={closeModal} aria-label="关闭">
              ×
            </button>
          </div>
          <p>
            《{tombstone.title}》此前被移到回收站（{formatDateTime(tombstone.deletedAt)}）。
            为避免绕过删除记录重复建库，需要你选择一种处理方式。
          </p>
          <div className="notice">
            恢复会保留它原来的分类与未读状态，并把这条待看标记为完成；选择保持待看则不做任何写入。
          </div>
          <p className="alert">{error}</p>
          <div className="actions">
            <button className="btn" onClick={closeModal}>
              保持待看
            </button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setError('');
                setBusy(true);
                const restored = await run(async () => {
                  const row = await service.restoreBookmark(tombstone.id);
                  await service.completeReading(item.id);
                  return row;
                }, '已恢复原收藏，并完成待看。');
                setBusy(false);
                if (restored) {
                  closeModal();
                  openBookmark(restored.id);
                }
              }}
            >
              {busy ? '处理中…' : '恢复原收藏'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (existing) {
    return (
      <div className="modalshade" role="presentation">
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modalheader">
            <h2>这条内容已经收藏</h2>
            <button className="iconbtn" onClick={closeModal} aria-label="关闭">
              ×
            </button>
          </div>
          <p>
            《{existing.title}》已经在收藏库中，属于「
            {data.categories.find((category) => category.id === existing.categoryId)?.name ?? '未分类'}」。
            不会重复创建收藏。
          </p>
          <div className="actions">
            <button className="btn" onClick={closeModal}>
              继续待看
            </button>
            <button
              className="btn primary"
              onClick={async () => {
                const done = await run(() => service.completeReading(item.id), '已完成待看，原收藏不变。');
                closeModal();
                if (done) openBookmark(existing.id);
              }}
            >
              完成待看并查看收藏
            </button>
          </div>
        </div>
      </div>
    );
  }

  const convert = async () => {
    setError('');
    if (!title.trim()) {
      setError('请输入标题。');
      return;
    }
    setBusy(true);
    const result = await run(
      () => service.convertReading(item.id, item.localRevision, { title, note, categoryId }),
      '已转入收藏并进入收件箱。'
    );
    setBusy(false);
    if (result) {
      closeModal();
      navigate('inbox');
    }
  };

  return (
    <div className="modalshade" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="convert-title">
        <div className="modalheader">
          <h2 id="convert-title">转入收藏</h2>
          <button className="iconbtn" onClick={closeModal} aria-label="关闭">
            ×
          </button>
        </div>
        <p className="micro">确认收藏后才移出待看；可以先不分类。整个过程在同一事务中完成。</p>
        <label className="field">
          <span>标题</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <CategoryPicker value={categoryId} onChange={setCategoryId} categories={data.categories} />
        <label className="field">
          <span>备注</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            style={{ minHeight: 70 }}
          />
        </label>
        <p className="alert">{error}</p>
        <div className="actions">
          <button className="btn" onClick={closeModal}>
            取消
          </button>
          <button className="btn primary" onClick={() => void convert()} disabled={busy}>
            {busy ? '写入中…' : '确认转入收藏'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DeleteBookmarkModal({ bookmarkId }: { bookmarkId: string }) {
  const { data, service, closeModal, run } = useWorkspace();
  const bookmark = data.bookmarks.find((entry) => entry.id === bookmarkId);
  if (!bookmark) return null;
  return (
    <div className="modalshade" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="del-title">
        <div className="modalheader">
          <h2 id="del-title">移到回收站？</h2>
          <button className="iconbtn" onClick={closeModal} aria-label="关闭">
            ×
          </button>
        </div>
        <p>
          《{bookmark.title}》会从日常列表隐藏，但不会被立即清除。关联的待看记录仍保留网址与标题，
          不会因此复活收藏。
        </p>
        <div className="notice">删除后可在回收站恢复，原分类与未读状态会保留。</div>
        <div className="actions">
          <button className="btn" onClick={closeModal}>
            取消
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              const done = await run(() => service.deleteBookmark(bookmarkId), '已移到回收站。');
              if (done) closeModal();
            }}
          >
            移到回收站
          </button>
        </div>
      </div>
    </div>
  );
}

export function DetailDrawer({ bookmarkId }: { bookmarkId: string }) {
  const { data, service, closeDrawer, reload, run, openModal, toast, setDrawerDirty } = useWorkspace();
  const bookmark = data.bookmarks.find((entry) => entry.id === bookmarkId);
  const [draft, setDraft] = useState(() => makeDraft(bookmark));
  /**
   * 打开抽屉那一刻的版本号。
   * 保存必须用它做期望版本，而不是用实时最新的 localRevision：
   * 弹窗/其他标签页写入后主库会刷新，若拿最新版本号提交，本页的旧草稿会静默覆盖别人的修改。
   */
  const [baselineRevision, setBaselineRevision] = useState(() => bookmark?.localRevision ?? 0);
  const [stale, setStale] = useState(false);
  const [tagName, setTagName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const categoryName = useMemo(() => {
    if (!bookmark) return new Map<string, string>();
    return new Map(data.categories.map((category) => [category.id, category.name]));
  }, [bookmark, data.categories]);

  // 先算草稿状态再提前返回：Hook 不能放在条件分支后面。
  const dirty = bookmark ? isDirty(draft, bookmark) : false;

  // 把「有未保存修改」上报给上层，关闭按钮 / Escape / 切换页面据此拦截。
  useEffect(() => {
    setDrawerDirty(dirty);
    return () => setDrawerDirty(false);
  }, [dirty, setDrawerDirty]);

  if (!bookmark) return null;

  const categoryLocked = draft.lockedFields.includes('categoryId');
  const tagLocked = draft.lockedFields.includes('tagIds');

  const save = async () => {
    setError('');
    const titleLength = codePointLength(draft.title);
    if (titleLength > LIMITS.title) {
      setError(`标题最多 ${LIMITS.title} 个字符，当前 ${titleLength} 个。`);
      return;
    }
    const noteLength = codePointLength(draft.note);
    if (noteLength > LIMITS.note) {
      setError(`人工备注最多 ${LIMITS.note} 个字符，当前 ${noteLength} 个。`);
      return;
    }
    const descriptionLength = codePointLength(draft.sourceDescription);
    if (descriptionLength > LIMITS.sourceDescription) {
      setError(`来源描述最多 ${LIMITS.sourceDescription} 个字符，当前 ${descriptionLength} 个。`);
      return;
    }
    const textLength = codePointLength(draft.selectedText);
    if (textLength > LIMITS.selectedText) {
      setError(`选中文字最多 ${LIMITS.selectedText} 个字符，当前 ${textLength} 个。`);
      return;
    }
    if (!draft.title.trim()) {
      setError('标题不能为空。');
      return;
    }
    setBusy(true);
    try {
      const updated = await service.updateBookmark(
        bookmark.id,
        baselineRevision,
        {
          title: draft.title,
          sourceDescription: draft.sourceDescription,
          note: draft.note,
          selectedText: draft.selectedText,
          categoryId: draft.categoryId,
          tagIds: draft.tagIds,
          privacy: draft.privacy,
          lockedFields: draft.lockedFields,
          pinned: draft.pinned,
        },
        'human'
      );
      await reload();
      setBaselineRevision(updated.localRevision);
      setSavedAt(updated.updatedAt);
      setStale(false);
      notifyDataChanged();
      toast('已保存。', 'ok');
    } catch (cause) {
      if (isAppError(cause) && cause.code === 'REVISION_CONFLICT') {
        setError('这条收藏在别处被修改过。为避免覆盖别人的修改，请先载入最新版本，再重新编辑。');
        setStale(true);
      } else {
        setError(toUserMessage(cause));
      }
    } finally {
      setBusy(false);
    }
  };

  const addTag = async () => {
    const name = tagName.trim();
    if (!name) return;
    const tag = await run(() => service.createTag(name));
    setTagName('');
    if (!tag) return;
    if (draft.tagIds.includes(tag.id)) {
      toast('这个标签已经添加。', 'error');
      return;
    }
    setDraft({ ...draft, tagIds: [...draft.tagIds, tag.id] });
  };

  return (
    <aside
      className="drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="detail-title"
      data-focus-container="true"
      tabIndex={-1}
      style={{ zIndex: 45 }}
    >
      <div className="drawerhead">
        <span>收藏详情 · {bookmark.deletedAt ? '已删除' : '本地已保存'}</span>
        <button className="iconbtn" onClick={closeDrawer} aria-label="关闭详情">
          ×
        </button>
      </div>
      <div className="drawercontent">
        <div className="eyebrow" style={{ marginTop: 18 }}>
          {domainOf(bookmark.originalUrl)}
        </div>
        <h2 id="detail-title">{bookmark.title}</h2>
        <a
          href={isHttpUrl(bookmark.originalUrl) ? bookmark.originalUrl : undefined}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={isHttpUrl(bookmark.originalUrl) ? undefined : true}
          style={{ fontSize: 11, overflowWrap: 'anywhere' }}
          onClick={() => {
            if (!isHttpUrl(bookmark.originalUrl)) return;
            void service.touchOpened(bookmark.id);
          }}
        >
          {bookmark.originalUrl} {isHttpUrl(bookmark.originalUrl) ? '↗' : '（链接不可用）'}
        </a>

        <label className="field">
          <span>标题（必填，最多 {LIMITS.title} 字符）</span>
          <input
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            aria-invalid={!draft.title.trim() || codePointLength(draft.title) > LIMITS.title}
          />
          <small className={codePointLength(draft.title) > LIMITS.title ? 'overlimit' : undefined}>
            {codePointLength(draft.title)} / {LIMITS.title} 字符
            {codePointLength(draft.title) > LIMITS.title ? ` · 已超出 ${codePointLength(draft.title) - LIMITS.title}` : ''}
          </small>
        </label>

        <label className="field">
          <span>来源描述</span>
          <textarea
            value={draft.sourceDescription}
            onChange={(event) => setDraft({ ...draft, sourceDescription: event.target.value })}
            style={{ minHeight: 70 }}
          />
          <small>{codePointLength(draft.sourceDescription)} / {LIMITS.sourceDescription} 字符</small>
        </label>

        {bookmark.aiPurpose ? (
          <div className="field">
            <span>AI 用途（模型建议，应用后写入）</span>
            <p className="sample">{bookmark.aiPurpose}</p>
          </div>
        ) : null}

        <CategoryPicker
          value={draft.categoryId}
          onChange={(next) => setDraft({ ...draft, categoryId: next })}
          categories={data.categories}
          disabled={categoryLocked}
          label={`分类${categoryLocked ? ' · 人工锁定' : ''}`}
        />
        <label className="checkline">
          <input
            type="checkbox"
            checked={categoryLocked}
            onChange={(event) =>
              setDraft({ ...draft, lockedFields: toggleLock(draft.lockedFields, 'categoryId', event.target.checked) })
            }
          />
          锁定分类，AI 不得更改
        </label>

        <div className="field">
          <span>标签（最多 {LIMITS.tagsPerBookmark} 个）</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {draft.tagIds.length === 0 ? <span className="micro">还没有标签</span> : null}
            {draft.tagIds.map((tagId) => (
              <button
                key={tagId}
                className="tag"
                style={{ fontSize: 11 }}
                disabled={tagLocked}
                onClick={() =>
                  setDraft({ ...draft, tagIds: draft.tagIds.filter((id) => id !== tagId) })
                }
                title="移除标签"
              >
                {categoryName.get(tagId) ?? data.tags.find((tag) => tag.id === tagId)?.name ?? tagId} ×
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={tagName}
              onChange={(event) => setTagName(event.target.value)}
              placeholder="输入标签名称后添加"
              disabled={tagLocked}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void addTag();
                }
              }}
            />
            <button className="btn small" onClick={() => void addTag()} disabled={tagLocked}>
              添加
            </button>
          </div>
          {data.tags.length ? (
            <select
              aria-label="选择已有标签"
              value=""
              disabled={tagLocked}
              onChange={(event) => {
                const id = event.target.value;
                if (id && !draft.tagIds.includes(id)) {
                  setDraft({ ...draft, tagIds: [...draft.tagIds, id] });
                }
              }}
            >
              <option value="">从已有标签选择…</option>
              {data.tags
                .filter((tag) => !draft.tagIds.includes(tag.id))
                .map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
            </select>
          ) : null}
        </div>

        <label className="field">
          <span>人工备注（AI 不覆盖，最多 {LIMITS.note} 字符）</span>
          <textarea
            value={draft.note}
            onChange={(event) => setDraft({ ...draft, note: event.target.value })}
            style={{ minHeight: 90 }}
          />
          <small className={codePointLength(draft.note) > LIMITS.note ? 'overlimit' : undefined}>
            {codePointLength(draft.note)} / {LIMITS.note} 字符
          </small>
        </label>

        <label className="field">
          <span>主动保存的选中文字（最多 {LIMITS.selectedText} 个码点）</span>
          <textarea
            value={draft.selectedText}
            onChange={(event) => setDraft({ ...draft, selectedText: event.target.value })}
            placeholder="只有你主动粘贴或保存时才会有内容"
            style={{ minHeight: 80 }}
          />
          <small>{codePointLength(draft.selectedText)} / {LIMITS.selectedText}</small>
        </label>

        <div className="privacybox">
          <span className="label">隐私与使用范围</span>
          <label className="checkline">
            <input
              type="checkbox"
              checked={draft.privacy.localOnly}
              onChange={(event) =>
                setDraft({ ...draft, privacy: { ...draft.privacy, localOnly: event.target.checked } })
              }
            />
            本地专用（不进入 AI 材料与手机快照）
          </label>
          <label className="checkline">
            <input
              type="checkbox"
              checked={draft.privacy.aiBlocked}
              onChange={(event) =>
                setDraft({ ...draft, privacy: { ...draft.privacy, aiBlocked: event.target.checked } })
              }
            />
            禁止发送 AI
          </label>
          <label className="checkline">
            <input
              type="checkbox"
              checked={draft.pinned}
              onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })}
            />
            置顶这条收藏
          </label>
        </div>

        <p className="micro">
          创建于 {formatDateTime(bookmark.createdAt)} · 版本 {bookmark.localRevision}
          {savedAt ? ` · 上次保存 ${formatDateTime(savedAt)}` : ''}
        </p>
        {dirty ? <div className="notice">有未保存的修改，关闭前请保存或取消。</div> : null}
        <p className="alert" role="alert">
          {error}
        </p>
      </div>
      <div className="drawerfoot">
        <button className="btn" onClick={closeDrawer}>
          关闭
        </button>
        <button
          className="btn"
          onClick={() => {
            setDraft(makeDraft(bookmark));
            setBaselineRevision(bookmark.localRevision);
            setStale(false);
            setError('');
          }}
          disabled={!dirty && !stale}
        >
          {stale ? '载入最新版本' : '取消修改'}
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button
          className="btn small"
          onClick={() => openModal({ kind: 'delete-bookmark', bookmarkId: bookmark.id })}
        >
          移到回收站
        </button>
      </div>
    </aside>
  );
}

interface DetailDraft {
  title: string;
  sourceDescription: string;
  note: string;
  selectedText: string;
  categoryId: string | null;
  tagIds: string[];
  privacy: { localOnly: boolean; aiBlocked: boolean };
  lockedFields: ('categoryId' | 'tagIds' | 'aiPurpose')[];
  pinned: boolean;
}

function makeDraft(bookmark: Bookmark | undefined): DetailDraft {
  return {
    title: bookmark?.title ?? '',
    sourceDescription: bookmark?.sourceDescription ?? '',
    note: bookmark?.note ?? '',
    selectedText: bookmark?.selectedText ?? '',
    categoryId: bookmark?.categoryId ?? null,
    tagIds: bookmark ? [...bookmark.tagIds] : [],
    privacy: {
      localOnly: bookmark?.privacy.localOnly ?? false,
      aiBlocked: bookmark?.privacy.aiBlocked ?? false,
    },
    lockedFields: bookmark ? [...bookmark.lockedFields] : [],
    pinned: bookmark?.pinned ?? false,
  };
}

function isDirty(draft: DetailDraft, bookmark: Bookmark): boolean {
  return (
    draft.title !== bookmark.title ||
    draft.sourceDescription !== bookmark.sourceDescription ||
    draft.note !== bookmark.note ||
    draft.selectedText !== bookmark.selectedText ||
    draft.categoryId !== bookmark.categoryId ||
    draft.tagIds.length !== bookmark.tagIds.length ||
    draft.tagIds.some((tag, index) => tag !== bookmark.tagIds[index]) ||
    draft.privacy.localOnly !== bookmark.privacy.localOnly ||
    draft.privacy.aiBlocked !== bookmark.privacy.aiBlocked ||
    draft.lockedFields.join(',') !== bookmark.lockedFields.join(',') ||
    draft.pinned !== bookmark.pinned
  );
}

function toggleLock(
  locked: ('categoryId' | 'tagIds' | 'aiPurpose')[],
  field: 'categoryId' | 'tagIds' | 'aiPurpose',
  on: boolean
): ('categoryId' | 'tagIds' | 'aiPurpose')[] {
  return on ? [...new Set([...locked, field])] : locked.filter((entry) => entry !== field);
}

export function CategoriesModal() {
  const { data, service, closeModal, run, navigate, toast } = useWorkspace();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'top' | 'branch' | 'leaf' | 'pinned' | 'nonempty' | 'empty'>('all');
  const [sort, setSort] = useState<'manual' | 'name' | 'count'>('manual');
  const [newName, setNewName] = useState('');
  const [newParent, setNewParent] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [deleteTree, setDeleteTree] = useState(false);
  const [deleteFingerprint, setDeleteFingerprint] = useState('');
  useEffect(() => setPage(1), [search, filter, sort]);
  const descendants = (id: string) => { const ids = new Set([id]); let changed = true; while (changed) { changed = false; for (const row of data.categories) if (row.parentId && ids.has(row.parentId) && !ids.has(row.id)) { ids.add(row.id); changed = true; } } return ids; };

  const [editing, setEditing] = useState<{ id: string; name: string; description: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [migrateTo, setMigrateTo] = useState<string>('');
  const pinned = data.settings.pinnedCategoryIds;

  const counts = new Map<string, number>();
  for (const bookmark of data.bookmarks) {
    const key = bookmark.categoryId ?? 'uncategorized';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const totals = new Map(data.categories.map((row) => [row.id, [...descendants(row.id)].reduce((sum, id) => sum + (counts.get(id) ?? 0), 0)]));
  const matched = data.categories.filter((category) => {
    const branch = data.categories.some((row) => row.parentId === category.id);
    return categoryPath(data.categories, category.id).toLowerCase().includes(search.trim().toLowerCase()) &&
      (filter === 'all' || filter === 'top' && !category.parentId || filter === 'branch' && branch || filter === 'leaf' && !branch || filter === 'pinned' && pinned.includes(category.id) || filter === 'nonempty' && (totals.get(category.id) ?? 0) > 0 || filter === 'empty' && (totals.get(category.id) ?? 0) === 0);
  });
  const visible = new Set(matched.map((row) => row.id));
  const filtered = Boolean(search.trim()) || filter !== 'all';
  if (filtered) for (const category of matched) { let id = category.parentId; const seen = new Set<string>(); while (id && !seen.has(id)) { seen.add(id); visible.add(id); id = data.categories.find((row) => row.id === id)?.parentId; } }
  const rows: (Category & { depth: number })[] = [];
  const visit = (parent: string | null, depth = 0, seen = new Set<string>()) => {
    const siblings = data.categories.filter((row) => (row.parentId ?? null) === parent && visible.has(row.id) && !seen.has(row.id));
    siblings.sort((a,b) => sort === 'count' ? (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0) || a.name.localeCompare(b.name) : sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
    for (const row of siblings) { rows.push({ ...row, depth }); if (filtered || expanded.has(row.id)) visit(row.id, depth + 1, new Set([...seen, row.id])); }
  };
  visit(null);
  const paged = paginate(rows, page, data.settings.pageSize);
  const removedIds = deleting ? deleteTree ? descendants(deleting) : new Set([deleting]) : new Set<string>();
  const deletionCount = [...removedIds].reduce((sum, id) => sum + (counts.get(id) ?? 0), 0);

  const togglePin = async (categoryId: string) => {
    const isPinned = pinned.includes(categoryId);
    if (!isPinned && pinned.length >= LIMITS.pinnedCategories) {
      toast(`左侧最多置顶 ${LIMITS.pinnedCategories} 个分类。`, 'error');
      return;
    }
    const next = isPinned ? pinned.filter((id) => id !== categoryId) : [...pinned, categoryId];
    await run(() => service.setPinnedCategories(next), isPinned ? '已取消置顶。' : '已置顶。');
  };

  const moveUp = async (categoryId: string) => {
    const index = pinned.indexOf(categoryId);
    if (index <= 0) return;
    const next = [...pinned];
    const previous = next[index - 1];
    if (!previous) return;
    next[index - 1] = categoryId;
    next[index] = previous;
    await run(() => service.setPinnedCategories(next));
  };

  const createCategory = async () => {
    const name = newName.trim();
    if (!name) return;
    const created = await run(() => service.createCategory(name, '', newParent || null), '已创建分类。');
    if (created) setNewName('');
  };

  return (
    <div className="modalshade" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeModal();
    }}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="cat-title">
        <div className="modalheader">
          <h2 id="cat-title">全部分类</h2>
          <button className="btn small" onClick={closeModal}>
            完成
          </button>
        </div>
        <p className="micro">
          左侧目录树显示全部分类，默认折叠，无数量上限；置顶另提供最多 {LIMITS.pinnedCategories} 个快捷入口。这里按层级管理，删除分类会保留收藏。
        </p>
        <div className="toolbar">
          <input
            placeholder="搜索分类…"
            aria-label="搜索分类"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            style={{ maxWidth: 260 }}
          />
          <select aria-label="筛选分类" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
            <option value="all">全部分类</option>
            <option value="top">顶层大类</option><option value="branch">含子分类</option><option value="leaf">末级分类</option><option value="empty">空分类（含子级无收藏）</option><option value="pinned">已置顶</option>
            <option value="nonempty">有收藏（含子级）</option>
          </select>
          <select aria-label="分类排序" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
            <option value="manual">按手动顺序</option><option value="name">按名称</option>
            <option value="count">按收藏数</option>
          </select>
          <span className="spacer" />
        </div>

        <div style={{ maxHeight: '46vh', overflow: 'auto' }}>
          {rows.length === 0 ? <p className="micro">没有匹配的分类。</p> : null}
          {paged.rows.map((category) => (
            <div className="rule-row" key={category.id}>
              <button className="iconbtn" style={{ marginLeft: Math.min(category.depth, 5) * 14 }} aria-label={`展开或收起 ${category.name}`} aria-expanded={expanded.has(category.id)} disabled={!data.categories.some((row) => row.parentId === category.id) || filtered} onClick={() => setExpanded((current) => { const next = new Set(current); next.has(category.id) ? next.delete(category.id) : next.add(category.id); return next; })}>{data.categories.some((row) => row.parentId === category.id) ? expanded.has(category.id) || filtered ? '▾' : '▸' : '·'}</button>
              <strong>
                {editing?.id === category.id ? (
                  <input
                    value={editing.name}
                    onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                    aria-label="分类名称"
                  />
                ) : (
                  <>
                    {category.name}
                    <small title={categoryPath(data.categories, category.id)}>{category.parentId ? `上级：${categoryPath(data.categories, category.parentId)}` : '顶层分类'} · {data.categories.filter((row) => row.parentId === category.id).length} 个子分类</small>
                  </>
                )}
              </strong>
              <small title="包含子分类中的收藏">{totals.get(category.id) ?? 0} 条（含子级）</small>
              {editing?.id === category.id ? (
                <>
                  <button
                    className="btn small primary"
                    onClick={async () => {
                      const done = await run(
                        () => service.renameCategory(category.id, { name: editing.name }),
                        '分类已改名，收藏引用不变。'
                      );
                      if (done) setEditing(null);
                    }}
                  >
                    保存
                  </button>
                  <button className="btn small" onClick={() => setEditing(null)}>
                    取消
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="btn small"
                    onClick={() =>
                      setEditing({ id: category.id, name: category.name, description: category.description })
                    }
                  >
                    改名
                  </button>
                  <button className="btn small" onClick={() => void togglePin(category.id)}>
                    {pinned.includes(category.id) ? '取消置顶' : '置顶'}
                  </button>
                  {pinned.includes(category.id) && pinned.indexOf(category.id) > 0 ? (
                    <button className="btn small" onClick={() => void moveUp(category.id)} aria-label="上移">
                      ↑
                    </button>
                  ) : null}
                  <button
                    className="btn small"
                    onClick={() => {
                      closeModal();
                      navigate(`cat:${category.id}`);
                    }}
                  >
                    进入
                  </button>
                  <button className="btn small danger" onClick={() => { setDeleting(category.id); setDeleteFingerprint(categoryFingerprint(data.categories)); setDeleteTree(false); setMigrateTo(''); }}>
                    删除
                  </button>
                </>
              )}
            </div>
          ))}
        </div>

        <Pager page={paged.page} pageCount={paged.pageCount} total={paged.total} from={paged.from} to={paged.to} pageSize={data.settings.pageSize} onPage={setPage} onPageSize={(size) => { setPage(1); void run(() => service.setPageSize(size)); }} />
        {deleting ? (
          <div className="notice danger">
            <strong>删除「{data.categories.find((category) => category.id === deleting)?.name}」</strong>
            <label className="field"><span>删除范围</span><select aria-label="删除分类范围" value={deleteTree ? 'tree' : 'single'} onChange={(event) => { setDeleteTree(event.target.value === 'tree'); setMigrateTo(''); }}><option value="single">只删除这一层，子分类提升一级</option><option value="tree">删除整个大类及所有子分类（保留收藏）</option></select></label>
            <p>将删除 {removedIds.size} 个分类；其中 {deletionCount} 条现有收藏迁移到下方目标，回收站中的引用也会迁移。收藏不会删除。{!deleteTree && '子分类及其内容保留，提升至当前分类的上级。'}</p><p>分类结构删除不能通过回收站恢复，建议先导出备份。只删一层时如出现同级重名，整次操作会停止。</p>{deleteFingerprint !== categoryFingerprint(data.categories) && <p role="alert">分类结构已变化，请取消后重新选择删除范围。</p>}
            <select
              aria-label="迁移到"
              value={migrateTo}
              onChange={(event) => setMigrateTo(event.target.value)}
              style={{ maxWidth: 200 }}
            >
              <option value="">迁移到未分类</option>
              {data.categories
                .filter((category) => !removedIds.has(category.id))
                .map((category) => (
                  <option key={category.id} value={category.id}>
                    {categoryPath(data.categories, category.id)}
                  </option>
                ))}
            </select>
            <button
              className="btn small danger"
              disabled={deleteFingerprint !== categoryFingerprint(data.categories)}
              onClick={async () => {
                const done = await run(
                  () => service.removeCategory(deleting, migrateTo || null, { includeDescendants: deleteTree, fingerprint: deleteFingerprint }),
                  '分类已删除，收藏已迁移。'
                );
                if (done) {
                  setDeleting(null);
                  setMigrateTo('');
                }
              }}
            >
              确认删除
            </button>
            <button className="btn small" onClick={() => setDeleting(null)}>
              取消
            </button>
          </div>
        ) : null}

        <h3>新建分类</h3>
        <div className="category-create-form"><label className="field"><span>上级分类</span><select aria-label="新分类的上级" value={newParent} onChange={(event) => setNewParent(event.target.value)}><option value="">最外层（顶层分类）</option>{data.categories.map((row) => <option value={row.id} key={row.id}>{categoryPath(data.categories, row.id)}</option>)}</select></label><label className="field"><span>分类名称</span>
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="分类名称"
            maxLength={LIMITS.categoryName}
          />
          </label><button className="btn primary" onClick={() => void createCategory()}>
            创建
          </button>
        </div>
        <p className="micro">创建后归入所选上级；同一上级下名称不能重复。跨分类的主题请使用标签。</p>
      </div>
    </div>
  );
}

/**
 * 未保存离开提醒。
 * 关闭抽屉、按 Escape、切换左侧页面时都会走到这里，由用户明确选择继续编辑还是丢草稿。
 */
export function DiscardEditsModal() {
  const { resolveDiscard } = useWorkspace();
  return (
    <div className="modalshade" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="discard-title">
        <div className="modalheader">
          <h2 id="discard-title">还有未保存的修改</h2>
          <button className="iconbtn" onClick={() => resolveDiscard(false)} aria-label="关闭">
            ×
          </button>
        </div>
        <p>这条收藏的改动还没有写入主库。放弃后不会保留草稿，也不会影响已有内容。</p>
        <div className="actions">
          <button className="btn primary" onClick={() => resolveDiscard(false)}>
            继续编辑
          </button>
          <button className="btn danger" onClick={() => resolveDiscard(true)}>
            放弃修改并离开
          </button>
        </div>
      </div>
    </div>
  );
}

/** 一条都处理不了时说清是哪一种情况，而不是笼统地让人以为条件选错了。 */
function cleanupHint(preview: CleanupPreview): string {
  if (preview.matched === 0) return '当前条件下没有命中任何记录，换个范围或筛选再试。';
  if (preview.byState.trashed > 0 && preview.mode === 'trash') {
    return '命中的记录都在回收站里：移入回收站对它们没有意义，只能彻底删除。';
  }
  return '命中的记录都不在这个动作的处理范围里（已转收藏、已完成或已不存在）。';
}

/**
 * 按条件清理。
 *
 * 从分类页 / 未分类 / 待看页进来时范围已经带好，也可以在这里改成别的范围——
 * 但改范围等于改「这次要清哪一段」，所以一改就清空筛选与已冻结的预览，不让旧数字留着。
 */
export function CleanupModal({ scope: initialScope }: { scope: CleanupScope }) {
  const { data, service, closeModal, run, toast } = useWorkspace();
  const [scopeKind, setScopeKind] = useState<CleanupScopeKind>(initialScope.kind);
  const [categoryId, setCategoryId] = useState(initialScope.categoryId ?? '');
  const [presence, setPresence] = useState<CleanupPresence>('active');
  const [modification, setModification] = useState<CleanupModification>('any');
  const [folder, setFolder] = useState('');
  const [site, setSite] = useState('');
  const [view, setView] = useState<CleanupScopeView | null>(null);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [busy, setBusy] = useState(false);

  const scope: CleanupScope =
    scopeKind === 'category' ? { kind: 'category', categoryId } : { kind: scopeKind };

  useEffect(() => {
    let alive = true;
    const next: CleanupScope =
      scopeKind === 'category' ? { kind: 'category', categoryId } : { kind: scopeKind };
    setLoading(true);
    service
      .readCleanupScope(next)
      .then((value) => {
        if (alive) setView(value);
      })
      .catch((error) => toast(toUserMessage(error), 'error'))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // 只随范围回库；目录 / 站点 / 改动筛选都在本地算，数字与预览用同一个判定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKind, categoryId, service]);

  // 换范围不能留着上一段的筛选与冻结结果——那会让「确认 3 条」指向另一批记录。
  useEffect(() => {
    setFolder('');
    setSite('');
    setPreview(null);
    setResult(null);
  }, [scopeKind, categoryId]);

  const rows = view?.rows ?? [];
  const criteria: CleanupCriteria = {
    scope,
    // 待看没有回收站，三态对它没有意义；预览与执行都按 active 处理，避免出现「只看回收站」的空结果。
    presence: scopeKind === 'reading' ? 'active' : presence,
    modification,
    folders: folder ? [folder === NO_FOLDER ? '' : folder] : [],
    sites: site ? [site] : [],
    mode: 'trash',
  };
  const matched = rows.filter((row) => matchesCleanupCriteria(row, criteria));
  const destination = scopeKind === 'reading' ? 'reading' : 'library';
  const trashable = matched.filter((row) => isBatchCleanupActionable(row.state, destination, 'trash'));
  const deletable = matched.filter((row) => isBatchCleanupActionable(row.state, destination, 'delete'));
  const modifiedCount = matched.filter((row) => row.state === 'modified').length;
  const trashedCount = matched.filter((row) => row.state === 'trashed').length;
  // 彻底删除是范围最宽的动作：连它都不处理的，才真的不在这里动。
  const outOfScope = matched.length - deletable.length;

  const start = async (mode: BatchCleanupMode) => {
    setBusy(true);
    setResult(null);
    try {
      const next = await service.previewCleanup({ ...criteria, mode });
      if (next.actionable === 0) {
        toast(cleanupHint(next), 'error');
        return;
      }
      setPreview(next);
    } catch (error) {
      toast(toUserMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    // run 会刷新主库快照并通知其它标签页：删完必须让列表跟着变，不能只改这个弹窗。
    const outcome = await run(() => service.cleanupScope(preview.token));
    setBusy(false);
    if (!outcome) return;
    setResult(outcome);
    setPreview(null);
    try {
      setView(await service.readCleanupScope(scope));
    } catch {
      // 读不回来就保留旧视图：结果面板已经写明删了多少，不必为此再弹一个错。
    }
  };

  return (
    <div className="modalshade" role="presentation">
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="cleanup-title">
        <div className="modalheader">
          <h2 id="cleanup-title">按条件清理</h2>
          <button className="iconbtn" onClick={closeModal} aria-label="关闭">
            ×
          </button>
        </div>

        {result ? (
          <div className="notice">
            <strong>已处理 {result.removed} 条。</strong>
            {result.skipped.length > 0 ? (
              <span>
                跳过 {result.skipped.length} 条：
                {result.skipped
                  .slice(0, 6)
                  .map((row) => `${row.title || row.entityId}（${row.reason}）`)
                  .join('；')}
                {result.skipped.length > 6 ? ' 等' : ''}。
              </span>
            ) : null}
            <span>
              {result.snapshotId
                ? '已留下清理快照，可在「数据与备份 → 最近清理」里按次找回。'
                : '这些记录在回收站里，需要时可以单独恢复。'}
            </span>
            <div className="actions">
              <button className="btn small" onClick={() => setResult(null)}>
                再清一次
              </button>
              <button className="btn small primary" onClick={closeModal}>
                完成
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="micro">
              范围从你进来的那一页带过来，也可以在这里改。清理前会先算清「命中多少、这个动作能处理多少」，
              数字和真正执行的清单是同一份。
            </p>

            <div className="field">
              <span>范围</span>
              <select
                aria-label="清理范围"
                value={scopeKind === 'category' ? `cat:${categoryId}` : scopeKind}
                onChange={(event) => {
                  const next = event.target.value;
                  if (next.startsWith('cat:')) {
                    setScopeKind('category');
                    setCategoryId(next.slice(4));
                  } else {
                    setScopeKind(next as CleanupScopeKind);
                    setCategoryId('');
                  }
                }}
              >
                <option value="all">全部收藏</option>
                <option value="uncategorized">未分类</option>
                <option value="reading">待看（未读完）</option>
                {data.categories.map((category) => (
                  <option key={category.id} value={`cat:${category.id}`}>
                    分类：{categoryPath(data.categories, category.id)}
                  </option>
                ))}
              </select>
            </div>

            {scopeKind !== 'reading' ? (
              <div className="field">
                <span>包含</span>
                <select
                  aria-label="清理范围的三态"
                  value={presence}
                  onChange={(event) => {
                    setPresence(event.target.value as CleanupPresence);
                    setPreview(null);
                  }}
                >
                  <option value="active">只看正常（不含回收站）</option>
                  <option value="both">正常 + 回收站</option>
                  <option value="trashed">只看回收站</option>
                </select>
              </div>
            ) : null}

            <div className="field">
              <span>改动</span>
              <select
                aria-label="清理改动筛选"
                value={modification}
                onChange={(event) => {
                  setModification(event.target.value as CleanupModification);
                  setPreview(null);
                }}
              >
                <option value="any">全部（含改过的）</option>
                <option value="untouched">只看没改过的</option>
                <option value="modified">只看改过的</option>
              </select>
            </div>

            {scopeKind !== 'reading' && (view?.folders.length ?? 0) > 0 ? (
              <div className="field">
                <span>原始目录</span>
                <select
                  aria-label="清理原始目录"
                  value={folder}
                  onChange={(event) => {
                    setFolder(event.target.value);
                    setPreview(null);
                  }}
                >
                  <option value="">全部目录</option>
                  {view?.folders.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                  {rows.some((row) => !row.folder) ? (
                    <option value={NO_FOLDER}>（无目录）</option>
                  ) : null}
                </select>
              </div>
            ) : null}

            {(view?.sites.length ?? 0) > 0 ? (
              <div className="field">
                <span>站点</span>
                <select
                  aria-label="清理站点"
                  value={site}
                  onChange={(event) => {
                    setSite(event.target.value);
                    setPreview(null);
                  }}
                >
                  <option value="">全部站点</option>
                  {view?.sites.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {loading ? (
              <p className="micro">正在读取这一范围的记录…</p>
            ) : (
              <>
                <span>
                  {view?.label ?? '当前范围'}共 {view?.total ?? 0} 条；当前条件命中 {matched.length} 条
                  {scopeKind === 'reading' ? (
                    <>，可从待看移除 {deletable.length} 条</>
                  ) : (
                    <>
                      ，可移入回收站 {trashable.length} 条，可彻底删除 {deletable.length} 条
                    </>
                  )}
                  {modifiedCount > 0 ? `（其中已改动 ${modifiedCount} 条）` : ''}
                  {trashedCount > 0 ? `，含回收站 ${trashedCount} 条` : ''}
                  {outOfScope > 0 ? `；另有 ${outOfScope} 条不在这里处理` : ''}。
                </span>

                {presence === 'trashed' && scopeKind !== 'reading' ? (
                  <span className="micro">
                    回收站里的记录只能彻底删除：移入回收站对它们没有意义。彻底删除会连删除标记一起清，
                    之后同一网址可以重新导入；动手前会先留一份清理快照。
                  </span>
                ) : null}
                {modification === 'modified' ? (
                  <span className="micro">
                    只处理导入或新建之后改过的记录；确认前会冻结版本，冻结之后又被改的仍会跳过并报出来。
                  </span>
                ) : null}

                {matched.length > 0 ? (
                  <div className="listbox">
                    <div className="listhead">
                      <span>命中的记录</span>
                      <span>状态 · 站点 · 目录</span>
                    </div>
                    {matched.slice(0, 8).map((row) => (
                      <article className="bookmark" key={`${row.kind}:${row.entityId}`}>
                        <div className="favicon" aria-hidden="true">
                          {row.folder ? row.folder.slice(0, 1) : '—'}
                        </div>
                        <div className="rowbody" role="group">
                          <h3>{row.title || '（无标题）'}</h3>
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
                            {row.categoryName ? (
                              <>
                                <span>·</span>
                                <span>{row.categoryName}</span>
                              </>
                            ) : null}
                          </div>
                        </div>
                      </article>
                    ))}
                    {matched.length > 8 ? (
                      <p className="micro">只列前 8 条示例；处理范围按全部命中，不是这 8 条。</p>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}

            {preview ? (
              <div className="notice">
                <strong>确认处理 {preview.actionable} 条？</strong>
                <span>
                  范围：{preview.token.label}；命中 {preview.matched} 条
                  {preview.actionableByState.modified > 0
                    ? `，其中 ${preview.actionableByState.modified} 条改过，会按当前内容一起处理`
                    : ''}
                  {preview.protectedCount > 0
                    ? `；另有 ${preview.protectedCount} 条不在这个动作的处理范围里`
                    : ''}
                  。
                </span>
                <span>
                  {preview.mode === 'delete' || scopeKind === 'reading'
                    ? `彻底删除：连删除标记一起清${
                        preview.actionableByState.trashed > 0
                          ? `（含 ${preview.actionableByState.trashed} 条已在回收站里的）`
                          : ''
                      }，之后可以重新导入；动手前会先写一份本机清理快照，写不进去就一条都不删。`
                    : '移入回收站：可以撤销，需要时在回收站里单独恢复；已经在回收站里的记录不在这次范围里。'}
                </span>
                <span className="micro">
                  范围冻结于 {formatDateTime(preview.frozenAt)}。此后新增的命中不会纳入这次处理；
                  预览后又被改动或挪进回收站的条目会自动跳过并报出来。
                </span>
                <div className="actions">
                  <button className="btn small danger" disabled={busy} onClick={() => void confirm()}>
                    {busy ? '处理中…' : `确认处理 ${preview.actionable} 条`}
                  </button>
                  <button className="btn small" onClick={() => setPreview(null)}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div className="actions">
                {scopeKind !== 'reading' ? (
                  <button
                    className="btn danger"
                    disabled={busy || trashable.length === 0}
                    onClick={() => void start('trash')}
                  >
                    移入回收站 {trashable.length} 条
                  </button>
                ) : null}
                <button
                  className={`btn ${scopeKind === 'reading' ? 'danger' : ''}`}
                  disabled={busy || deletable.length === 0}
                  onClick={() => void start('delete')}
                >
                  {scopeKind === 'reading'
                    ? `从待看移除 ${deletable.length} 条…`
                    : `彻底删除 ${deletable.length} 条…`}
                </button>
                <button className="btn" onClick={closeModal}>
                  关闭
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function ModalHost() {
  const { modal } = useWorkspace();
  if (!modal) return null;
  switch (modal.kind) {
    case 'new-bookmark':
      return <NewBookmarkModal initialUrl={modal.url ?? ''} />;
    case 'add-reading':
      return <AddReadingModal />;
    case 'convert-reading':
      return <ConvertReadingModal readingId={modal.readingId} {...(modal.categoryId !== undefined ? { categoryId: modal.categoryId } : {})} />;
    case 'delete-bookmark':
      return <DeleteBookmarkModal bookmarkId={modal.bookmarkId} />;
    case 'categories':
      return <CategoriesModal />;
    case 'cleanup':
      return <CleanupModal scope={modal.scope} />;
    case 'discard-edits':
      return <DiscardEditsModal />;
    default:
      return null;
  }
}
