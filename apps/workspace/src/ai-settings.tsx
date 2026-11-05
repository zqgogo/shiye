import { useEffect, useRef, useState } from 'react';
import { toUserMessage, type AiTask } from '@shiye/core';
import { useAiConnection } from './ai-connection.js';
import { useWorkspace } from './state.js';
import { ConnectionCard, safeHost, useConnectionStatus } from './connection-status.js';

export function AiConnectionSettings() {
  const ai = useAiConnection();
  const { aiStatus } = useConnectionStatus();
  const { service } = useWorkspace();
  const [message, setMessageState] = useState('');
  const messageRevision = useRef(ai.revision.current);
  const setMessage = (text: string) => { messageRevision.current = ai.revision.current; setMessageState(text); };
  const [models, setModels] = useState<string[]>([]);
  const [tasks, setTasks] = useState<AiTask[]>([]);
  const [editorOpen, setEditorOpen] = useState(!ai.enabled);
  useEffect(() => { setModels([]); }, [ai.fingerprint]);
  useEffect(() => { void service.recentAiTasks().then(setTasks).catch(() => undefined); }, [service]);
  const act = async (action: () => Promise<void>, success: string) => {
    const stamp = ai.revision.current;
    setMessage(''); try { await action(); if (stamp === ai.revision.current) setMessage(success); } catch (cause) { if (stamp === ai.revision.current) setMessage(toUserMessage(cause)); }
  };
  const profile = ai.profile;
  return <div className="panel">
    <h2>内置 AI 配置</h2>
    <ConnectionCard name={profile.provider === 'deepseek' ? 'DeepSeek' : 'Chat Completions 兼容服务'} status={aiStatus.label} tone={aiStatus.tone} actions={<button className="btn small" onClick={() => setEditorOpen(true)}>修改 AI 配置</button>}>
      <p>{profile.model || '尚未选择模型'} · {safeHost(profile.baseUrl)}</p>
      <div className="connection-checks"><span className={ai.textTested ? 'check-ready' : ''}>问答连接：{ai.textTested ? '已通过' : '待测试'}</span><span className={ai.jsonTested ? 'check-ready' : ''}>整理输出：{ai.jsonTested ? '已通过' : '待测试'}</span><span>通道：{ai.enabled ? '已开启' : '已关闭'}</span></div>
      <small>{ai.settingsDirty ? '当前普通设置尚未保存；保存后仍需测试，不会保存 Key。' : '普通设置已保存；Key 和测试结果仅在当前工作台，刷新后需重填并测试。'}</small>
      {ai.modified && !ai.textTested && <p>配置已修改，旧测试和开启状态已失效；请重新测试，再开启。</p>}
      {ai.testError && <p className="alert">最近测试：{ai.testError}</p>}
      {ai.textTestedAt && <small>上次问答验证 {new Date(ai.textTestedAt).toLocaleString('zh-CN')}；不是持续在线检测。</small>}
    </ConnectionCard>
    <p>DeepSeek 或文本 Chat Completions 兼容服务。Key 仅存当前工作台内存，刷新后重填；不会经过 Cloudflare。</p>
    <details className="connection-editor" open={editorOpen} onToggle={(event) => setEditorOpen(event.currentTarget.open)}><summary>连接配置 · 供应商、模型与 Key</summary>
    <div className="two">
      <label className="field"><span>供应商</span><select value={profile.provider} onChange={(event) => { ai.change(event.target.value === 'deepseek' ? { provider: 'deepseek', baseUrl: 'https://api.deepseek.com' } : { provider: 'compatible' }); setMessage(''); }}><option value="deepseek">DeepSeek</option><option value="compatible">Chat Completions 兼容服务</option></select></label>
      <label className="field"><span>API 地址</span><input value={profile.baseUrl} onChange={(event) => { ai.change({ baseUrl: event.target.value }); setMessage(''); }} /></label>
      <label className="field"><span>模型编号</span><input value={profile.model} list="ai-models" onChange={(event) => { ai.change({ model: event.target.value }); setMessage(''); }} /><datalist id="ai-models">{models.map((model) => <option key={model} value={model} />)}</datalist><small>可手填；模型列表可用不代表问答测试通过。</small></label>
      <label className="field"><span>API Key</span><input type="password" autoComplete="off" value={profile.apiKey} onChange={(event) => { ai.change({ apiKey: event.target.value }); setMessage(''); }} /></label>
      <label className="field"><span>整理 JSON 模式</span><select value={profile.jsonMode} onChange={(event) => ai.change({ jsonMode: event.target.value as 'text' | 'object' })}><option value="text">严格文本 JSON（不要求服务端特殊参数）</option><option value="object">JSON object（服务端需支持）</option></select></label>
      <label className="field"><span>输出长度参数</span><select value={profile.outputParameter} onChange={(event) => ai.change({ outputParameter: event.target.value as 'max_tokens' | 'max_completion_tokens' })}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
      <label className="field"><span>输入预算（字符，含指令）</span><input type="number" min={2000} max={200000} value={profile.inputChars} onChange={(event) => ai.change({ inputChars: Math.min(200000, Math.max(2000, Math.floor(Number(event.target.value)) || 2000)) })} /></label>
      <label className="field"><span>最大输出 token</span><input type="number" min={256} max={16000} value={profile.outputTokens} onChange={(event) => ai.change({ outputTokens: Math.min(16000, Math.max(256, Math.floor(Number(event.target.value)) || 256)) })} /></label>
    </div>
    </details>
    <p className="micro">连接测试只发送合成短文本，可能产生少量 API 费用。地址、模型、Key 或预算变化后，测试和开启状态立即失效。</p>
    <div className="toolbar">
      <button className="btn" disabled={ai.busy} onClick={() => void act(async () => ai.save(), '普通设置已保存；Key 不保存，连接仍需测试并开启。')}>保存普通设置（不含 Key）</button>
      <button className="btn" disabled={ai.busy || !profile.apiKey} onClick={() => void act(async () => setModels(await ai.models()), '模型列表已读取；请完成实际测试。')}>读取模型列表</button>
      <button className="btn" disabled={ai.busy || !profile.apiKey} onClick={() => void act(() => ai.test(false), '文本测试通过。')}>测试文本连接</button>
      <button className="btn" disabled={ai.busy || !profile.apiKey} onClick={() => void act(() => ai.test(true), '整理 JSON 测试通过。')}>测试整理输出</button>
      <button className="btn primary" disabled={!ai.textTested || ai.busy} onClick={() => { ai.enable(!ai.enabled); if (!ai.enabled) setEditorOpen(false); }}>{ai.enabled ? '关闭内置 AI' : '开启内置 AI'}</button>
      <button className="btn" onClick={() => { ai.change({ apiKey: '' }); setEditorOpen(true); setMessage('Key 已清除，通道已关闭。'); }}>清除 Key</button>
      {ai.busy && <button className="btn" onClick={() => { ai.cancel(); setMessage('已取消请求，没有自动重试。'); }}>取消请求</button>}
    </div>
    <p className="micro">文本 {ai.textTested ? '通过' : '未测试'} · 整理 JSON {ai.jsonTested ? '通过' : '未测试'}</p>
    <p role="status">{messageRevision.current === ai.revision.current ? message : ''}</p>
    {tasks.length > 0 && <details><summary>最近 AI 请求（仅本机）</summary>{tasks.map((task) => <p className="micro" key={task.id}>{new Date(task.createdAt).toLocaleString('zh-CN')} · {task.kind === 'ask' ? '问答' : '整理'} · {task.state === 'completed' ? '回复完成，写入另行确认' : '结果未知或页面曾中断，没有自动重试'}</p>)}</details>}
  </div>;
}
