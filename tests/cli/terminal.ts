// SPDX-License-Identifier: AGPL-3.0-only
//
// A pseudo-terminal for a command-line test, with no shell anywhere in it
// (product issue 47, CodeQL alert 10).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * The system Python at a fixed path, checked once, gives the command a
 * pseudo-terminal through its `pty` module. The command's arguments reach
 * `os.execv` as they are, with no shell between (CodeQL alert 10). The relay
 * copies stdin to the terminal and the terminal to stdout until the command
 * exits, then exits with its code. `pty.spawn` is not used: on macOS it waits
 * for an end of file the terminal never sends once the command has gone.
 */
const PYTHON = '/usr/bin/python3';
const RELAY = `import os, pty, select, sys
pid, tty = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
route = {0: tty, tty: 1}
done = 0
while tty in route:
    ready = select.select([tty] if done else list(route), [], [], 0 if done else 0.05)[0]
    if done and not ready:
        break
    for fd in ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b''
        if data:
            os.write(route[fd], data)
        else:
            del route[fd]
    if not done:
        done, status = os.waitpid(pid, os.WNOHANG)
if not done:
    done, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
const PTY_READY =
  existsSync(PYTHON) && spawnSync(PYTHON, ['-c', 'import pty'], { stdio: 'ignore' }).status === 0;

export function underTerminal(command: readonly string[]): readonly string[] | undefined {
  return PTY_READY ? [PYTHON, '-c', RELAY, ...command] : undefined;
}
