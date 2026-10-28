import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toUserMessage } from '@shiye/core';
import type { WorkspaceService, WorkspaceSnapshot } from '@shiye/application';
import { notifyDataChanged, subscribeDataChanged } from '@shiye/application';

export type ModalState =
  | { kind: 'new-bookmark'; url?: string }
  | { kind: 'categories' }
  | { kind: 'add-reading' }
  | { kind: 'convert-reading'; readingId: string }
  | { kind: 'delete-bookmark'; bookmarkId: string }
  | { kind: 'category-editor'; categoryId?: string }
  /** 抽屉里有未保存的修改，离开前要求用户明确选择。 */
  | { kind: 'discard-edits' }
  | null;

interface ToastMessage {
  text: string;
  kind: 'ok' | 'error';
}

interface WorkspaceContextValue {
  data: WorkspaceSnapshot;
  service: WorkspaceService;
  route: string;
  query: string;
  drawerId: string | null;
  modal: ModalState;
  reload: () => Promise<void>;
  navigate: (route: string) => void;
  setQuery: (value: string) => void;
  openBookmark: (id: string) => void;
  closeDrawer: () => void;
  openModal: (modal: ModalState) => void;
  closeModal: () => void;
  toast: (text: string, kind?: 'ok' | 'error') => void;
  run: <T>(task: () => Promise<T>, success?: string) => Promise<T | null>;
  /** 详情抽屉上报「有未保存修改」，离开前据此拦截。 */
  setDrawerDirty: (dirty: boolean) => void;
  /** 未保存提醒的选择结果：true 放弃修改继续离开，false 留在当前页。 */
  resolveDiscard: (discard: boolean) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('WorkspaceProvider 未挂载');
  return value;
}

export function WorkspaceProvider({
  service,
  initialData,
  children,
}: {
  service: WorkspaceService;
  initialData: WorkspaceSnapshot;
  children: ReactNode;
}) {
  const [data, setData] = useState<WorkspaceSnapshot>(initialData);
  const [route, setRoute] = useState(() => {
    const hash = window.location.hash.replace(/^#/, '');
    return hash || 'home';
  });
  const [query, setQueryState] = useState('');
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [toastState, setToastState] = useState<ToastMessage | null>(null);
  const timer = useRef<number | null>(null);
  const [drawerDirty, setDrawerDirtyState] = useState(false);
  /**
   * 被未保存提醒暂扣的离开动作。
   * 用 ref 而不是 state：它只给 resolveDiscard 读，不需要触发渲染。
   */
  const pendingLeave = useRef<null | { action: 'close' } | { action: 'navigate'; route: string }>(null);

  const reload = useCallback(async () => {
    const next = await service.snapshot();
    setData(next);
  }, [service]);

  const toast = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    setToastState({ text, kind });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToastState(null), 3600);
  }, []);

  const run = useCallback(
    async <T,>(task: () => Promise<T>, success?: string): Promise<T | null> => {
      try {
        const result = await task();
        await reload();
        // 通知其他标签页 / 弹窗：主库已变。
        notifyDataChanged();
        if (success) toast(success, 'ok');
        return result;
      } catch (error) {
        toast(toUserMessage(error), 'error');
        return null;
      }
    },
    [reload, toast]
  );

  const navigate = useCallback(
    (next: string) => {
      // 抽屉里有未保存的修改时，切页等于丢弃草稿，必须让用户先确认。
      if (drawerId && drawerDirty && next !== route) {
        pendingLeave.current = { action: 'navigate', route: next };
        setModal({ kind: 'discard-edits' });
        return;
      }
      setRoute(next);
      setQueryState('');
      setDrawerId(null);
      setDrawerDirtyState(false);
      setModal(null);
      document.body.classList.remove('menu-open');
      window.history.replaceState(null, '', `#${next}`);
      window.scrollTo({ top: 0 });
    },
    [drawerId, drawerDirty, route]
  );

  const closeDrawer = useCallback(() => {
    if (drawerDirty) {
      pendingLeave.current = { action: 'close' };
      setModal({ kind: 'discard-edits' });
      return;
    }
    setDrawerId(null);
  }, [drawerDirty]);

  const resolveDiscard = useCallback(
    (discard: boolean) => {
      const pending = pendingLeave.current;
      pendingLeave.current = null;
      setModal(null);
      if (!discard) return;
      setDrawerDirtyState(false);
      setDrawerId(null);
      if (pending?.action === 'navigate') {
        setRoute(pending.route);
        setQueryState('');
        document.body.classList.remove('menu-open');
        window.history.replaceState(null, '', `#${pending.route}`);
        window.scrollTo({ top: 0 });
      }
    },
    []
  );

  const setDrawerDirty = useCallback((dirty: boolean) => {
    setDrawerDirtyState(dirty);
  }, []);

  const setQuery = useCallback((value: string) => {
    setQueryState(value);
    if (value.trim()) setRoute('search');
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        document.getElementById('globalSearch')?.focus();
      }
      if (event.key === 'Escape') {
        // Escape 也要走同一套未保存检查：直接关掉抽屉等于静默丢弃草稿。
        if (modal) {
          setModal(null);
          pendingLeave.current = null;
          return;
        }
        if (document.body.classList.contains('menu-open')) {
          document.body.classList.remove('menu-open');
          return;
        }
        if (drawerId) closeDrawer();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modal, drawerId, closeDrawer]);

  // 弹窗或右键菜单写入主库后，已打开的工作台不能继续显示旧快照。
  // 广播负责即时更新，聚焦/可见性变化负责兜底（频道不可用时也能刷新）。
  useEffect(() => {
    const refresh = () => {
      void reload();
    };
    const unsubscribe = subscribeDataChanged(refresh);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);

  // 支持外部通过 workspace.html#inbox 这类地址直接进入某一页，也支持浏览器前进/后退。
  useEffect(() => {
    const onHashChange = () => {
      setRoute(window.location.hash.replace(/^#/, '') || 'home');
      setQueryState('');
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      data,
      service,
      route,
      query,
      drawerId,
      modal,
      reload,
      navigate,
      setQuery,
      openBookmark: (id) => setDrawerId(id),
      closeDrawer,
      openModal: (next) => setModal(next),
      closeModal: () => setModal(null),
      toast,
      run,
      setDrawerDirty,
      resolveDiscard,
    }),
    [
      data,
      service,
      route,
      query,
      drawerId,
      modal,
      reload,
      navigate,
      setQuery,
      toast,
      run,
      closeDrawer,
      setDrawerDirty,
      resolveDiscard,
    ]
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
      {toastState ? (
        <div className={`toast ${toastState.kind === 'error' ? 'error' : ''}`} role="status">
          {toastState.text}
        </div>
      ) : null}
    </WorkspaceContext.Provider>
  );
}
