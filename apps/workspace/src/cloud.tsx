import { useEffect, useRef, useState } from 'react';
import { toUserMessage } from '@shiye/core';
import { MirrorClient, mirrorBase, planMirror, type MirrorPlan } from '../../../packages/sync/src/client.js';
import { type MirrorInfo } from '../../../packages/sync/src/protocol.js';
import { requestOrigin } from '../../../packages/adapters/browser/src/index.js';
import { PageHeader } from './components.js';
import { useWorkspace } from './state.js';

export function CloudPage() {
  const { service } = useWorkspace();
  const [address, setAddress] = useState(() => { try { return localStorage.getItem('shiye:mirror-address') ?? ''; } catch { return ''; } });
  const [token, setToken] = useState('');
  const [info, setInfo] = useState<MirrorInfo | null>(null);
  const [plan, setPlan] = useState<(MirrorPlan & { localLibraryId: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [message, setMessage] = useState('');
  const active = useRef<AbortController | null>(null);
  const version = useRef(0);
  const cancel = () => { version.current++; active.current?.abort(); active.current = null; setBusy(false); setProgress(''); };
  useEffect(() => () => { active.current?.abort(); }, []);
  const changeAddress = (next: string) => { cancel(); setAddress(next); setToken(''); setInfo(null); setPlan(null); setMessage('地址已变化，请重新输入此服务的应用凭据并连接。'); };
  const client = () => new MirrorClient(mirrorBase(address).href, token);
  const execute = async (action: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; const stamp = version.current;
    const current = () => stamp === version.current && !controller.signal.aborted;
    setBusy(true); setMessage(''); const timer = setTimeout(() => controller.abort(), 300000);
    try { await requestOrigin(address); if (!current()) throw new Error('连接已变化。'); await action(controller.signal, current); }
    catch (cause) { if (stamp === version.current) setMessage(controller.signal.aborted ? '请求超时，发布结果可能未知；请重新连接核对，未自动重试。' : toUserMessage(cause)); }
    finally { clearTimeout(timer); if (active.current === controller) { active.current = null; setBusy(false); } }
  };
  const connect = () => execute(async (signal, current) => {
    const next = await client().info(signal); if (!current()) return;
    setInfo(next); setPlan(null); setMessage('连接通过，没有发送任何收藏。请准备并检查发布预览。');
    try { localStorage.setItem('shiye:mirror-address', mirrorBase(address).href); } catch { /* Optional preference only. */ }
  });
  const prepare = async () => {
    if (!info) return;
    setBusy(true); setMessage(''); const stamp = version.current;
    try {
      const localLibraryId = (await service.snapshot()).settings.libraryId;
      const prepared = await planMirror(await service.buildCloudMirror(), info);
      if (stamp !== version.current) return;
      setPlan({ ...prepared, localLibraryId }); setMessage('预览已准备，尚未上传。只发布下方白名单，不含备注、摘录或来源历史。');
    } catch (cause) { if (stamp === version.current) setMessage(toUserMessage(cause)); }
    finally { if (stamp === version.current) setBusy(false); }
  };
  const publish = () => execute(async (signal, current) => {
    if (!plan) throw new Error('请先准备预览。');
    const fresh = await planMirror(await service.buildCloudMirror(), info!);
    if ((await service.snapshot()).settings.libraryId !== plan.localLibraryId || fresh.declaration.contentHash !== plan.declaration.contentHash) throw new Error('本机内容或主库已变化，请重新准备预览后确认。');
    const next = await client().publish(plan, signal, (done, total) => { if (current()) setProgress(`上传 ${done} / ${total} 片；完整验证后才发布`); });
    if (!current()) return;
    setInfo(next); setPlan(null); setProgress(''); setMessage(`镜像已发布，云端版本 ${next.revision}。手机可使用独立只读凭据查看。`);
  });
  const clear = () => {
    if (!info || !window.confirm('清空云端已发布镜像及未完成上传？本机收藏保留；手机页面将无法读取旧镜像。')) return;
    void execute(async (signal, current) => { const next = await client().clear(info, signal); if (!current()) return; setInfo(next); setPlan(null); setMessage('云端镜像与暂存上传已清空，本机记录保留。'); });
  };
  const records = plan?.parts.flatMap((part) => part.records) ?? [];
  return <>
    <PageHeader title="你的 Cloudflare，存你的记录。" description="S1 私有只读镜像：电脑编辑，手机查看。默认关闭，按需手动发布。" />
    <div className="panel"><h2>连接自有后端</h2><p>先按部署说明创建 Workers 与 D1。这里填写服务 HTTPS 地址及应用发布凭据，不填写 Cloudflare 账号 API token。</p>
      <label className="field"><span>后端地址</span><input value={address} placeholder="https://shiye.example.com" onChange={(event) => changeAddress(event.target.value)} /></label>
      <label className="field"><span>应用发布凭据（仅当前页面）</span><input type="password" autoComplete="off" value={token} onChange={(event) => { cancel(); setToken(event.target.value); setInfo(null); setPlan(null); }} /></label>
      <div className="toolbar"><button className="btn" disabled={busy || !token || !address} onClick={() => void connect()}>测试连接（不上传）</button><button className="btn" onClick={() => { cancel(); setToken(''); setInfo(null); setPlan(null); setMessage('已断开并清除本页凭据，云端已有内容保留。'); }}>断开并清除凭据</button>{busy && <button className="btn" onClick={() => { cancel(); setMessage('已停止等待，结果可能未知；再次连接核对。没有自动重试。'); }}>取消请求</button>}</div>
      {info && <div className="notice"><span>库 {info.libraryId} · 云端版本 {info.revision}</span><span>{info.publishedAt ? `最后发布 ${new Date(info.publishedAt).toLocaleString('zh-CN')}` : '尚未发布'}</span><a href={mirrorBase(address).href} target="_blank" rel="noreferrer noopener">打开手机只读页面 ↗</a></div>}
      <p role="status">{message}</p><p className="micro">{progress}</p>
    </div>
    {info && <div className="panel"><h2>发布记录镜像</h2><p>仅收藏标题、网址、分类、标签、置顶/未读标志及待看标题和网址。排除本地专用、删除项、备注、摘录、AI 材料、Key、暂存和日志。</p>
      <p className="micro">删除或转为本地专用后，需要再次成功发布才能从云端撤回；离线时旧镜像仍然可读。发布前后本机编辑不受影响。</p>
      <div className="toolbar"><button className="btn" disabled={busy} onClick={() => void prepare()}>准备发布预览</button><button className="btn danger" disabled={busy} onClick={clear}>清空云端镜像</button></div>
      {plan && <><h3>发送预览</h3><p>目标 {address} · 共 {records.length} 项（含必要目录和标签）· {plan.parts.length} 片 · 约 {(plan.bytes / 1024).toFixed(1)} KB</p>
        <p className="micro">收藏 {records.filter((row) => row.kind === 'bookmark').length} · 待看 {records.filter((row) => row.kind === 'reading').length} · 基线版本 {plan.declaration.baseRevision}</p>
        <details><summary>查看完整发送内容</summary><pre className="code">{JSON.stringify(records, null, 2)}</pre></details>
        <button className="btn primary" disabled={busy} onClick={() => void publish()}>确认上传并发布镜像</button>
      </>}
    </div>}
    <div className="panel"><h2>本轮边界</h2><p>这是私有只读镜像，尚未提供其他设备修改后自动合并的双向同步。发布由当前前台页面执行；关闭页面后不自动继续上传，重新打开先核对云端状态。手机只读凭据和发布凭据分开，AI 直接连接自己的模型服务。</p></div>
  </>;
}
