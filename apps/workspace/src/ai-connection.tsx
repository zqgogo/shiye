import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { listModels, requestChat, type ChatProfile } from '@shiye/ai-adapter';
import { requestOrigin, extensionApi } from '../../../packages/adapters/browser/src/index.js';
import { toUserMessage } from '@shiye/core';
import { aiPreferences, readAiPreferences, saveAiPreferences } from './ai-preferences.js';

interface Connection {
  fingerprint: string; profile: ChatProfile; change: (patch: Partial<ChatProfile>) => void; enabled: boolean; enable: (value: boolean) => void;
  textTested: boolean; jsonTested: boolean; busy: boolean; cancel: () => void;
  preferencesSaved: boolean; settingsDirty: boolean; modified: boolean; testError: string; textTestedAt: string | null; jsonTestedAt: string | null; testing: 'text' | 'json' | null; revision: React.MutableRefObject<number>; save: () => void;
  test: (json: boolean) => Promise<void>; models: () => Promise<string[]>;
  send: (system: string, material: string, json: boolean, check: () => Promise<void>) => Promise<string>;
}
const Context = createContext<Connection | null>(null);
export function useAiConnection() { const value = useContext(Context); if (!value) throw new Error('AI 配置上下文缺失'); return value; }

export function AiConnectionProvider({ children }: { children: ReactNode }) {
  const [loaded] = useState(readAiPreferences);
  const [profile, setProfile] = useState(loaded.profile);
  const [saved, setSaved] = useState(() => loaded.saved ? JSON.stringify(aiPreferences(loaded.profile)) : '');
  const [modified, setModified] = useState(false), [testError, setTestError] = useState('');
  const [textTestedAt, setTextTestedAt] = useState<string | null>(null), [jsonTestedAt, setJsonTestedAt] = useState<string | null>(null), [testing, setTesting] = useState<'text' | 'json' | null>(null);
  const [fingerprint, setFingerprint] = useState(() => crypto.randomUUID());
  const [enabled, setEnabled] = useState(false);
  const [textTested, setTextTested] = useState(false);
  const [jsonTested, setJsonTested] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const cancel = () => { generation.current++; active.current?.abort(); active.current = null; setBusy(false); setTesting(null); };
  useEffect(() => () => { active.current?.abort(); }, []);
  useEffect(() => {
    const event = extensionApi()?.permissions?.onRemoved;
    if (!event) return;
    const removed = (permissions: chrome.permissions.Permissions) => {
      let origin: string; try { origin = new URL(profile.baseUrl).origin; } catch { return; }
      if (!permissions.origins?.some((pattern) => pattern === '<all_urls>' || pattern === 'https://*/*' || pattern === `${origin}/*`)) return;
      cancel(); setFingerprint(crypto.randomUUID()); setEnabled(false); setTextTested(false); setJsonTested(false); setTextTestedAt(null); setJsonTestedAt(null); setTesting(null); setModified(true); setTestError('此 AI 服务的访问权限已撤销，请重新测试并授权。');
    };
    event.addListener(removed); return () => event.removeListener(removed);
  }, [profile.baseUrl]);
  const change = (patch: Partial<ChatProfile>) => { if (!Object.entries(patch).some(([key, value]) => profile[key as keyof ChatProfile] !== value)) return; cancel(); setFingerprint(crypto.randomUUID()); setProfile((previous) => { let moved = patch.provider !== undefined && patch.provider !== previous.provider; if (patch.baseUrl !== undefined && patch.baseUrl !== previous.baseUrl) { try { moved ||= new URL(patch.baseUrl).origin !== new URL(previous.baseUrl).origin; } catch { moved = true; } } return { ...previous, ...patch, ...(moved && patch.apiKey === undefined ? { apiKey: '' } : {}) }; }); setTextTested(false); setJsonTested(false); setTextTestedAt(null); setJsonTestedAt(null); setEnabled(false); setModified(true); setTestError(''); setTesting(null); };
  const execute = async <T,>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (active.current) throw new Error('已有请求进行中，请等待或取消。');
    const controller = new AbortController(); active.current = controller;
    const version = generation.current;
    setBusy(true);
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      // Called directly from a user gesture; permission precedes all private-material reads.
      await requestOrigin(profile.baseUrl);
      if (version !== generation.current || controller.signal.aborted) throw new Error('配置已变化或请求已取消。');
      const result = await task(controller.signal);
      if (version !== generation.current || controller.signal.aborted) throw new Error('请求已取消，迟到结果已丢弃。');
      return result;
    } catch (cause) {
      if (controller.signal.aborted) throw new Error('请求已取消或超时，服务商可能已处理并计费；没有自动重试。');
      throw cause;
    } finally { clearTimeout(timer); if (active.current === controller) { active.current = null; setBusy(false); } }
  };
  let signature = ''; try { signature = JSON.stringify(aiPreferences(profile)); } catch { /* Incomplete edits are not saved. */ }
  const value: Connection = { fingerprint, profile, change, enabled, textTested, jsonTested, busy, cancel,
    preferencesSaved: Boolean(saved), settingsDirty: !saved || signature !== saved, modified, testError, textTestedAt, jsonTestedAt, testing, revision: generation,
    save: () => { setSaved(saveAiPreferences(profile)); },
    enable: (next) => { if (!next) { cancel(); setEnabled(false); } else if (textTested) setEnabled(true); },
    models: () => execute((signal) => listModels(profile, signal)),
    test: async (json) => { const stamp = generation.current; setTestError(''); setTesting(json ? 'json' : 'text');
      if (json) { setJsonTested(false); setJsonTestedAt(null); } else { setEnabled(false); setTextTested(false); setJsonTested(false); setTextTestedAt(null); setJsonTestedAt(null); }
      try { await execute(async (signal) => {
      const response = await requestChat(profile, json ? '只返回 JSON 对象 {"ok":true}，不要添加其他字段。' : '仅回复 SHIYE_OK。', '合成连接测试，不含个人数据。', signal, json);
      if (json) { let result: unknown; try { result = JSON.parse(response); } catch { throw new Error('服务未通过严格 JSON 测试，请调整模式后重试。'); }
        if (JSON.stringify(result) !== '{"ok":true}') throw new Error('整理输出结构测试未通过。');
      } else { if (response.trim() !== 'SHIYE_OK') throw new Error('文本测试未返回预期内容。'); }
    }); if (stamp === generation.current) { setModified(false); if (json) { setJsonTested(true); setJsonTestedAt(new Date().toISOString()); } else { setTextTested(true); setTextTestedAt(new Date().toISOString()); } }
      } catch (cause) { if (stamp === generation.current) setTestError(toUserMessage(cause)); throw cause; }
      finally { if (stamp === generation.current) setTesting(null); } },
    send: async (system, material, json, check) => {
      if (!enabled || !textTested || (json && !jsonTested)) throw new Error('请先在 AI 设置中完成对应测试并开启内置 AI。');
      return execute(async (signal) => { await check(); if (signal.aborted) throw new Error('已取消'); return requestChat(profile, system, material, signal, json); });
    },
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
