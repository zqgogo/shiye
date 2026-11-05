import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safariManifest, checkSafariResources } from '../lib/safari.mjs';
const source = JSON.parse(fs.readFileSync(new URL('../../apps/extension/public/manifest.json', import.meta.url), 'utf8'));

test('Safari 转换保留功能和 CSP，不修改 Chrome manifest，也不默认授予网站权限', () => {
  const before = structuredClone(source), manifest = safariManifest(source);
  assert.deepEqual(source, before);
  assert.equal(manifest.minimum_chrome_version, undefined);
  assert.equal(manifest.version_name, undefined);
  assert.deepEqual(manifest.background, { service_worker: 'service-worker.js' });
  assert.deepEqual(manifest.options_ui, { page: 'workspace.html' });
  assert.equal(manifest.browser_specific_settings.safari.strict_min_version, '17.0');
  assert.deepEqual(manifest.permissions, source.permissions);
  assert.deepEqual(manifest.content_security_policy, source.content_security_policy);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
  assert.equal(manifest.host_permissions, undefined);
});

test('打包前拒绝权限扩大、缺失资源与模块型后台', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiye-safari-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const manifest = safariManifest(source);
  fs.mkdirSync(path.join(dir, 'icons'));
  for (const file of ['popup.html', 'workspace.html', ...Object.values(manifest.icons)]) fs.writeFileSync(path.join(dir, file), 'fixture');
  const write = () => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  write(); fs.writeFileSync(path.join(dir, 'service-worker.js'), '(()=>{})();');
  assert.equal(checkSafariResources(dir).version, source.version);
  manifest.host_permissions = ['https://*/*']; write();
  assert.throws(() => checkSafariResources(dir), /权限范围变化/);
  delete manifest.host_permissions; manifest.background.type = 'module'; write();
  assert.throws(() => checkSafariResources(dir), /不兼容/);
  delete manifest.background.type; write();
  fs.writeFileSync(path.join(dir, 'service-worker.js'), 'import "./shared.js";');
  assert.throws(() => checkSafariResources(dir), /自包含/);
  fs.writeFileSync(path.join(dir, 'service-worker.js'), '(()=>{})();');
  fs.unlinkSync(path.join(dir, 'popup.html'));
  assert.throws(() => checkSafariResources(dir));
});
