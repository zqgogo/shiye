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
