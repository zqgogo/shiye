import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { safariManifest, checkSafariResources, SAFARI_BUNDLE, MACOS_MINIMUM } from './lib/safari.mjs';
const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'apps/safari/dist'), work = path.join(root, '.verify/safari-build');
if (process.platform !== 'darwin') throw new Error('Safari 原生包需要在安装 Xcode 的 macOS 上构建。Chrome/Edge 请使用 npm run build。');
fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(output, { recursive: true });
const logFile = path.join(work, 'build.log'); fs.writeFileSync(logFile, '');
const run = (command, args, extra = {}) => new Promise((resolve, reject) => {
  const fd = fs.openSync(logFile, 'a'); const child = spawn(command, args, { cwd: root, env: { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(work, 'module-cache'), ...extra }, stdio: ['ignore', fd, fd] }); fs.closeSync(fd);
  child.on('error', () => reject(new Error(`无法启动 ${command}，请检查 Xcode 安装。`))); child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} 未完成（${code}）；诊断日志：${path.relative(root, logFile)}`)));
});
try {
  console.log('构建 Safari 专用页面与后台…');
  const vite = path.join(root, 'node_modules/vite/bin/vite.js');
  for (const config of ['apps/extension/vite.config.ts', 'apps/extension/vite.sw.config.ts']) await run(process.execPath, [vite, 'build', '--config', config], { SHIYE_PLATFORM: 'safari' });
  const resources = path.join(output, 'webextension');
  const original = JSON.parse(fs.readFileSync(path.join(root, 'apps/extension/public/manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(resources, 'manifest.json'), JSON.stringify(safariManifest(original), null, 2) + '\n');
  console.log('生成图标并检查 Safari manifest…');
  await run('swift', ['-module-cache-path', path.join(work, 'module-cache'), 'apps/safari/native/icons.swift', path.join(resources, 'icons')]);
  checkSafariResources(resources);
  const generated = path.join(work, 'project'); if (fs.existsSync(generated)) fs.rmSync(generated, { recursive: true });
  console.log('使用 Apple 工具创建 macOS Safari 工程…');
  await run('xcrun', ['safari-web-extension-converter', resources, '--project-location', generated, '--app-name', 'Shiye', '--bundle-identifier', SAFARI_BUNDLE, '--macos-only', '--swift', '--copy-resources', '--no-open', '--no-prompt']);
  const projectRoot = path.join(generated, 'Shiye'), project = path.join(projectRoot, 'Shiye.xcodeproj');
  const projectFile = path.join(project, 'project.pbxproj');
  let settings = fs.readFileSync(projectFile, 'utf8'); settings = settings.replaceAll('PRODUCT_BUNDLE_IDENTIFIER = dev.shiye.Shiye;', `PRODUCT_BUNDLE_IDENTIFIER = ${SAFARI_BUNDLE};`); fs.writeFileSync(projectFile, settings);
  fs.copyFileSync(path.join(root, 'apps/safari/native/ViewController.swift'), path.join(projectRoot, 'Shiye/ViewController.swift'));
  console.log('编译原生 App 与扩展（Apple Silicon + Intel）…');
  const derived = path.join(work, 'DerivedData'), buildNumber = original.version_name?.match(/preview\.(\d+)$/)?.[1] ?? '1';
  await run('xcodebuild', ['-project', project, '-scheme', 'Shiye', '-configuration', 'Release', '-destination', 'generic/platform=macOS', '-derivedDataPath', derived, 'CODE_SIGNING_ALLOWED=NO', `MACOSX_DEPLOYMENT_TARGET=${MACOS_MINIMUM}`, 'ARCHS=arm64 x86_64', 'ONLY_ACTIVE_ARCH=NO', `MARKETING_VERSION=${original.version}`, `CURRENT_PROJECT_VERSION=${buildNumber}`, 'build']);
  const app = path.join(output, 'Shiye.app'); if (fs.existsSync(app)) fs.rmSync(app, { recursive: true });
  await run('ditto', [path.join(derived, 'Build/Products/Release/Shiye.app'), app]);
  const appEntitlements = path.join(work, 'app.entitlements'), extensionEntitlements = path.join(work, 'extension.entitlements');
  const entitlements = (network) => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.get-task-allow</key><true/>${network ? '<key>com.apple.security.network.client</key><true/>' : ''}</dict></plist>`;
  fs.writeFileSync(appEntitlements, entitlements(true)); fs.writeFileSync(extensionEntitlements, entitlements(true));
  const extension = path.join(app, 'Contents/PlugIns/Shiye Extension.appex');
  for (const executable of [path.join(app, 'Contents/MacOS/Shiye'), path.join(extension, 'Contents/MacOS/Shiye Extension')]) {
    await run('lipo', [executable, '-verify_arch', 'arm64', 'x86_64']);
  }
  console.log('本机 ad-hoc 签名并校验，不使用 Apple 账号或发布证书…');
  for (const [file, entitlement] of [[extension, extensionEntitlements], [app, appEntitlements]]) await run('codesign', ['--force', '--sign', '-', '--entitlements', entitlement, file]);
  await run('codesign', ['--verify', '--deep', '--strict', app]);
  const archive = path.join(output, 'Shiye-Safari-macOS.zip'); if (fs.existsSync(archive)) fs.unlinkSync(archive); await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
  fs.copyFileSync(path.join(root, 'apps/safari/INSTALL.md'), path.join(output, '先读我_安装说明.md'));
  const hash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const report = { builtAt: new Date().toISOString(), version: original.version_name ?? original.version, bundleIdentifier: SAFARI_BUNDLE, minimumMacOS: MACOS_MINIMUM, safariManifest: checkSafariResources(resources), signing: 'ad-hoc local development; not notarized or App Store signed', architectures: ['arm64', 'x86_64'], app, archive, sha256: hash };
  fs.writeFileSync(path.join(output, 'build-info.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${hash}  Shiye-Safari-macOS.zip\n`);
  console.log(`Safari 本地开发包已构建：${path.relative(root, app)}\n安装说明：${path.relative(root, path.join(output, '先读我_安装说明.md'))}\n此包尚非 App Store / Developer ID 公证分发包，需要 Safari 的本地开发扩展设置。`);
} catch (cause) { console.error(cause.message); process.exitCode = 1; }
