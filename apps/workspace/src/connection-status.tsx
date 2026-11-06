import type { ReactNode } from 'react';
import { useAiConnection } from './ai-connection.js';
import { useCloudConnection } from './cloud-connection.js';
import { useWorkspace } from './state.js';
import { mirrorBase } from '../../../packages/sync/src/client.js';
export function safeHost(address: string) { try { return new URL(address).host; } catch { return '尚未填写有效地址'; } }
export function useConnectionStatus() {
  const ai = useAiConnection(), cloud = useCloudConnection();
  let addressSaved = false; try { addressSaved = Boolean(cloud.savedAddress && mirrorBase(cloud.address).href === cloud.savedAddress); } catch { /* Incomplete edit. */ }
  const aiStatus = ai.testing ? { label: ai.testing === 'text' ? '正在测试连接' : '正在测试整理', tone: 'pending' } : !ai.profile.apiKey ? { label: ai.modified && ai.settingsDirty ? '配置已修改 · 待填 Key' : ai.preferencesSaved ? '已保存设置 · 待填 Key' : '尚未配置 Key', tone: 'empty' } : ai.enabled ? { label: ai.jsonTested ? '已开启 · 问答与整理可用' : '已开启 · 问答可用', tone: ai.jsonTested ? 'ready' : 'pending' } : ai.textTested ? { label: '连接已验证 · 尚未开启', tone: 'pending' } : ai.testError ? { label: '连接测试未通过', tone: 'error' } : { label: ai.modified ? '配置已修改 · 待重新测试' : '已填写 · 待测试', tone: 'pending' };
  const cloudStatus = cloud.info ? { label: '已连接 · 当前工作台可用', tone: 'ready' } : cloud.error ? { label: '连接验证未通过', tone: 'error' } : !cloud.token ? { label: addressSaved ? '已保存地址 · 待填凭据' : cloud.address ? '地址未保存 · 待填凭据' : '尚未配置连接', tone: cloud.address && !addressSaved ? 'pending' : 'empty' } : { label: cloud.modified ? '配置已修改 · 待重新验证' : '已填写 · 待验证', tone: 'pending' };
  return { ai, cloud, aiStatus, cloudStatus };
}
export function ConnectionCard({ name, status, tone, children, actions }: { name: string; status: string; tone: string; children: ReactNode; actions?: ReactNode }) {
  return <div className={`connection-card connection-${tone}`}><div className="connection-card-head"><strong>{name}</strong><span className={`connection-badge connection-badge-${tone}`}>{status}</span></div><div className="connection-card-content">{children}</div>{actions && <div className="toolbar">{actions}</div>}</div>;
}
export function ConnectionsOverview({ onlyAi = false }: { onlyAi?: boolean }) {
  const { navigate } = useWorkspace(), { ai, cloud, aiStatus, cloudStatus } = useConnectionStatus();
  return <div className={`connection-overview ${onlyAi ? 'connection-overview-single' : ''}`}>
    {!onlyAi && <ConnectionCard name="Cloudflare" status={cloudStatus.label} tone={cloudStatus.tone} actions={<button className="btn small" onClick={() => navigate('cloud')}>{cloud.info || cloud.savedAddress ? '查看 / 修改云端配置' : '配置云端连接'}</button>}>
      <p>{cloud.address ? safeHost(cloud.address) : '用于家里与工作电脑同步收藏，以及手机查看和提交。'}</p><small>{cloud.info ? `上次连接验证 ${cloud.testedAt ? new Date(cloud.testedAt).toLocaleTimeString('zh-CN') : ''}；并非持续在线检测。` : cloud.rememberToken ? '凭据已在此设备保存；进入云端页会自动验证，不自动同步。' : '可选择在此设备记住凭据；未开启时刷新需重填。'}</small>
    </ConnectionCard>}
    <ConnectionCard name="内置 AI" status={aiStatus.label} tone={aiStatus.tone} actions={<button className="btn small" onClick={() => navigate('aiconfig')}>{ai.profile.apiKey || ai.preferencesSaved ? '查看 / 修改 AI 配置' : '配置内置 AI'}</button>}>
      <p>{ai.profile.provider === 'deepseek' ? 'DeepSeek' : '兼容服务'} · {ai.profile.model || '未选择模型'} · {safeHost(ai.profile.baseUrl)}</p><small>{ai.enabled ? ai.jsonTested ? '问答、整理均已通过测试，发送资料仍需确认。' : '问答可用；整理还需通过输出测试。' : 'Key 仅在当前工作台；测试通过后仍需主动开启。'}</small>
    </ConnectionCard>
  </div>;
}
