import { useEffect, useState } from 'react';
import { toUserMessage, type AiTask } from '@shiye/core';
import { useAiConnection } from './ai-connection.js';
import { useWorkspace } from './state.js';

export function AiConnectionSettings() {
  const ai = useAiConnection();
  const { service } = useWorkspace();
  const [message, setMessage] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [tasks, setTasks] = useState<AiTask[]>([]);
  useEffect(() => { void service.recentAiTasks().then(setTasks).catch(() => undefined); }, [service]);
  const act = async (action: () => Promise<void>, success: string) => {
    setMessage(''); try { await action(); setMessage(success); } catch (cause) { setMessage(toUserMessage(cause)); }
  };
  const profile = ai.profile;
  return <div className="panel">
    <h2>内置 AI <span className="tag">{ai.enabled ? '已开启' : '未开启'}</span></h2>
    <p>DeepSeek 或文本 Chat Completions 兼容服务。Key 仅存当前工作台内存，刷新后重填；不会经过 Cloudflare。</p>
    <div className="two">
      <label className="field"><span>供应商</span><select value={profile.provider} onChange={(event) => { ai.change(event.target.value === 'deepseek' ? { provider: 'deepseek', baseUrl: 'https://api.deepseek.com' } : { provider: 'compatible' }); setMessage(''); }}><option value="deepseek">DeepSeek</option><option value="compatible">Chat Completions 兼容服务</option></select></label>
      <label className="field"><span>API 地址</span><input value={profile.baseUrl} onChange={(event) => { ai.change({ baseUrl: event.target.value }); setMessage(''); }} /></label>
      <label className="field"><span>模型编号</span><input value={profile.model} list="ai-models" onChange={(event) => { ai.change({ model: event.target.value }); setMessage(''); }} /><datalist id="ai-models">{models.map((model) => <option key={model} value={model} />)}</datalist><small>可手填；模型列表可用不代表问答测试通过。</small></label>
      <label className="field"><span>API Key</span><input type="password" autoComplete="off" value={profile.apiKey} onChange={(event) => { ai.change({ apiKey: event.target.value }); setMessage(''); }} /></label>
      <label className="field"><span>整理 JSON 模式</span><select value={profile.jsonMode} onChange={(event) => ai.change({ jsonMode: event.target.value as 'text' | 'object' })}><option value="text">严格文本 JSON（不要求服务端特殊参数）</option><option value="object">JSON object（服务端需支持）</option></select></label>
      <label className="field"><span>输出长度参数</span><select value={profile.outputParameter} onChange={(event) => ai.change({ outputParameter: event.target.value as 'max_tokens' | 'max_completion_tokens' })}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
      <label className="field"><span>输入预算（字符，含指令）</span><input type="number" min={2000} max={200000} value={profile.inputChars} onChange={(event) => ai.change({ inputChars: Math.min(200000, Math.max(2000, Number(event.target.value) || 2000)) })} /></label>
      <label className="field"><span>最大输出 token</span><input type="number" min={256} max={16000} value={profile.outputTokens} onChange={(event) => ai.change({ outputTokens: Math.min(16000, Math.max(256, Number(event.target.value) || 256)) })} /></label>
    </div>
    <p className="micro">连接测试只发送合成短文本，可能产生少量 API 费用。地址、模型、Key 或预算变化后，测试和开启状态立即失效。</p>
    <div className="toolbar">
      <button className="btn" disabled={ai.busy || !profile.apiKey} onClick={() => void act(async () => setModels(await ai.models()), '模型列表已读取；请完成实际测试。')}>读取模型列表</button>
      <button className="btn" disabled={ai.busy || !profile.apiKey} onClick={() => void act(() => ai.test(false), '文本测试通过。')}>测试文本连接</button>
      <button className="btn" disabled={ai.busy || !profile.apiKey} onClick={() => void act(() => ai.test(true), '整理 JSON 测试通过。')}>测试整理输出</button>
      <button className="btn primary" disabled={!ai.textTested || ai.busy} onClick={() => ai.enable(!ai.enabled)}>{ai.enabled ? '关闭内置 AI' : '开启内置 AI'}</button>
      <button className="btn" onClick={() => { ai.change({ apiKey: '' }); setMessage('Key 已清除，通道已关闭。'); }}>清除 Key</button>
      {ai.busy && <button className="btn" onClick={ai.cancel}>取消请求</button>}
    </div>
    <p className="micro">文本 {ai.textTested ? '通过' : '未测试'} · 整理 JSON {ai.jsonTested ? '通过' : '未测试'}</p>
    <p role="status">{message}</p>
    {tasks.length > 0 && <details><summary>最近 AI 请求（仅本机）</summary>{tasks.map((task) => <p className="micro" key={task.id}>{new Date(task.createdAt).toLocaleString('zh-CN')} · {task.kind === 'ask' ? '问答' : '整理'} · {task.state === 'completed' ? '回复完成，写入另行确认' : '结果未知或页面曾中断，没有自动重试'}</p>)}</details>}
  </div>;
}
