import { useEffect, useMemo, useRef, useState } from 'react';
import { newId, paginate, toUserMessage } from '@shiye/core';
import { MirrorClient, mirrorBase } from '../../../packages/sync/src/client.js';
import { sameIdentity, type MirrorInfo } from '../../../packages/sync/src/protocol.js';
import type { SavedPublication } from '../../../packages/sync/src/publication.js';
import { requestOrigin } from '../../../packages/adapters/browser/src/index.js';
import { PageHeader, Pager } from './components.js';
import { useWorkspace } from './state.js';
import { CloudInbox } from './cloud-inbox.js';
import { TwoWayPanel } from './two-way.js';

export function CloudPage() {
  const { service, data, setPageSize } = useWorkspace();
  const [address, setAddress] = useState(() => { try { return localStorage.getItem('shiye:mirror-address') ?? ''; } catch { return ''; } });
  const [token, setToken] = useState(''), [info, setInfo] = useState<MirrorInfo | null>(null);
  const [publication, setPublication] = useState<SavedPublication | null>(null);
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(''), [message, setMessage] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false), [previewPage, setPreviewPage] = useState(1);
  const active = useRef<AbortController | null>(null), version = useRef(0);
  useEffect(() => {
    let alive = true;
    void service.savedCloudPublication().then((saved) => { if (alive) setPublication(saved); }).catch((cause) => { if (alive) setMessage(toUserMessage(cause)); });
    return () => { alive = false; active.current?.abort(); };
  }, [service]);
  const cancel = () => { version.current++; active.current?.abort(); active.current = null; setBusy(false); setProgress(''); };
  const changeAddress = (next: string) => { cancel(); setAddress(next); setToken(''); setInfo(null); setMessage('地址已变化，请重新输入此服务的应用凭据并连接。旧快照仍绑定原地址，不会自动发送。'); };
  const client = () => new MirrorClient(mirrorBase(address).href, token);
  const execute = async (action: (signal: AbortSignal, current: () => boolean) => Promise<void>, remote = true) => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; const stamp = version.current;
    const current = () => stamp === version.current && !controller.signal.aborted;
    setBusy(true); setMessage(''); const timer = setTimeout(() => controller.abort(), 300000);
    try {
      if (remote) await requestOrigin(address);
      if (!current()) throw new Error('操作已取消或连接已变化。');
      await action(controller.signal, current);
    } catch (cause) {
      if (stamp === version.current) setMessage(controller.signal.aborted ? '请求超时，发布结果可能未知；快照保留在本机，请重新连接核对。没有自动重试。' : toUserMessage(cause));
    } finally { clearTimeout(timer); if (active.current === controller) { active.current = null; setBusy(false); } }
  };
  const connect = () => execute(async (signal, current) => {
    const next = await client().info(signal), saved = await service.savedCloudPublication();
    if (!current()) return;
    setInfo(next); setPublication(saved);
    setMessage(saved ? '连接通过，已读取本机发布快照。续传仍需你确认，不会自动上传。' : '连接通过，没有发送任何收藏。请准备并检查发布预览。');
    try { localStorage.setItem('shiye:mirror-address', mirrorBase(address).href); } catch { /* Optional preference. */ }
  });
  const prepare = () => execute(async (signal, current) => {
    if (!info) throw new Error('请先测试连接。');
    const prepared = await service.prepareCloudPublication(address, info, publication?.snapshot.id ?? null, signal);
    if (!current()) return;
    setPublication(prepared); setPreviewPage(1);
    setMessage('预览已准备，尚未上传。快照已保存在本机，刷新后可续接；不保存发布凭据。');
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
      <label className="field"><span>后端地址</span><input value={address} placeholder="https://shiye.example.com" onChange={(event) => changeAddress(event.target.value)} /></label>
      <label className="field"><span>应用发布凭据（仅当前页面）</span><input type="password" autoComplete="off" value={token} onChange={(event) => { cancel(); setToken(event.target.value); setInfo(null); }} /></label>
      <div className="toolbar"><button className="btn" disabled={busy || !token || !address} onClick={() => void connect()}>测试连接（不上传）</button>
        <button className="btn" onClick={() => { cancel(); setToken(''); setInfo(null); setMessage('已断开并清除本页凭据。发布快照和云端已有内容保留，没有自动续传。'); }}>断开并清除凭据</button>
        {busy && <button className="btn" onClick={() => { cancel(); setMessage('已停止等待，快照保留，结果可能未知；重新连接后可核对或续传。没有自动重试。'); }}>取消请求</button>}
      </div>
      {info && <div className="notice"><span>库 {info.libraryId} · 待看镜像版本 {info.revision}</span><span>{info.publishedAt ? `待看镜像最后发布 ${new Date(info.publishedAt).toLocaleString('zh-CN')}` : '待看镜像尚未发布'}</span><a href={mirrorBase(address).href} target="_blank" rel="noreferrer noopener">打开手机收藏与提交页 ↗</a></div>}
      <p role="status">{message}</p><p className="micro">{progress}</p>
    </div>
    {info && <TwoWayPanel key={JSON.stringify([address, info.serverId, info.libraryId, info.epoch])} address={address} token={token} execute={execute} busy={busy} />}
    {info && <CloudInbox key={JSON.stringify([address, info.serverId, info.libraryId, info.epoch])} client={client} info={info} busy={busy} execute={execute} />}
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
