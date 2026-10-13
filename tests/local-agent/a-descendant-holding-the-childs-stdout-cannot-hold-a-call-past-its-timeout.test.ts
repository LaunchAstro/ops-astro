// SPDX-License-Identifier: AGPL-3.0-only
//
// A streamed call ends at its timeout even when the app-server child has a
// descendant that inherited its stdout and never lets go: the whole process
// group is stopped, and the call is answered without waiting for the pipe to
// close. The descendant is given time to exist before the timeout, so this
// holds on a slow machine as on a fast one; the runner's queue is free after.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunner, type Runner } from '../../apps/local-agent/runner.ts';
import { readSettings } from '../../apps/local-agent/settings.ts';
import { answerOf, call } from './runner-world.ts';
import { makeWorld, type World } from './world.ts';

const TIMEOUT_MS = 2_000;
let world: World | undefined;
let runner: Runner | undefined;
let descendantFile = '';

afterEach(async () => {
  if (existsSync(descendantFile)) {
    try {
      process.kill(Number(readFileSync(descendantFile, 'utf8')), 'SIGKILL');
    } catch {
      // It has already gone.
    }
  }
  await runner?.close();
  world?.remove();
  runner = undefined;
  world = undefined;
});

/** A codex that starts a descendant on its own stdout, says nothing, and never leaves. */
function wrapperIn(w: World): string {
  const wrapper = join(w.agentHome, 'wrapper.mjs');
  descendantFile = join(w.agentHome, 'descendant.pid');
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: ['ignore', 'inherit', 'ignore'],
});
writeFileSync(${JSON.stringify(descendantFile)}, String(child.pid));
setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
  return wrapper;
}

/** Whether `pid` is still running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('a streamed call whose child left a descendant on its stdout', () => {
  it('is answered within its timeout and a grace, and the descendant is stopped with it', async () => {
    const w = makeWorld();
    world = w;
    const read = readSettings({ ...w.env, OPS_LOCAL_AGENT_CODEX_BIN: wrapperIn(w) }, w.userHome);
    if (!read.ok) throw new Error(read.code);
    runner = await createRunner({ ...read.settings, timeoutMs: TIMEOUT_MS }, () => null);
    const asked = call(runner, { fields: { message: 'Say hello.' }, stream: true });
    const answered = await Promise.race([asked, sleep(TIMEOUT_MS + 1_500).then(() => null)]);
    // The descendant existed while the call waited: what follows is about it.
    expect(existsSync(descendantFile)).toBe(true);
    expect(answered && answerOf(answered.raw)).toMatchObject({ code: 'LOCAL_GPT_FAILED' });
    await sleep(100);
    expect(alive(Number(readFileSync(descendantFile, 'utf8')))).toBe(false);
  });
});
