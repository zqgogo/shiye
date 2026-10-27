import { createRoot } from 'react-dom/client';
import { createWorkspaceService } from '@shiye/application';
import { createShiyeStore } from '@shiye/storage';
import { Popup } from './Popup.js';
import '../../../workspace/src/styles.css';

async function boot(): Promise<void> {
  const element = document.getElementById('root');
  if (!element) return;
  const root = createRoot(element);
  try {
    const store = createShiyeStore();
    await store.db.open();
    const service = createWorkspaceService(store.repos);
    root.render(<Popup service={service} />);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    root.render(
      <div className="popupframe">
        <h2>主库未能打开</h2>
        <p className="micro">没有创建空库掩盖错误。请打开工作台查看详情或稍后重试。</p>
        <div className="notice danger">{message}</div>
      </div>
    );
  }
}

void boot();
