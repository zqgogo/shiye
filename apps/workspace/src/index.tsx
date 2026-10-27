import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createWorkspaceService } from '@shiye/application';
import { createShiyeStore } from '@shiye/storage';
import { App } from './App.js';
import { BootError } from './BootError.js';
import { WorkspaceProvider } from './state.js';
import './styles.css';

let mounted: Root | null = null;

/**
 * 工作台入口。弹窗、service worker 与这里使用同一个扩展 origin 的 IndexedDB 主库。
 * 打开数据库失败时不创建空库掩盖错误，而是显示错误与重试。
 */
export async function mountWorkspace(element: HTMLElement): Promise<void> {
  if (mounted) mounted.unmount();
  const root = createRoot(element);
  mounted = root;
  try {
    const store = createShiyeStore();
    await store.db.open();
    const service = createWorkspaceService(store.repos);
    const initialData = await service.snapshot();
    root.render(
      <StrictMode>
        <WorkspaceProvider service={service} initialData={initialData}>
          <App />
        </WorkspaceProvider>
      </StrictMode>
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    root.render(
      <StrictMode>
        <BootError
          message={message}
          onRetry={() => {
            root.unmount();
            void mountWorkspace(element);
          }}
        />
      </StrictMode>
    );
  }
}
