import { expect, it, vi } from 'vitest';
import { completionUrl, requestImportOrganization } from './index.js';

it('兼容地址保留前缀，拒绝在地址中夹带凭据或查询参数', () => {
  expect(completionUrl('https://example.com/v1/').href).toBe('https://example.com/v1/chat/completions');
  expect(completionUrl('https://example.com/v1/chat/completions').href).toBe('https://example.com/v1/chat/completions');
  expect(() => completionUrl('https://name:secret@example.com')).toThrow();
  expect(() => completionUrl('https://example.com?key=secret')).toThrow();
});

it('DeepSeek 请求隔离凭据且只读取最终 content，兼容服务不带专用参数', async () => {
  const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"moves":[]}', reasoning_content: '不可作为建议' } }] })));
  const controller = new AbortController();
  const profile = { baseUrl: 'https://example.com', model: 'my-model', apiKey: 'test-secret', provider: 'deepseek' as const };
  expect(await requestImportOrganization(profile, { title: '标题' }, controller.signal, fetcher)).toBe('{"moves":[]}');
  const request = fetcher.mock.calls[0]![1] as RequestInit;
  expect(request.redirect).toBe('error');
  expect(request.body).not.toContain('test-secret');
  expect(JSON.parse(request.body as string).thinking).toEqual({ type: 'disabled' });
  await requestImportOrganization({ ...profile, provider: 'compatible' }, {}, controller.signal, fetcher);
  expect(JSON.parse(fetcher.mock.calls[1]![1].body).thinking).toBeUndefined();
});

it('通用问答严格要求完整最终文本，忽略推理、拒绝截断和空结果', async () => {
  const { requestChat } = await import('./index.js');
  const profile = { baseUrl: 'https://example.com/v1', model: 'custom', apiKey: 'synthetic-secret', provider: 'compatible' as const,
    jsonMode: 'text' as const, outputParameter: 'max_completion_tokens' as const, inputChars: 1000, outputTokens: 500 };
  const valid = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '答案', reasoning_content: '私有推理' } }] })));
  expect(await requestChat(profile, '指令', '材料', new AbortController().signal, false, valid)).toBe('答案');
  const body = JSON.parse(valid.mock.calls[0]![1].body); expect(body.max_completion_tokens).toBe(500); expect(body.max_tokens).toBeUndefined(); expect(body.thinking).toBeUndefined(); expect(body.response_format).toBeUndefined();
  for (const choice of [{ finish_reason: 'length', message: { content: '残缺' } }, { message: { content: '缺少结束' } }, { finish_reason: 'stop', message: { reasoning_content: '仅推理' } }]) {
    await expect(requestChat(profile, '', '', new AbortController().signal, false, async () => new Response(JSON.stringify({ choices: [choice] })))).rejects.toThrow();
  }
});

it('超出输入预算不发送，供应商错误正文不回显敏感信息', async () => {
  const { requestChat } = await import('./index.js');
  const profile = { baseUrl: 'https://example.com', model: 'custom', apiKey: 'synthetic-secret', provider: 'deepseek' as const,
    jsonMode: 'object' as const, outputParameter: 'max_tokens' as const, inputChars: 10, outputTokens: 500 };
  const fetcher = vi.fn().mockImplementation(async () => new Response('synthetic-secret 不可回显', { status: 401 }));
  await expect(requestChat(profile, '指令'.repeat(20), '材料', new AbortController().signal, false, fetcher)).rejects.toThrow('预算');
  expect(fetcher).not.toHaveBeenCalled();
  await expect(requestChat(profile, '', '', new AbortController().signal, true, fetcher)).rejects.toThrow('Key 无效');
  try { await requestChat(profile, '', '', new AbortController().signal, true, fetcher); } catch (cause) { expect(String(cause)).not.toContain('synthetic-secret'); }
});
