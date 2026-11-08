import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Synthetic OpenAI-compatible SSE endpoint; no external requests/credentials. */
export async function mockProvider() {
  const requests: any[] = [];
  const childPending: Array<() => void> = [];
  const busyPending: Array<() => void> = [];
  let serial = 0;
  function answer(res: ServerResponse, text?: string, tool?: { name: string; args: any }) {
    const id = `mock-${++serial}`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: any, finish_reason: string | null = null) => res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    chunk({ role: 'assistant' });
    if (tool) chunk({ tool_calls: [{ index: 0, id: `call-${serial}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] });
    else chunk({ content: text });
    chunk({}, tool ? 'tool_calls' : 'stop');
    res.end('data: [DONE]\n\n');
  }
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const messages = body.messages;
    const userText = (m: any) => typeof m.content === 'string' ? m.content : (m.content ?? []).map((c: any) => c.text ?? '').join('\n');
    const users = messages.filter((m: any) => m.role === 'user').map(userText);
    const latest = users.at(-1) ?? '';
    const last = messages.at(-1);
    const parent = body.tools?.some((t: any) => t.function?.name === 'subagent');
    if (!parent) {
      const work = () => {
        if (!messages.some((m: any) => m.role === 'tool')) answer(res, undefined, { name: 'bash', args: { command: 'printf TOOL_STARTED; sleep 2; printf TOOL_DONE' } });
        else answer(res, `CHILD_SECRET_RESULT cobalt. Inputs: ${users.join(' | ')}`);
      };
      // Hold every child request until explicitly released by the probe.
      childPending.push(work);
    } else if (last.role === 'tool') answer(res, 'PARENT_CONTINUES');
    else if (latest.includes('<system-notification>')) answer(res, 'NOTICE_SEEN');
    else if (latest.startsWith('DELEGATE_ALT')) answer(res, undefined, { name: 'subagent', args: { action: 'spawn', model: 'mock/mock-alt', message: 'MOCK_ALT_CHILD remember cobalt. Use only the scratch task, do not modify files.' } });
    else if (latest.startsWith('DELEGATE')) answer(res, undefined, { name: 'subagent', args: { action: 'spawn', message: 'MOCK_CHILD remember cobalt. Use only the scratch task, do not modify files.' } });
    else if (latest.startsWith('READ')) answer(res, undefined, { name: 'subagent', args: { action: 'read', id: 'j1' } });
    else if (latest.startsWith('SEND')) answer(res, undefined, { name: 'subagent', args: { action: 'send', id: 'j1', message: 'follow-up recall color' } });
    else if (latest.startsWith('STOP')) answer(res, undefined, { name: 'subagent', args: { action: 'stop', id: 'j1' } });
    else if (latest.startsWith('BUSY')) busyPending.push(() => answer(res, 'BUSY_WORK_DONE'));
    else answer(res, 'READY');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  return {
    requests, childPending, busyPending,
    url: `http://127.0.0.1:${address.port}/v1`,
    releaseChild: () => { const next = childPending.shift(); if (!next) throw new Error('No child request to release'); next(); },
    releaseBusy: () => busyPending.shift()?.(),
    close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); },
  };
}

export async function isolatedEnvironment(url: string) {
  await mkdir('tmp', { recursive: true });
  const root = await mkdtemp(resolve('tmp/native-probe-'));
  const agentDir = resolve(root, 'agent');
  await mkdir(agentDir);
  await writeFile(resolve(agentDir, 'models.json'), JSON.stringify({ providers: { mock: {
    baseUrl: url, api: 'openai-completions', apiKey: 'not-a-real-key',
    models: [
      { id: 'mock', name: 'Offline fixture', reasoning: false, contextWindow: 128000, maxTokens: 2048 },
      { id: 'mock-alt', name: 'Offline fixture alt', reasoning: false, contextWindow: 128000, maxTokens: 2048 },
    ],
  } } }));
  await writeFile(resolve(agentDir, 'settings.json'), JSON.stringify({ theme: 'dark', quietStartup: true, cacheWarming: 'off', retry: { enabled: false }, defaultProvider: 'mock', defaultModel: 'mock' }));
  return { root, env: {
    HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: resolve(root, 'sessions'),
    XDG_CONFIG_HOME: resolve(root, 'config'), XDG_DATA_HOME: resolve(root, 'data'), XDG_CACHE_HOME: resolve(root, 'cache'),
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
  } };
}
