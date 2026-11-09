import { spawn } from 'node:child_process';
let buffer = '';
let messages = [];
let pending = [];
let active = false;
const emit = (data) => process.stdout.write(JSON.stringify(data) + '\n');
const message = (m) => { messages.push(m); emit({ type: 'message_end', message: m }); };
const assistant = (text, extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now(), stopReason: 'stop', ...extra });
function finish() {
  active = false;
  message(assistant('SECRET RESULT: ' + messages.filter(m => m.role === 'user').map(m => m.content).join(' | ')));
  emit({ type: 'agent_end', messages: [], willRetry: false });
  // agent_end is deliberately NOT completion.
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let n;
  while ((n = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
    const c = JSON.parse(line);
    const reply = (data) => emit({ type: 'response', id: c.id, command: c.type, success: true, data });
    switch (c.type) {
      case 'get_state': reply({ sessionId: 'fake-session', model: { provider: 'fake-model', id: 'fake' } }); break;
      case 'get_messages': reply({ messages }); break;
      case 'get_last_assistant_text': reply({ text: messages.findLast(m => m.role === 'assistant')?.content[0].text }); break;
      case 'prompt':
        if (c.message === 'reject') { emit({ type: 'response', id: c.id, command: c.type, success: false, error: 'prompt rejected' }); break; }
        if (active && c.streamingBehavior !== 'steer') throw new Error('must steer');
        reply({ disposition: active ? 'queued' : 'started' });
        message({ role: 'user', content: c.message, timestamp: Date.now() });
        if (active) { pending.push(c.message); break; }
        active = true;
        emit({ type: 'agent_start' });
        emit({ type: 'message_start', message: assistant('', { stopReason: 'pending' }) });
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'working …\u2028中' } });
        message(assistant('starting', { content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'example' } }], stopReason: 'toolUse' }));
        emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'example' } });
        emit({ type: 'tool_execution_update', toolCallId: 't1', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'live output' }] } });
        if (c.message === 'crash') { process.stderr.write('useful crash diagnostic'); process.exit(7); }
        if (c.message === 'malformed') { process.stdout.write('not-json\n'); break; }
        if (c.message === 'descendant') {
          const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); process.send("ready"); setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
          child.once('message', () => emit({ type: 'descendant', pid: child.pid }));
        }
        break;
      case 'stream':
        emit({ type: 'message_start', message: assistant('', { content: [], stopReason: 'pending' }) });
        for (const assistantMessageEvent of [
          { type: 'text_start', contentIndex: 0 },
          { type: 'text_delta', contentIndex: 0, delta: 'streaming 中' },
          { type: 'text_end', contentIndex: 0, content: 'authoritative text' },
          { type: 'thinking_start', contentIndex: 1 },
          { type: 'thinking_delta', contentIndex: 1, delta: 'thinking' },
          { type: 'toolcall_start', contentIndex: 2, id: 'stream-tool', toolName: 'bash' },
          { type: 'toolcall_delta', contentIndex: 2, delta: '{"command":"echo' },
        ]) emit({ type: 'message_update', assistantMessageEvent });
        reply({}); break;
      case 'stream_end': message(assistant('FINAL authoritative message')); reply({}); break;
      case 'finish':
        emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: 'done' }] }, isError: false });
        message({ role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'done' }], isError: false });
        finish(); reply({}); break;
      case 'settle': emit({ type: 'agent_settled', aborted: false }); reply({}); break;
      case 'provider_error': message(assistant('', { stopReason: 'error', errorMessage: 'provider unavailable' })); active = false; emit({ type: 'agent_settled', aborted: false }); reply({}); break;
      case 'unicode': {
        const bytes = Buffer.from(JSON.stringify({ type: 'unicode', text: '中\u2028\u2029🙂' }) + '\r\n');
        for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
        reply({}); break;
      }
      case 'wait': break;
      default: reply({ echo: c.type });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
