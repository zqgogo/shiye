/** Trusted extension pages only. No content-script message proxy. */
export function extensionApi(): typeof chrome | null {
  const host = globalThis as typeof globalThis & { browser?: typeof chrome };
  return host.browser ?? (typeof chrome !== 'undefined' ? chrome : null);
}

export async function requestOrigin(address: string): Promise<void> {
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址需为 HTTPS，不能带账号、查询参数或片段。');
  }
  const api = extensionApi();
  if (!api?.permissions) throw new Error('请在已安装的扩展页面中授权此服务地址。');
  const permissions = { origins: [`${url.origin}/*`] };
  if (await api.permissions.contains(permissions)) return;
  if (!await api.permissions.request(permissions)) throw new Error('尚未授予服务地址访问权限。');
}

export async function openExternal(address: string): Promise<void> {
  const url = new URL(address);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('该链接不能安全打开，请在工作台检查。');
  const api = extensionApi();
  if (!api?.tabs) throw new Error('请在扩展中打开链接。');
  await api.tabs.create({ url: url.href });
}
