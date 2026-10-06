// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1: a local runner call stopped part way never counts as nothing and never
// outlives what stopped it: the runner closed mid-call, the caller gone, a
// deadline passed while queued, a body torn off mid-read.

import { request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createRunner } from '../../apps/local-agent/runner.ts';
import { readSettings } from '../../apps/local-agent/settings.ts';
import { LOCAL_GPT_PATH } from '../../packages/core-connectors/src/index.ts';
import { runnerWorld } from './runner-world.ts';
import { makeWorld, RUNNER_KEY, type World } from './world.ts';

const { opened, start, call, own } = runnerWorld();
const message = { fields: { message: 'What is on the board today?' } };

/** Until codex has been spawned for `count` calls. */
async function spawned(w: World, count: number): Promise<void> {
  for (let tries = 0; w.calls().length < count && tries < 100; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling one fake process
    await sleep(20);
  }
}

// eslint-disable-next-line max-lines-per-function -- one case per way a call is stopped
describe('a call stopped part way', () => {
  it('a runner closed mid-call kills codex, charges the call as unknown, then lets the home go', async () => {
    const { w, r } = await start();
    w.knobs({ waitMs: 5_000 });
    const pending = call(r, message).catch(() => null);
    await spawned(w, 1);
    // While codex runs, the call is already charged as unknown: a crash here never counts it as nothing.
    expect(w.ledger()).toMatchObject([{ inputTokens: 50_000 }]);
    const began = Date.now();
    await r.close();
    opened.length = 0;
    expect(Date.now() - began).toBeLessThan(3_000);
    // close() waited for the call's own row before letting the home go.
    expect(w.ledger()).toHaveLength(2);
    await pending;
    expect(w.ledger().at(-1)).toMatchObject({ inputTokens: 50_000 });
    const read = readSettings(w.env, w.userHome);
    if (!read.ok) throw new Error(read.code);
    opened.push(await createRunner(read.settings, () => null));
  });

  it('a caller that leaves mid-call stops its codex, charged as unknown', async () => {
    const { w, r } = await start();
    w.knobs({ waitMs: 5_000 });
    const leaving = new AbortController();
    const pending = call(r, message, { signal: leaving.signal }).catch(() => null);
    await spawned(w, 1);
    leaving.abort();
    await pending;
    w.knobs({});
    expect((await call(r, message)).body?.['code']).toBeNull();
    expect(w.ledger()[1]).toMatchObject({ inputTokens: 50_000 });
  });

  it('a call whose deadline passed while it queued is not started', async () => {
    const w = makeWorld();
    // The first call outruns the shared deadline and is killed at it; the second's time is gone.
    w.knobs({ waitMs: 5_000 });
    const read = readSettings(w.env, w.userHome);
    if (!read.ok) throw new Error(read.code);
    own(w);
    const r = await createRunner({ ...read.settings, timeoutMs: 1_000 }, () => null);
    opened.push(r);
    const [first, second] = await Promise.all([call(r, message), call(r, message)]);
    expect(first.body?.['code']).toBe('LOCAL_GPT_FAILED');
    expect(second.body?.['code']).toBe('LOCAL_GPT_FAILED');
    // The second was refused before it was charged or spawned: the first call's two rows are the ledger.
    expect(w.ledger()).toHaveLength(2);
  });

  it('a caller that drops mid-body ends only its own request', async () => {
    const { r } = await start();
    const torn = request(`${r.origin}${LOCAL_GPT_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${RUNNER_KEY}`, 'content-length': '5000' },
    });
    torn.on('error', () => null);
    torn.write('{"fields":');
    await sleep(50);
    torn.destroy();
    await sleep(50);
    expect((await call(r, message)).body?.['code']).toBeNull();
  });
});
