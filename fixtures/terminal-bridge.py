#!/usr/bin/env python3
"""Test-only bounded PTY bridge; protocol input is JSONL, never model context."""
import fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 100, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
print(json.dumps({'type': 'started', 'pid': child.pid}), flush=True)
try:
    while child.poll() is None:
        ready, _, _ = select.select([master, sys.stdin], [], [], 0.1)
        for fd in ready:
            if fd == master:
                try: data = os.read(master, 65536)
                except OSError: data = b''
                if data: print(json.dumps({'type': 'output', 'text': data.decode('utf-8', errors='replace')}), flush=True)
            else:
                line = sys.stdin.readline()
                if not line: child.send_signal(signal.SIGTERM); continue
                command = json.loads(line)
                if command['type'] == 'input': os.write(master, command['text'].encode())
                elif command['type'] == 'resize':
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', command['rows'], command['columns'], 0, 0))
                    child.send_signal(signal.SIGWINCH)
                elif command['type'] == 'stop': child.send_signal(signal.SIGTERM)
    print(json.dumps({'type': 'exit', 'code': child.wait()}), flush=True)
finally:
    if child.poll() is None:
        child.kill(); child.wait()
    os.close(master)
