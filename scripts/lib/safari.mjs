import fs from 'node:fs';
import path from 'node:path';
export const SAFARI_MINIMUM = '17.0', MACOS_MINIMUM = '14.0', SAFARI_BUNDLE = 'dev.shiye.bookmarks';
export function safariManifest(source) {
  const result = structuredClone(source);
  delete result.minimum_chrome_version; delete result.version_name;
  result.name = '拾页 · 收藏工作台'; result.background = { service_worker: 'service-worker.js' };
  result.options_ui = { page: 'workspace.html' };
  result.browser_specific_settings = { safari: { strict_min_version: SAFARI_MINIMUM } };
  result.icons = Object.fromEntries([16, 32, 48, 128, 256, 512, 1024].map((size) => [size, `icons/icon${size}.png`]));
  result.action.default_icon = { 16: 'icons/icon16.png', 32: 'icons/icon32.png' };
  return result;
}
export function checkSafariResources(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3 || manifest.background?.type || manifest.minimum_chrome_version || manifest.options_ui?.open_in_tab) throw new Error('Safari manifest 含不兼容的 Chromium 配置。');
  if (manifest.host_permissions?.length || JSON.stringify(manifest.optional_host_permissions) !== '["https://*/*"]') throw new Error('Safari 权限范围变化，拒绝隐式授予所有网站。');
  for (const file of ['workspace.html', 'popup.html', 'service-worker.js', ...Object.values(manifest.icons)]) if (!fs.statSync(path.join(directory, file)).isFile()) throw new Error(`缺少 Safari 资源：${file}`);
  const worker = fs.readFileSync(path.join(directory, 'service-worker.js'), 'utf8');
  if (/^\s*(?:import|export)\s/m.test(worker)) throw new Error('Safari 后台不是自包含的经典脚本。');
  return manifest;
}
