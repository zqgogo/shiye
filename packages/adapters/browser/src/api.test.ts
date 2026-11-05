import { afterEach, expect, it, vi } from 'vitest';
import { makeExtensionApi, isTrustedExtensionSender } from './index.js';
afterEach(() => vi.unstubAllGlobals());
it('Chrome callback-only API is converted to a promise and uses the native receiver', async () => {
  const owner = { query(this: unknown, _options: unknown, callback: (rows: unknown[]) => void) { expect(this).toBe(owner); callback([{ id: 7 }]); } };
  const api = makeExtensionApi({ chrome: { runtime: {}, tabs: owner } as unknown as typeof chrome })!;
  expect(await api.tabs.query({ active: true })).toEqual([{ id: 7 }]);
});
it('Safari browser namespace is preferred and never receives a Chrome callback', async () => {
  const request = vi.fn(async (...args: unknown[]) => { expect(args).toHaveLength(1); return true; });
  const api = makeExtensionApi({ browser: { permissions: { request } } as unknown as typeof chrome, chrome: {} as typeof chrome })!;
  expect(await api.permissions.request({ origins: ['https://example.com/*'] })).toBe(true);
});
it('Chrome lastError and browser promise failures both reject, including sync throws', async () => {
  const api = makeExtensionApi({ chrome: { runtime: { lastError: { message: 'denied' } }, permissions: { request(_value: unknown, callback: () => void) { callback(); } } } as unknown as typeof chrome })!;
  await expect(api.permissions.request({})).rejects.toThrow('denied');
  const safari = makeExtensionApi({ browser: { tabs: { create() { throw new Error('unavailable'); } } } as unknown as typeof chrome })!;
  await expect(safari.tabs.create({})).rejects.toThrow('unavailable');
});
it('API replacement remains observable and callback+promise implementations settle once', async () => {
  const owner = { create(_value: unknown, callback: (value: unknown) => void) { callback({ id: 1 }); return Promise.resolve({ id: 2 }); } };
  const api = makeExtensionApi({ chrome: { runtime: {}, tabs: owner } as unknown as typeof chrome })!;
  expect(await api.tabs.create({})).toEqual({ id: 1 });
  owner.create = (_value, callback) => { callback({ id: 3 }); return Promise.resolve({ id: 3 }); };
  expect(await api.tabs.create({})).toEqual({ id: 3 });
});
it('synchronous runtime methods and events keep their native shape', () => {
  const event = { addListener: vi.fn() }, runtime = { id: 'own', getURL(this: unknown, value: string) { expect(this).toBe(runtime); return `safari-web-extension://own/${value}`; }, onMessage: event };
  const api = makeExtensionApi({ browser: { runtime } as unknown as typeof chrome })!;
  expect(api.runtime.getURL('popup.html')).toBe('safari-web-extension://own/popup.html'); expect(api.runtime.onMessage).toBe(event); expect(api.runtime.id).toBe('own');
});
it('Safari sender URL can authenticate absent sender.id, without treating opaque origins as equal', () => {
  vi.stubGlobal('browser', { runtime: { id: 'own', getURL: () => 'safari-web-extension://own/' } });
  expect(isTrustedExtensionSender({ url: 'safari-web-extension://own/popup.html' })).toBe(true);
  expect(isTrustedExtensionSender({ url: 'safari-web-extension://own/workspace.html#all' })).toBe(true);
  for (const sender of [{ url: 'safari-web-extension://foreign/popup.html' }, { id: 'other', url: 'safari-web-extension://own/popup.html' }, { id: 'own', url: 'https://example.com/popup.html' }, { url: 'safari-web-extension://own/other.html' }, {}]) expect(isTrustedExtensionSender(sender)).toBe(false);
});
it('missing extension APIs fail closed', () => { expect(makeExtensionApi({})).toBeNull(); });
it('missing runtime and sender IDs cannot authenticate an empty sender', () => {
  vi.stubGlobal('browser', { runtime: { getURL: () => 'safari-web-extension://own/' } });
  expect(isTrustedExtensionSender({})).toBe(false);
});
