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

  const navigate = useCallback((next: string) => {
    setRoute(next);
    setQueryState('');
    setDrawerId(null);
    setModal(null);
    document.body.classList.remove('menu-open');
    window.history.replaceState(null, '', `#${next}`);
    window.scrollTo({ top: 0 });
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
        setModal(null);
        setDrawerId(null);
        document.body.classList.remove('menu-open');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
      closeDrawer: () => setDrawerId(null),
      openModal: (next) => setModal(next),
      closeModal: () => setModal(null),
      toast,
      run,
    }),
    [data, service, route, query, drawerId, modal, reload, navigate, setQuery, toast, run]
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
