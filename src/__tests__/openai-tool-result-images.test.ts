/**
 * Screenshots returned by a tool must reach NON-Anthropic models.
 *
 * Anthropic lets a tool_result carry images; the OpenAI wire format does not
 * (a `tool` message is text-only for most providers). The translation kept
 * only the text and dropped every image, so on OpenAI, Gemini, Mistral, xAI,
 * Groq, Ollama and any OpenAI-compatible endpoint a screenshot arrived as the
 * bare words "Screenshot captured" — and the agent then clicked at coordinates
 * the model had GUESSED. A silent wrong action.
 *
 * These tests capture the request body actually sent over the wire.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { callLLMWithTools } from '../llm/client';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function captureBody() {
  const bodies: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return bodies;
}

function turnsWithScreenshot(content: any) {
  return [
    { role: 'user', content: [{ type: 'text', text: 'take a screenshot' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'screenshot', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content }] },
  ] as any;
}

const base = {
  baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'sk-test',
  isAnthropic: false, system: 'sys',
  tools: [{ name: 'screenshot', description: 'd', input_schema: { type: 'object', properties: {} } }] as any,
};

describe('OpenAI-format translation keeps tool-result screenshots', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('forwards the image as image_url in the message after the tool replies', async () => {
    const bodies = captureBody();
    await callLLMWithTools({ ...base, messages: turnsWithScreenshot([
      { type: 'text', text: 'Screenshot captured' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ]) });

    const msgs = bodies[0].messages;
    const toolIdx = msgs.findIndex((m: any) => m.role === 'tool');
    expect(toolIdx).toBeGreaterThan(-1);
    expect(msgs[toolIdx].tool_call_id).toBe('call_1');

    // the image is present, and it is AFTER the tool reply (OpenAI ordering)
    const after = msgs.slice(toolIdx + 1);
    const imgs = after.flatMap((m: any) => Array.isArray(m.content) ? m.content : [])
      .filter((c: any) => c.type === 'image_url');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].image_url.url).toBe(`data:image/png;base64,${PNG}`);
  });

  it('a tool reply always directly follows the assistant tool_calls', async () => {
    const bodies = captureBody();
    await callLLMWithTools({ ...base, messages: turnsWithScreenshot([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ]) });
    const msgs = bodies[0].messages;
    const asstIdx = msgs.findIndex((m: any) => m.role === 'assistant' && m.tool_calls);
    expect(msgs[asstIdx + 1].role).toBe('tool');
    // image-only result still yields a non-empty tool message
    expect(msgs[asstIdx + 1].content).toBeTruthy();
  });

  it('keeps a plain-string tool_result instead of dropping it to empty', async () => {
    const bodies = captureBody();
    await callLLMWithTools({ ...base, messages: turnsWithScreenshot('window title is Notepad') });
    const tool = bodies[0].messages.find((m: any) => m.role === 'tool');
    expect(tool.content).toBe('window title is Notepad');
  });

  it('text-only results are unchanged and add no extra message', async () => {
    const bodies = captureBody();
    await callLLMWithTools({ ...base, messages: turnsWithScreenshot([{ type: 'text', text: 'done' }]) });
    const msgs = bodies[0].messages;
    const tool = msgs.find((m: any) => m.role === 'tool');
    expect(tool.content).toBe('done');
    expect(msgs[msgs.length - 1].role).toBe('tool'); // nothing appended after it
  });
});
