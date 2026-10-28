import { Sidebar, Topbar } from './components.js';
import { ModalHost, DetailDrawer } from './dialogs.js';
import { useWorkspace } from './state.js';
import {
  HomePage,
  ListPage,
  ReadingHistoryPage,
  ReadingPage,
  RulesPage,
  SearchPage,
  SettingsPage,
} from './pages.js';
import { CapturePage } from './capture.js';
import { DataPage } from './data.js';
import { AiConfigPage, AiPage, AskPage, OrganizePage } from './ai.js';

function CurrentPage() {
  const { route } = useWorkspace();
  if (route === 'home') return <HomePage />;
  if (route === 'inbox') return <ListPage mode="inbox" />;
  if (route === 'uncategorized') return <ListPage mode="uncategorized" />;
  if (route === 'all') return <ListPage mode="all" />;
  if (route === 'recent') return <ListPage mode="recent" />;
  if (route === 'trash') return <ListPage mode="trash" />;
  if (route.startsWith('cat:')) return <ListPage mode="category" categoryId={route.slice(4)} />;
  if (route === 'reading') return <ReadingPage />;
  if (route === 'reading-history') return <ReadingHistoryPage />;
  if (route === 'search') return <SearchPage />;
  // 两个路由是同一个组件，用 key 强制重建，避免切换路由后仍停留在上一个模式的页签。
  if (route === 'capture') return <CapturePage key="capture-paste" />;
  if (route === 'capture:file') return <CapturePage key="capture-file" initialMode="file" />;
  if (route === 'settings') return <SettingsPage />;
  if (route === 'data') return <DataPage />;
  if (route === 'rules') return <RulesPage />;
  if (route === 'ai') return <AiPage />;
  if (route === 'aiconfig') return <AiConfigPage />;
  if (route === 'organize') return <OrganizePage />;
  if (route === 'ask') return <AskPage />;
  return <HomePage />;
}

function FooterHint() {
  const { route } = useWorkspace();
  const mapping: Record<string, string> = {
    home: '首页 · 粘贴链接 / 书签导入',
    inbox: '收件箱 · 未读新收藏',
    uncategorized: '未分类 · 已读仍保留',
    all: '全部收藏 · 本地主库',
    recent: '最近打开 · 最多 15 条',
    trash: '回收站 · 可恢复',
    reading: '待看 · 独立队列',
    'reading-history': '完成历史 · 可恢复',
    search: '本地索引 · 可重建',
    capture: '导入预览 · 写入前核对',
    'capture:file': '书签 HTML · 本地解析',
    settings: '设置与管理',
    data: '备份 / 恢复 / 手机快照',
    rules: '分类与整理策略',
    ai: 'AI 助手 · 手动交接可用',
    aiconfig: '内置 AI · 未启用',
    organize: '整理 · 人工确认后应用',
    ask: '提问 · 选择不等于授权',
  };
  return (
    <div className="footerhint">
      <span>{mapping[route] ?? '拾页'}</span>
      <span>v0.1.0 · 本地优先 · 数据存于扩展 origin</span>
    </div>
  );
}

export function App() {
  const { drawerId } = useWorkspace();
  return (
    <div className="app">
      <Sidebar />
      <main>
        <Topbar />
        <div className="content">
          <CurrentPage />
          <FooterHint />
        </div>
      </main>
      {drawerId ? <DetailDrawer bookmarkId={drawerId} /> : null}
      <ModalHost />
    </div>
  );
}
