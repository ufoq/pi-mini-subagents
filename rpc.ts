import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

export interface Invocation { command: string; args: string[]; cwd: string }
// JSON records at the process boundary. Only the handful of commands/events used
// by this extension are interpreted; unknown native events remain forwardable.
export type RecordData = Record<string, any>;

/** Snapshot only the currently owned tree: Pi bash tools use detached groups. */
async function descendants(root: number): Promise<number[]> {
  if (process.platform !== 'linux') return [];
  const parents = new Map<number, number>();
  await Promise.all((await readdir('/proc')).filter(n => /^\d+$/.test(n)).map(async n => {
    try {
      const stat = await readFile(`/proc/${n}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      parents.set(Number(n), Number(fields[1]));
    } catch { /* Process exited during snapshot. */ }
  }));
  const owned = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of parents) {
      if (!owned.has(pid) && owned.has(parent)) { owned.add(pid); changed = true; }
    }
  }
  return [...owned].filter(pid => pid !== root).reverse();
}

export class RpcProcess {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private writing: Promise<void> = Promise.resolve();
  private pending = new Map<string, { resolve: (data: RecordData) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private stderr = '';
  private failure?: Error;
  private stopping?: Promise<void>;
  private inputClosed = false;
  private closed: Promise<void>;
  readonly pid?: number;

  private onEvent: (event: RecordData) => void;
  private onFailure: (error: Error) => void;

  constructor(invocation: Invocation, onEvent: (event: RecordData) => void, onFailure: (error: Error) => void) {
    this.onEvent = onEvent;
    this.onFailure = onFailure;
    this.child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd, env: process.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = this.child.pid;
    this.closed = new Promise(resolve => this.child.once('close', () => {
      if (!this.stopping) this.fail(new Error(`Pi RPC exited (code=${this.child.exitCode}, signal=${this.child.signalCode}). ${this.stderr}`));
      resolve();
    }));
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stdout.on('error', error => this.fail(error));
    this.child.stderr.on('error', error => this.fail(error));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-8192); });
    // setEncoding uses Node's streaming UTF-8 decoder, including split codepoints.
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      if (this.failure || this.stopping) return; // Keep draining, but never revive a failed transport.
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).replace(/\r$/, '');
        this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        let record: RecordData;
        try {
          record = JSON.parse(line);
          if (!record || typeof record.type !== 'string') throw new Error('missing record type');
        } catch (error) {
          this.fail(new Error(`Invalid Pi RPC JSON: ${String(error)}. ${this.stderr}`));
          void this.stop();
          return;
        }
        if (record.type === 'response') {
          const pending = this.pending.get(record.id);
          if (!pending) continue;
          this.pending.delete(record.id);
          if (record.success) pending.resolve(record.data ?? {});
          else pending.reject(new Error(record.error ?? `RPC ${record.command} failed`));
        } else this.onEvent(record);
      }
    });
  }

  request(type: string, fields: RecordData = {}): Promise<RecordData> {
    if (this.failure || this.stopping) return Promise.reject(this.failure ?? new Error('Pi RPC stopped'));
    const id = `r${++this.sequence}`;
    const line = JSON.stringify({ ...fields, type, id }) + '\n';
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Serialize pipe writes through their flush callbacks. This is transport
      // backpressure, not a second prompt/steering scheduler.
      this.writing = this.writing.then(() => new Promise<void>((flushed, failed) => {
        if (this.failure || this.stopping) { flushed(); return; }
        this.child.stdin.write(line, error => error ? failed(error) : flushed());
      })).catch(error => this.fail(error));
    });
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (!this.stopping && !this.inputClosed) this.onFailure(error);
  }

  /** Native orderly shutdown (EOF). A caller may still use stop as a fallback. */
  closeInput(): Promise<void> {
    this.inputClosed = true;
    this.child.stdin.end();
    return this.closed;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    // Defer work one microtask so stopping is set before fail/close handlers.
    this.stopping = Promise.resolve().then(async () => {
      this.fail(new Error('Pi RPC stopped'));
      const owned = this.pid ? await descendants(this.pid) : [];
      const signal = (pid: number, name: NodeJS.Signals) => {
        try { process.kill(process.platform === 'win32' ? pid : -pid, name); } catch (e: any) { if (e.code !== 'ESRCH') throw e; }
        // Non-group-leader descendants need a direct signal too.
        try { process.kill(pid, name); } catch (e: any) { if (e.code !== 'ESRCH') throw e; }
      };
      this.child.stdin.end();
      for (const pid of owned) signal(pid, 'SIGTERM');
      if (this.pid) signal(this.pid, 'SIGTERM');
      // Always finish the group cleanup, even if the leader exits first.
      if (this.pid) {
        await new Promise(resolve => setTimeout(resolve, 300));
        for (const pid of owned) signal(pid, 'SIGKILL');
        signal(this.pid, 'SIGKILL');
      }
      await this.closed;
    });
    return this.stopping;
  }
}
