import { useEffect, useMemo, useRef, useState } from 'react';
import { newId, paginate, toUserMessage } from '@shiye/core';
import { MirrorClient, mirrorBase } from '../../../packages/sync/src/client.js';
import { sameIdentity, type MirrorInfo } from '../../../packages/sync/src/protocol.js';
import type { SavedPublication } from '../../../packages/sync/src/publication.js';
import { requestOrigin, extensionApi } from '../../../packages/adapters/browser/src/index.js';
import { PageHeader, Pager } from './components.js';
import { useWorkspace } from './state.js';
import { CloudInbox } from './cloud-inbox.js';
import { TwoWayPanel } from './two-way.js';
import { useCloudConnection } from './cloud-connection.js';
import { ConnectionCard, safeHost, useConnectionStatus } from './connection-status.js';
import { TwoWayClient } from '../../../packages/sync/src/two-way-client.js';

export function CloudPage() {
  const { service, data, setPageSize } = useWorkspace();
  const cloud = useCloudConnection(), { cloudStatus } = useConnectionStatus();
  const { address, token, info, setInfo } = cloud;
  const [editorOpen, setEditorOpen] = useState(!info);
  const [connecting, setConnecting] = useState(false);
  const [publication, setPublication] = useState<SavedPublication | null>(null);
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(''), [message, setMessageState] = useState('');
  const messageVersion = useRef(cloud.version.current);
  const setMessage = (text: string) => { messageVersion.current = cloud.version.current; setMessageState(text); };
  const [previewOpen, setPreviewOpen] = useState(false), [previewPage, setPreviewPage] = useState(1);
  const active = useRef<AbortController | null>(null), version = useRef(0);
  useEffect(() => {
    let alive = true;
    void service.savedCloudPublication().then((saved) => { if (alive) setPublication(saved); }).catch((cause) => { if (alive) setMessage(toUserMessage(cause)); });
    return () => { alive = false; active.current?.abort(); };
  }, [service]);
  const cancel = () => { version.current++; active.current?.abort(); active.current = null; setBusy(false); setProgress(''); setConnecting(false); };
  const changeAddress = (next: string) => { cancel(); cloud.changeAddress(next); setMessage('地址已变化，原连接立即失效。请重新输入此服务的凭据并验证；旧快照不会自动发送。'); };
  useEffect(() => { cancel(); }, [cloud.address, cloud.token, cloud.version.current]);
  const client = () => new MirrorClient(mirrorBase(address).href, token);
  const execute = async (action: (signal: AbortSignal, current: () => boolean) => Promise<void>, remote = true, timeoutMs = 300000) => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; const stamp = version.current, connectionVersion = cloud.version.current;
    const current = () => stamp === version.current && connectionVersion === cloud.version.current && !controller.signal.aborted;
    setBusy(true); setMessage(''); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (remote) await requestOrigin(address);
      if (!current()) throw new Error('操作已取消或连接已变化。');
      await action(controller.signal, current);
    } catch (cause) {
      if (stamp === version.current && connectionVersion === cloud.version.current) setMessage(controller.signal.aborted ? timeoutMs === 30000 ? '连接超时，凭据保留，请检查网络后手动重试；没有上传收藏。' : '请求超时，发布结果可能未知；快照保留在本机，请重新连接核对。没有自动重试。' : toUserMessage(cause));
    } finally { clearTimeout(timer); if (active.current === controller) { active.current = null; setBusy(false); } }
  };
  const connect = (automatic = false) => execute(async (signal, current) => {
    const expectedVersion = cloud.version.current;
    cloud.failed(''); setConnecting(true);
    try {
      const next = await client().info(signal); if (!current()) return;
      const shared = await new TwoWayClient(address, token).info(signal), saved = await service.savedCloudPublication();
      if (automatic && cloud.rememberedIdentity && cloud.rememberedIdentity !== JSON.stringify([next.serverId, next.libraryId, next.epoch])) throw new Error('云端库身份已变化，请手动测试连接后重新核对同步。');
      if (!sameIdentity(next, shared)) throw new Error('镜像与同步库身份不一致，请核对后端地址。');
      if (!current()) return;
      if (!cloud.connected(next, shared, expectedVersion)) return;
      setPublication(saved); setEditorOpen(false);
      setMessage(saved ? '连接通过，发布权限和同步协议已验证；已读取本机发布快照，不会自动上传。' : '连接通过，发布权限和同步协议已验证，没有发送任何收藏。可检查两台电脑同步。');
    } catch (cause) { if (current()) cloud.failed(toUserMessage(cause)); throw cause; }
    finally { if (current()) setConnecting(false); }
  }, true, 30000);
  useEffect(() => {
    if (!cloud.autoConnectPending || !token || !address || info) return;
    cloud.consumeAutoConnect();
    let alive = true; const expected = cloud.version.current;
    void (async () => { try {
      const allowed = await extensionApi()?.permissions.contains({ origins: [`${new URL(address).origin}/*`] });
      if (!alive || expected !== cloud.version.current) return;
      if (!allowed) { setMessage('已恢复凭据；网站权限尚未授予，请点击测试连接授权。'); return; }
      await connect(true);
    } catch (cause) { if (alive) setMessage(toUserMessage(cause)); } })();
    return () => { alive = false; };
  }, []);
  const prepare = () => execute(async (signal, current) => {
    if (!info) throw new Error('请先测试连接。');
    const prepared = await service.prepareCloudPublication(address, info, publication?.snapshot.id ?? null, signal);
    if (!current()) return;
    setPublication(prepared); setPreviewPage(1);
    setMessage('预览已准备，尚未上传。快照已保存在本机，刷新后可续接；发布快照不包含凭据。');
  }, false);
  const publish = () => execute(async (signal, current) => {
    if (!publication) throw new Error('请先准备预览。');
    const frozen = publication.snapshot, owner = newId(); let acquired = false;
    if (mirrorBase(address).href !== frozen.baseUrl || !info || !sameIdentity(info, frozen.plan.declaration.identity)) throw new Error('这份快照属于其他地址、库或纪元，已停止旧计划。请重新准备预览。');
    try {
      await service.acquireCloudPublication(frozen.id, owner); acquired = true;
      const transport = client(); const before = await transport.info(signal);
      if (!sameIdentity(before, frozen.plan.declaration.identity)) throw new Error('云端服务身份已变化，旧快照未上传。');
      let receipt: MirrorInfo;
      if (before.activeGeneration === frozen.id) {
        // A previous publish may have succeeded even if its final response was lost.
        receipt = before;
      } else {
        await service.validateCloudPublication(frozen.id);
        let confirmed = 0;
        receipt = await transport.publish(frozen.plan, signal, async (done, total) => {
          await service.progressCloudPublication(frozen.id, owner, done); confirmed = done;
          if (current()) setProgress(`服务器已确认 ${done} / ${total} 片；只补传缺失部分`);
        }, {
          beforeChunk: async (_index, records) => { await service.progressCloudPublication(frozen.id, owner, confirmed); await service.validateCloudChunk(records); },
          beforeCommit: async () => { await service.progressCloudPublication(frozen.id, owner, confirmed); await service.validateCloudPublication(frozen.id); },
        });
      }
      await service.completeCloudPublication(frozen.id, owner, receipt);
      if (current()) { setInfo(receipt); setProgress(''); setMessage(`镜像已发布，云端版本 ${receipt.revision}。当前快照已确认；本机后续改动需重新准备预览再发布。`); }
    } finally {
      if (acquired) await service.releaseCloudPublication(frozen.id, owner).catch(() => undefined);
      try { const saved = await service.savedCloudPublication(); if (current()) setPublication(saved); } catch { /* The main error remains visible; a refresh can re-read state. */ }
    }
  });
  const cancelUpload = () => {
    if (!publication || !window.confirm('取消这份尚未发布的上传并删除服务器暂存分片？已发布的镜像保留，本机收藏不变。')) return;
    void execute(async (signal, current) => {
      const frozen = publication.snapshot;
      if (mirrorBase(address).href !== frozen.baseUrl || !info || !sameIdentity(info, frozen.plan.declaration.identity)) throw new Error('请先连接此快照原来的地址及库，再取消远端上传。');
      await client().cancel(frozen.plan, signal); await service.removeCloudPublication(frozen.id);
      if (current()) { setPublication(null); setMessage('未发布上传及服务器暂存已取消，原已发布镜像保留。'); }
    });
  };
  const clear = () => {
    if (!info || !window.confirm('清空旧版镜像及未完成上传？本机收藏和双机共享收藏保留；手机待看镜像会清空。')) return;
    void execute(async (signal, current) => {
      const next = await client().clear(info, signal);
      if (publication) await service.removeCloudPublication(publication.snapshot.id, true).catch(() => undefined);
      if (current()) { setInfo(next); setPublication(await service.savedCloudPublication()); setMessage('云端镜像与暂存上传已清空，本机记录保留。'); }
    });
  };
  const records = useMemo(() => publication?.snapshot.plan.parts.flatMap((part) => part.records) ?? [], [publication]);
  const preview = paginate(records, previewPage, data.settings.pageSize);
  let matches = false;
  try { matches = Boolean(publication && info && publication.snapshot.baseUrl === mirrorBase(address).href && sameIdentity(info, publication.status.identity)); } catch { /* An incomplete address is expected while typing. */ }
  const commands = ['npm run cloud:prepare', 'npm run cloud:login', 'npm run cloud:deploy'];
  return <>
    <PageHeader title="你的 Cloudflare，连接你的收藏。" description="家里与工作电脑轮流使用，手动合并收藏变化；手机仍可查看和提交。" action={<span className="date">手动连接 · 确认后同步</span>} />
    <details className="panel"><summary>还没部署？三步准备自己的 Cloudflare 后端</summary>
      <p>在拾页项目目录中依次执行。准备步骤只生成本地配置和独立凭据；部署步骤会在你登录的 Cloudflare 账号创建 D1、Worker 和只读页面，按你的账号方案计费。</p>
      <ol>{commands.map((command) => <li key={command}><code>{command}</code> <button className="btn small" onClick={async () => { try { await navigator.clipboard.writeText(command); setMessage('命令已复制，请在项目目录的终端执行。'); } catch { setMessage('请直接选中命令复制。'); } }}>复制命令</button></li>)}</ol>
      <p className="micro">可先用 <code>npm run cloud:doctor</code> 检查本地准备。publisher.txt 用于总机发布和接收；reader.txt 仅查看；submitter.txt 用于其他设备查看和提交。应用里无需填写 Cloudflare 管理 API token，AI Key 也无需交给后端。</p>
    </details>
    <div className="panel"><h2>连接自有后端</h2>
      <ConnectionCard name="Cloudflare 连接状态" status={connecting ? '正在验证连接与权限' : cloudStatus.label} tone={connecting ? 'pending' : cloudStatus.tone} actions={<button className="btn small" onClick={() => setEditorOpen(true)}>修改地址或凭据</button>}>
        <p>{address ? safeHost(address) : '尚未填写你的后端地址'}</p><small>{info ? `发布权限与同步协议已验证 · ${cloud.testedAt ? new Date(cloud.testedAt).toLocaleString('zh-CN') : ''}` : cloud.modified ? '修改配置后原连接已失效，重新验证通过后才能同步。' : cloud.rememberToken ? '已在此设备记住凭据；进入本页时自动验证，不自动同步。' : '未记住凭据时，仅当前工作台有效；可在下方开启本机记住。'}</small>
        {cloud.sharedInfo && <p>共享收藏同步版本 {cloud.sharedInfo.revision} · 待看镜像版本 {info?.revision ?? 0}</p>}
        {cloud.error && <p className="alert">{cloud.error}</p>}
      </ConnectionCard>
      <details className="connection-editor" open={editorOpen} onToggle={(event) => setEditorOpen(event.currentTarget.open)}><summary>连接配置 · 地址与应用凭据</summary>
      <label className="field"><span>后端地址</span><input value={address} placeholder="https://shiye.example.com" onChange={(event) => changeAddress(event.target.value)} /></label>
      <label className="field"><span>应用发布凭据</span><input type="password" autoComplete="off" value={token} onChange={(event) => { cancel(); cloud.changeToken(event.target.value); setMessage('凭据已修改，原连接已失效，请重新验证。'); }} /><small>{token ? cloud.rememberToken ? '已在此设备保存；不进入收藏备份或云同步。' : '已填写；当前尚未保存，刷新后需重填。' : '未填写。请使用 publisher.txt，不使用 reader.txt 或 submitter.txt。'}</small></label>
      <label className="checkline"><input type="checkbox" aria-label="在此设备记住发布凭据" checked={cloud.rememberToken} disabled={busy || !token || !address} onChange={(event) => { try { cloud.setRememberToken(event.target.checked); setMessage(event.target.checked ? '已记住此设备的凭据；刷新后进入本页自动验证，不自动上传。' : '已移除保存的凭据，本次页面仍可使用。'); } catch (cause) { setMessage(toUserMessage(cause)); } }} />在此设备记住发布凭据</label><p className="micro">仅保存在此浏览器的扩展配置中，不进入收藏备份或云端。共享电脑请勿开启；取消勾选或断开连接可清除。</p>
      <div className="toolbar"><button className="btn small" disabled={busy || !address} onClick={() => { try { cloud.saveAddress(); setMessage(cloud.rememberToken ? '后端地址已保存，凭据另按记住设置保存在本机；保存不代表连接已验证。' : '后端地址已保存，凭据不会保存；保存不代表连接已验证。'); } catch (cause) { setMessage(toUserMessage(cause)); } }}>保存后端地址</button></div>
      </details>
      <div className="toolbar"><button className="btn" disabled={busy || !token || !address} onClick={() => void connect()}>测试连接（不上传）</button>
        <button className="btn" onClick={() => { cancel(); cloud.disconnect(); setEditorOpen(true); setMessage('已断开并清除本工作台凭据。地址和发布快照保留，没有自动续传。'); }}>断开并清除凭据</button>
        {busy && <button className="btn" onClick={() => { cancel(); setMessage('已停止等待，快照保留，结果可能未知；重新连接后可核对或续传。没有自动重试。'); }}>取消请求</button>}
      </div>
      {info && <div className="notice"><span>库 {info.libraryId} · 待看镜像版本 {info.revision}</span><span>{info.publishedAt ? `待看镜像最后发布 ${new Date(info.publishedAt).toLocaleString('zh-CN')}` : '待看镜像尚未发布'}</span><a href={mirrorBase(address).href} target="_blank" rel="noreferrer noopener">打开手机收藏与提交页 ↗</a></div>}
      <p role="status">{messageVersion.current === cloud.version.current ? message : ''}</p><p className="micro">{progress}</p>
    </div>
    {info && <TwoWayPanel key={`sync:${JSON.stringify([address, info.serverId, info.libraryId, info.epoch])}`} address={address} token={token} execute={execute} busy={busy} onSynced={cloud.setSharedInfo} />}
    {info && <CloudInbox key={`inbox:${JSON.stringify([address, info.serverId, info.libraryId, info.epoch])}`} client={client} info={info} busy={busy} execute={execute} />}
    {publication && !matches && <div className="panel"><h2>本机保存了一份发布快照</h2><p>{publication.snapshot.baseUrl} · {publication.snapshot.plan.declaration.recordCount} 项 · 本机已记录 {publication.status.confirmedChunks}/{publication.status.totalChunks} 片确认。</p>
      <p>请输入原地址和发布凭据并测试连接，再核对或续传。不会把旧快照自动发到新地址，确认分片以服务器实际状态为准。</p>
      <button className="btn" disabled={busy} onClick={() => changeAddress(publication.snapshot.baseUrl)}>填入快照原地址</button>
    </div>}
    {info && <details className="panel"><summary>待看与旧版镜像（高级）</summary><h2>发布记录镜像</h2><p>双机同步启用后，新版手机收藏直接读取共享库；下面仅维护待看与旧版镜像，不会替换双机共享收藏。</p><p>仅收藏标题、网址、分类、标签、置顶/未读标志及待看标题和网址。排除本地专用、删除项、备注、摘录、AI 材料、Key、暂存和日志。</p>
      <p className="micro">删除或转为本地专用后，需要再次成功发布才能从云端撤回；离线时旧镜像仍然可读。上传前逐片复核，发布前再次检查完整快照。</p>
      <div className="toolbar"><button className="btn" disabled={busy} onClick={() => void prepare()}>准备发布预览</button><button className="btn danger" disabled={busy} onClick={clear}>清空云端镜像</button></div>
      {publication && matches && <><h3>发送预览</h3><p>目标 {publication.snapshot.baseUrl} · 共 {records.length} 项（含必要目录和标签）· {publication.status.totalChunks} 片 · 约 {(publication.snapshot.plan.bytes / 1024).toFixed(1)} KB</p>
        <p className="micro">收藏 {records.filter((row) => row.kind === 'bookmark').length} · 待看 {records.filter((row) => row.kind === 'reading').length} · 基线版本 {publication.snapshot.plan.declaration.baseRevision}</p>
        <p>{publication.status.state === 'published' ? '该快照已确认发布，可重新核对，不会再次上传记录。' : `本机记录已确认 ${publication.status.confirmedChunks} / ${publication.status.totalChunks} 片。断点续传仍需重新核对服务器分片摘要。`}</p>
        {publication.status.lease && <p className="micro">有页面持有执行权至 {new Date(publication.status.lease.until).toLocaleTimeString('zh-CN')}。意外关闭后请等待到期，再测试连接续传。</p>}
        <details onToggle={(event) => setPreviewOpen(event.currentTarget.open)}><summary>查看完整发送内容（分页）</summary>{previewOpen && <><pre className="code">{JSON.stringify(preview.rows, null, 2)}</pre><Pager {...preview} onPage={setPreviewPage} onPageSize={(size) => { void setPageSize(size); setPreviewPage(1); }} /></>}</details>
        <div className="toolbar"><button className="btn primary" disabled={busy} onClick={() => void publish()}>{publication.status.state === 'published' ? '核对该快照发布状态' : publication.status.state === 'prepared' ? '确认上传并发布镜像' : '继续未完成上传'}</button>
          {publication.status.state !== 'published' && <button className="btn" disabled={busy} onClick={cancelUpload}>取消未发布上传</button>}
        </div>
      </>}
    </details>}
    <div className="panel"><h2>使用方式</h2><p>两台电脑使用同一地址和发布凭据，先检查、再确认同步收藏；首次合并，之后交换变化。手机用 submitter.txt 提交、reader.txt 查看。任意一台电脑接收手机收藏后同步即可进入共享库；待看仍单独发布镜像。提交设备保留临时副本，AI 仍独立直连。</p></div>
  </>;
}
