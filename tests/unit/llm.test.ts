import { describe, expect, it } from 'vitest';
import { createClaudeProvider, parsePlan, CLAUDE_MODEL, ClaudeAssistantError } from '@l2s/ai-engine';

function mockFetch(reply: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { h[k] = v; });
    calls.push({ url: String(url), headers: h, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
  }) as typeof fetch;
  return { f, calls };
}

const msg = (text: string, stop = 'end_turn') => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: CLAUDE_MODEL, stop_reason: stop, stop_sequence: null,
  content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 },
});

describe('Claude assistant provider (opt-in, text only)', () => {
  it('sends a structured-output request with text context only', async () => {
    const { f, calls } = mockFetch(msg(JSON.stringify({ understood: true, steps: ['hairFront', 'bogus'], explanation: ['앞머리가 머리 회전을 따라갑니다.'] })));
    const p = createClaudeProvider({ apiKey: 'sk-ant-test', fetch: f });
    const plan = await p.plan('앞머리가 머리 회전에 맞춰 움직이게', { parts: ['Bangs [hairFront]', 'Face [face]'], parameters: ['ParamAngleX'] });
    expect(plan.understood).toBe(true);
    expect(plan.steps).toEqual(['hairFront']); // unknown ids are dropped
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.url).toContain('/v1/messages');
    expect(c.headers['authorization'] ?? c.headers['x-api-key']).toContain('sk-ant-test');
    expect(c.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(c.body.model).toBe(CLAUDE_MODEL);
    expect(c.body.output_config.format.type).toBe('json_schema');
    const raw = JSON.stringify(c.body);
    expect(raw).not.toMatch(/base64|image\/png|"image"/);
    expect(c.body.messages[0].content).toContain('Bangs [hairFront]');
  });

  it('maps auth errors and refusals to user-facing errors', async () => {
    const bad = mockFetch({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
    await expect(createClaudeProvider({ apiKey: 'x', fetch: bad.f }).plan('blink', { parts: [], parameters: [] })).rejects.toThrow('Invalid API key');
    const ref = mockFetch(msg('', 'refusal'));
    await expect(createClaudeProvider({ apiKey: 'x', fetch: ref.f }).plan('blink', { parts: [], parameters: [] })).rejects.toBeInstanceOf(ClaudeAssistantError);
  });

  it('validates model output', () => {
    expect(parsePlan('{"understood":true,"steps":[],"explanation":[]}', 'x').understood).toBe(false);
    expect(() => parsePlan('not json', 'x')).toThrow(ClaudeAssistantError);
  });
});
