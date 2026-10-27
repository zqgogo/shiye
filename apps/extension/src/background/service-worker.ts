import {
  AppError,
  LIMITS,
  parseExtensionMessage,
  tryCanonicalizeUrl,
  type ExtensionMessage,
} from '@shiye/core';
import { createWorkspaceService, notifyDataChanged } from '@shiye/application';
import { createShiyeStore } from '@shiye/storage';

/**
 * MV3 service worker：只处理用户主动触发的收集动作与受控消息。
 * 不常驻扫描网页、不读取凭据、不代理任意网络请求。
 */

const MENU_READING = 'shiye-save-reading';
const MENU_LIBRARY = 'shiye-save-library';

function isFromOwnExtension(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id;
}

let service: ReturnType<typeof createWorkspaceService> | null = null;

function getService(): ReturnType<typeof createWorkspaceService> {
  if (!service) {
    const store = createShiyeStore();
    service = createWorkspaceService(store.repos);
  }
  return service;
}

function flashBadge(text: string, color: string): void {
  void chrome.action.setBadgeBackgroundColor({ color });
  void chrome.action.setBadgeText({ text });
  setTimeout(() => {
    void chrome.action.setBadgeText({ text: '' });
  }, 4000);
}

async function saveFromMenu(
  destination: 'reading' | 'library',
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined
): Promise<void> {
  const rawUrl = info.linkUrl ?? tab?.url ?? '';
  const checked = tryCanonicalizeUrl(rawUrl);
  if (!checked) {
    flashBadge('!', '#a44b40');
    return;
  }
  const title = (info.selectionText ?? tab?.title ?? '').trim().slice(0, LIMITS.title);
  const api = getService();
  try {
    if (destination === 'reading') {
      await api.addReading({
        originalUrl: checked.originalUrl,
        title,
        sourceType: 'extension',
      });
    } else {
      await api.createBookmark({
        originalUrl: checked.originalUrl,
        title,
        selectedText: info.menuItemId === MENU_LIBRARY ? (info.selectionText ?? '').slice(0, LIMITS.selectedText) : '',
        sourceType: 'extension',
      });
    }
    flashBadge('✓', '#385c48');
    notifyDataChanged();
  } catch (error) {
    if (error instanceof AppError && (error.code === 'DUPLICATE' || error.code === 'TOMBSTONED')) {
      flashBadge('=', '#a9743a');
      return;
    }
    flashBadge('!', '#a44b40');
  }
}

function ensureMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_READING,
      title: '加入拾页待看',
      contexts: ['page', 'link', 'selection'],
    });
    chrome.contextMenus.create({
      id: MENU_LIBRARY,
      title: '保存到拾页收藏',
      contexts: ['page', 'link', 'selection'],
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureMenus();
});

chrome.runtime.onStartup.addListener(() => {
  ensureMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_READING && info.menuItemId !== MENU_LIBRARY) return;
  const destination = info.menuItemId === MENU_READING ? 'reading' : 'library';
  // 点击即视为用户授权；不申请常驻主机权限。
  void saveFromMenu(destination, info, tab);
});

async function handleMessage(message: ExtensionMessage): Promise<unknown> {
  switch (message.type) {
    case 'PING':
      return { ok: true, version: chrome.runtime.getManifest().version };
    case 'OPEN_WORKSPACE': {
      const route = message.route ?? 'home';
      await chrome.tabs.create({ url: chrome.runtime.getURL(`workspace.html#${route}`) });
      return { ok: true };
    }
    case 'CAPTURE_LINK': {
      const api = getService();
      if (message.destination === 'reading') {
        const item = await api.addReading({
          originalUrl: message.url,
          title: message.title ?? '',
          sourceType: 'extension',
        });
        notifyDataChanged();
        return { ok: true, id: item.id };
      }
      const bookmark = await api.createBookmark({
        originalUrl: message.url,
        title: message.title ?? '',
        selectedText: message.selectedText ?? '',
        sourceType: 'extension',
      });
      notifyDataChanged();
      return { ok: true, id: bookmark.id };
    }
    default:
      throw new AppError('INVALID_INPUT', '不支持的消息类型。');
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (!isFromOwnExtension(sender)) {
    sendResponse({ ok: false, error: '来源校验失败' });
    return false;
  }
  let message: ExtensionMessage;
  try {
    message = parseExtensionMessage(raw);
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : '消息格式不正确' });
    return false;
  }
  void handleMessage(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error: unknown) => {
      const text = error instanceof AppError ? error.message : '处理失败';
      const code = error instanceof AppError ? error.code : 'STORAGE_FAILED';
      sendResponse({ ok: false, error: text, code });
    });
  return true;
});
