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
        if (c.message === 'reject-inject') { emit({ type: 'response', id: c.id, command: c.type, success: false, error: 'bad \x9d52;c;SECRET\x9c' }); break; }
        if (active && c.streamingBehavior !== 'steer') throw new Error('must steer');
        if (c.message === 'crashlong') {
          emit({ type: 'agent_start' });
          emit({ type: 'message_start', message: assistant('', { stopReason: 'pending' }) });
          emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'A'.repeat(600) + '\nTAIL_MARKER' } });
          setTimeout(() => process.exit(7), 10);
          break;
        }
        if (c.message === 'fastsettle') {
          const done = assistant('FAST_DONE');
          process.stdout.write([
            { type: 'response', id: c.id, command: c.type, success: true, data: { disposition: 'started' } },
            { type: 'agent_start' },
            { type: 'message_end', message: done },
            { type: 'agent_settled', aborted: false },
          ].map(value => JSON.stringify(value)).join('\n') + '\n');
          break;
        }
        if (c.message === 'crashbeforestart') {
          reply({ disposition: 'started' });
          setTimeout(() => process.exit(7), 20);
          break;
        }
        if (c.message === 'stale-settle') {
          reply({ disposition: 'started' });
          message({ role: 'user', content: c.message, timestamp: Date.now() });
          setTimeout(() => emit({ type: 'agent_settled', aborted: false }), 10);
          setTimeout(() => {
            active = true;
            emit({ type: 'agent_start' });
            emit({ type: 'message_start', message: assistant('', { stopReason: 'pending' }) });
            message(assistant('starting', { content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'second' } }], stopReason: 'toolUse' }));
            emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'second' } });
            emit({ type: 'tool_execution_update', toolCallId: 't1', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'live output' }] } });
          }, 60);
          break;
        }
        if (c.message === 'crashstream') {
          emit({ type: 'agent_start' });
          emit({ type: 'message_start', message: assistant('', { stopReason: 'pending' }) });
          emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'PARTIAL ANSWER' } });
          setTimeout(() => process.exit(7), 10);
          break;
        }
        reply({ disposition: active ? 'queued' : 'started' });
        message({ role: 'user', content: c.message, timestamp: Date.now() });
        if (active) { pending.push(c.message); break; }
        active = true;
        emit({ type: 'agent_start' });
        emit({ type: 'message_start', message: assistant('', { stopReason: 'pending' }) });
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'working …\u2028中' } });
        const command = messages.filter(m => m.role === 'user').length > 1 ? 'second' : 'example';
        message(assistant('starting', { content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command } }], stopReason: 'toolUse' }));
        emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command } });
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
      case 'inject':
        message(assistant('\x1b[2JINJECTED'));
        emit({ type: 'tool_execution_start', toolCallId: 'i1', toolName: 'bash\x1b[2J', args: { command: 'printf \x1b]52;c;SECRET\x07', '\x1b[2Jkey': 'value' } });
        emit({ type: 'tool_execution_update', toolCallId: 'i1', toolName: 'bash', partialResult: { content: [{ type: 'text', text: '\x9b2JPAYLOAD' }, { type: 'text', text: '\x1b]52;c;' }, { type: 'text', text: 'SECRET\x07AFTER' }, { type: 'text', text: '\x1bPq' }, { type: 'text', text: 'DCS_SECRET\x1b\\DCS_AFTER' }, { type: 'image', mimeType: 'image/png\x1b[2JIMAGE_PAYLOAD', data: 'AAAA' }] } });
        emit({ type: 'tool_execution_start', toolCallId: 'i2', toolName: 'edit', args: { path: 'tmp/preview-inject.txt', edits: [{ oldText: 'a', newText: 'b' }] } });
        emit({ type: 'tool_execution_end', toolCallId: 'i2', toolName: 'edit', result: { content: [{ type: 'text', text: 'edited' }], details: { diff: '+1 \x1b[2JEDIT_PAYLOAD' } }, isError: false });
        reply({}); break;
      case 'manyparallel':
        for (let i = 0; i < 16; i++) {
          emit({ type: 'tool_execution_start', toolCallId: `c${i}`, toolName: 'bash', args: { command: `done ${i}` } });
          emit({ type: 'tool_execution_end', toolCallId: `c${i}`, toolName: 'bash', result: { content: [{ type: 'text', text: `done ${i} `.repeat(80) }] }, isError: false });
        }
        emit({ type: 'tool_execution_start', toolCallId: 'live', toolName: 'bash', args: { command: 'live' } });
        emit({ type: 'tool_execution_update', toolCallId: 'live', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'LIVE OUTPUT' }] } });
        reply({}); break;
      case 'thinkingsplit':
        message({ role: 'assistant', content: [
          { type: 'thinking', thinking: '\x1b]52;c;' },
          { type: 'text', text: 'SECRET\x07AFTER' },
        ], timestamp: Date.now(), stopReason: 'stop' });
        reply({}); break;
      case 'interruptthinking':
        emit({ type: 'message_start', message: assistant('', { content: [], stopReason: 'pending' }) });
        for (const assistantMessageEvent of [
          { type: 'thinking_start', contentIndex: 0 },
          { type: 'thinking_delta', contentIndex: 0, delta: '\x1b]52;c;' },
          { type: 'text_start', contentIndex: 1 },
          { type: 'text_delta', contentIndex: 1, delta: 'SECRET\x07AFTER' },
        ]) emit({ type: 'message_update', assistantMessageEvent });
        reply({}); break;
      case 'metadataresult':
        emit({ type: 'tool_execution_start', toolCallId: 'm1', toolName: 'bash', args: { command: 'metadata' } });
        emit({ type: 'tool_execution_end', toolCallId: 'm1', toolName: 'bash', result: {
          content: [{ type: 'text', text: 'BEFORE\x1b]52;c;' }, { type: 'image', mimeType: 'SECRET\x07image/png', data: 'AAAA' }],
          details: { diff: 'SECRET\x07diff' },
        }, isError: false });
        message({ role: 'toolResult', toolCallId: 'm1', toolName: 'bash', content: [
          { type: 'text', text: 'BEFORE\x1b]52;c;' }, { type: 'image', mimeType: 'SECRET\x07image/png', data: 'AAAA' },
        ], details: { diff: 'SECRET\x07diff' }, isError: false });
        reply({}); break;
      case 'diagnosticrecover':
        message(assistant('\x1b]52;c;', { stopReason: 'error', errorMessage: 'SECRET\x07AFTER' }));
        message(assistant('NORMAL_RESULT'));
        emit({ type: 'agent_settled', aborted: false });
        reply({}); break;
      case 'diagnosticpair':
        message(assistant('', { stopReason: 'error', errorMessage: '\x1b]52;c;' }));
        message(assistant('', { stopReason: 'error', errorMessage: 'SECRET\x07AFTER' }));
        emit({ type: 'agent_settled', aborted: false });
        reply({}); break;
      case 'unexecuted':
        message(assistant('', { content: [{ type: 'toolCall', id: 'u1', name: 'bash', arguments: { command: 'NEVER' } }], stopReason: 'aborted', errorMessage: 'not executed' }));
        message(assistant('', { content: [{ type: 'toolCall', id: 'u1', name: 'bash', arguments: { command: 'RAN' } }], stopReason: 'toolUse' }));
        emit({ type: 'tool_execution_start', toolCallId: 'u1', toolName: 'bash', args: { command: 'RAN' } });
        emit({ type: 'tool_execution_end', toolCallId: 'u1', toolName: 'bash', result: { content: [{ type: 'text', text: 'RAN RESULT' }] }, isError: false });
        message({ role: 'toolResult', toolCallId: 'u1', toolName: 'bash', content: [{ type: 'text', text: 'RAN RESULT' }], isError: false });
        reply({}); break;
      case 'failsplit':
        message(assistant('\x1b]52;c;'));
        message(assistant('', { stopReason: 'error', errorMessage: 'SECRET\x07AFTER' }));
        emit({ type: 'agent_settled', aborted: false });
        reply({}); break;
      case 'settlesplit':
        message(assistant('\x1b]52;c;'));
        message(assistant('SECRET\x07AFTER'));
        emit({ type: 'agent_settled', aborted: false });
        reply({}); break;
      case 'partialinject':
        emit({ type: 'message_start', message: assistant('', { content: [], stopReason: 'pending' }) });
        emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'pt', toolName: 'bash' } });
        emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"command":"printf \\u001b]52;c;SECRET\\u0007"}' } });
        reply({}); break;
      case 'splitmessages':
        message(assistant('\x1b]52;c;'));
        message(assistant('SECRET\x07AFTER'));
        reply({}); break;
      case 'interruptsplit':
        message(assistant('\x1b]52;c;'));
        emit({ type: 'message_start', message: assistant('', { content: [], stopReason: 'pending' }) });
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'SECRET\x07AFTER' } });
        reply({}); break;
      case 'resultmessage':
        emit({ type: 'tool_execution_start', toolCallId: 'r1', toolName: 'bash', args: { command: 'result' } });
        emit({ type: 'tool_execution_end', toolCallId: 'r1', toolName: 'bash', result: { content: [{ type: 'text', text: 'VISIBLE' }] }, isError: false });
        message({ role: 'toolResult', toolCallId: 'r1', toolName: 'bash', content: [{ type: 'text', text: 'VISIBLE\x1b]52;c;' }], isError: false });
        reply({}); break;
      case 'parallel':
        emit({ type: 'tool_execution_start', toolCallId: 'p1', toolName: 'bash', args: { command: 'fast' } });
        emit({ type: 'tool_execution_end', toolCallId: 'p1', toolName: 'bash', result: { content: [{ type: 'text', text: 'fast output' }] }, isError: false });
        emit({ type: 'tool_execution_start', toolCallId: 'p2', toolName: 'bash', args: { command: 'slow' } });
        emit({ type: 'tool_execution_update', toolCallId: 'p2', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'slow output' }] } });
        reply({}); break;
      case 'long':
        emit({ type: 'message_start', message: assistant('', { content: [], stopReason: 'pending' }) });
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'A'.repeat(600) + '\nTAIL_MARKER' } });
        reply({}); break;
      case 'result':
        message(assistant('CLEAN \x1b]8;;https://example\x1b\\link\x1b]8;;\x1b\\ \x1b[2J\x07done'));
        active = false; emit({ type: 'agent_settled', aborted: false }); reply({}); break;
      case 'finish':
        emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: 'done' }] }, isError: false });
        message({ role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'done' }], isError: false });
        finish(); reply({}); break;
      case 'settle': emit({ type: 'agent_settled', aborted: false }); reply({}); break;
      case 'longfail':
        message(assistant('A'.repeat(600) + '\nTAIL_MARKER', { stopReason: 'error', errorMessage: 'provider unavailable' }));
        active = false; emit({ type: 'agent_settled', aborted: false }); reply({}); break;
      case 'longfinish':
        message(assistant('A'.repeat(600) + '\nTAIL_MARKER'));
        active = false; emit({ type: 'agent_settled', aborted: false }); reply({}); break;
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
