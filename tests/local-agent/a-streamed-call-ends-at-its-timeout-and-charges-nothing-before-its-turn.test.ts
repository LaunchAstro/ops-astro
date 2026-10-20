// SPDX-License-Identifier: AGPL-3.0-only
//
// A streamed call ends at its timeout whatever its child's descendants do: a
// descendant that inherits the child's stdout cannot keep the runner's queue or
// its shutdown waiting. And a call stopped before its turn was sent is charged
// nothing: the model was never asked. (The reviewer's two proofs on the first
// review of this change, assertions unchanged.)
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createRunner } from '../../apps/local-agent/runner.ts';
import { readSettings } from '../../apps/local-agent/settings.ts';
import { LOCAL_GPT_PATH } from '../../packages/core-connectors/src/index.ts';
import { makeWorld, RUNNER_KEY } from './world.ts';

// Long enough for a node child to start and answer its first requests on a laptop busy with
// other runs: a newly written script's first start alone took 165 to 390 ms on macOS, and a
// 200 ms timeout failed there with the child not yet started (#1684).
const TIMEOUT_MS = 2_000;

/** Whether a process is still there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const message = { fields: { message: 'Say hello.' }, stream: true };

// eslint-disable-next-line max-lines-per-function -- the reviewer's proof, kept whole
it('a timed-out streamed child cannot block the runner on an inherited stdout pipe', async () => {
  const w = makeWorld();
  const descendantPid = join(w.agentHome, 'descendant.pid');
  const wrapper = join(w.agentHome, 'wrapper.mjs');
  // A supported CODEX_BIN wrapper launches a child that keeps the stdout pipe
  // open. Killing the wrapper does not produce ChildProcess's close event.
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: ['ignore', 'inherit', 'ignore'],
});
writeFileSync(${JSON.stringify(descendantPid)}, String(child.pid));
setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
  const settings = readSettings({ ...w.env, OPS_LOCAL_AGENT_CODEX_BIN: wrapper }, w.userHome);
  if (!settings.ok) throw new Error(settings.code);
  const r = await createRunner({ ...settings.settings, timeoutMs: TIMEOUT_MS }, () => {});
  const controller = new AbortController();
  const running = fetch(`${r.origin}${LOCAL_GPT_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${RUNNER_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(message),
    signal: controller.signal,
  })
    .then(async (response) => {
      await response.text();
      return true;
    })
    .catch(() => false);
  try {
    const completed = await Promise.race([running, sleep(TIMEOUT_MS * 3).then(() => false)]);
    expect(existsSync(descendantPid)).toBe(true);
    // The call has had three times its timeout to end.
    expect(completed).toBe(true);
    // And the timeout stopped the whole group, the descendant on the pipe included.
    const descendant = Number(readFileSync(descendantPid, 'utf8'));
    await expect
      .poll(() => alive(descendant), {
        timeout: 1_000,
        message: 'the timeout stopped the descendant holding the pipe',
      })
      .toBe(false);
  } finally {
    if (existsSync(descendantPid)) {
      try {
        process.kill(Number(readFileSync(descendantPid, 'utf8')), 'SIGKILL');
      } catch {
        // The descendant has already gone.
      }
    }
    controller.abort();
    await running;
    await r.close();
    w.remove();
  }
}, 15_000);

it('a preparation timeout charges no tokens when turn/start was never sent', async () => {
  const w = makeWorld();
  w.knobs({ prepMs: 10_000 });
  const settings = readSettings(w.env, w.userHome);
  if (!settings.ok) throw new Error(settings.code);
  const r = await createRunner({ ...settings.settings, timeoutMs: TIMEOUT_MS }, () => {});
  try {
    const response = await fetch(`${r.origin}${LOCAL_GPT_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${RUNNER_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(message),
    });
    await response.text();
    const methods = w.appCalls().flatMap((entry) => {
      const sent = entry['message'] as { method?: string } | undefined;
      return sent?.method === undefined ? [] : [sent.method];
    });
    expect(methods).toContain('thread/start');
    expect(methods).not.toContain('turn/start');
    expect(w.asked()).toEqual([]);
    expect(w.ledger().at(-1)).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  } finally {
    await r.close();
    w.remove();
  }
}, 15_000);
