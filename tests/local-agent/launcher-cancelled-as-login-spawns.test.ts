// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol PRV-oa-1107-SC1: Ctrl-C in the moment between the login check's spawn
// and its hold on cancel still stops the check. The launcher is held there by
// the inspector, the way Sol's scenario holds it, and no product line changes.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { makeWorld, type World } from './world.ts';

let world: World | undefined;
const left: number[] = [];
afterEach(() => {
  for (const pid of left.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL');
  world?.remove();
  world = undefined;
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const pidIn = (file: string): number | null =>
  existsSync(file) ? Number(readFileSync(file, 'utf8')) : null;

const codexFile = resolve('apps/local-agent/codex.ts');

/** The 0-based line codexLogin runs first once its spawn has returned. */
function lineAfterLoginSpawn(): number {
  const lines = readFileSync(codexFile, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('export async function codexLogin('));
  const at = lines.findIndex((l, i) => i > start && l.trim() === 'const parts: Buffer[] = [];');
  if (start < 0 || at < 0) throw new Error('codexLogin no longer reads as this test expects');
  return at;
}

/** A small Chrome DevTools Protocol client over the inspector's socket. */
function inspector(url: string): {
  ready: Promise<void>;
  send: (method: string, params?: object) => Promise<unknown>;
  paused: () => Promise<void>;
  close: () => void;
} {
  const socket = new WebSocket(url);
  let id = 0;
  const replies = new Map<number, (result: unknown) => void>();
  const pauses: (() => void)[] = [];
  let pending = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      result?: unknown;
    };
    if (message.id !== undefined) replies.get(message.id)?.(message.result);
    if (message.method === 'Debugger.paused') {
      const next = pauses.shift();
      if (next) next();
      else pending += 1;
    }
  });
  return {
    ready: new Promise((ok) => {
      socket.addEventListener('open', () => ok());
    }),
    send: (method, params = {}) =>
      new Promise((ok) => {
        id += 1;
        replies.set(id, ok);
        socket.send(JSON.stringify({ id, method, params }));
      }),
    paused: () =>
      pending > 0
        ? ((pending -= 1), Promise.resolve())
        : new Promise((ok) => {
            pauses.push(ok);
          }),
    close: () => socket.close(),
  };
}

it('Ctrl-C just after the login check spawns, before anything else runs, still stops its group', async () => {
  world = makeWorld();
  world.knobs({ login: 'wrapper' });
  const launcher = spawn(
    process.execPath,
    ['--inspect-brk=127.0.0.1:0', 'apps/local-agent/stack.ts'],
    { env: world.env, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  if (launcher.pid !== undefined) left.push(launcher.pid);
  const exited = once(launcher, 'exit');
  let said = '';
  const url = await new Promise<string>((ok) => {
    launcher.stderr.on('data', (b: Buffer) => {
      said += b.toString('utf8');
      const found = /ws:\/\/\S+/u.exec(said);
      if (found) ok(found[0]);
    });
  });
  const cdp = inspector(url);
  await cdp.ready;
  await cdp.send('Debugger.enable');
  await cdp.send('Debugger.setBreakpointByUrl', {
    url: pathToFileURL(codexFile).href,
    lineNumber: lineAfterLoginSpawn(),
  });
  await cdp.send('Runtime.runIfWaitingForDebugger');
  // --inspect-brk stops on the first line; the next stop is the breakpoint.
  await cdp.paused();
  await cdp.send('Debugger.resume');
  await cdp.paused();

  const wrapperFile = join(world.codexHome, 'wrapper.pid');
  const descendantFile = join(world.codexHome, 'descendant.pid');
  await expect
    .poll(() => pidIn(wrapperFile) !== null && pidIn(descendantFile) !== null, { timeout: 4_000 })
    .toBe(true);
  const pids = [pidIn(wrapperFile) ?? 0, pidIn(descendantFile) ?? 0];
  left.push(...pids);

  // Ctrl-C while the launcher is held in that moment, then let it run on;
  // a launcher on its way out waits for the inspector to go.
  launcher.kill('SIGINT');
  await Promise.race([cdp.send('Debugger.resume'), exited]);
  cdp.close();
  await exited;
  // Well inside the ten-second deadline the launcher no longer runs to keep.
  await expect.poll(() => pids.filter((pid) => alive(pid)), { timeout: 3_000 }).toStrictEqual([]);
}, 20_000);
