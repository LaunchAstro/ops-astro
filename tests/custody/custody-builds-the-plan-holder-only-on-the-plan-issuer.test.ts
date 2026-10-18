// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody's process builds the plan's token holder only through
// `productionTokenHolder` (#1704, #1620 P4), so it holds a plan only on
// `https://auth.openai.com`. Told a loopback issuer, which a test holder
// would take, it refuses to start, and the issuer hears nothing. Half the
// plan's settings refuse it too. Custody's plan wiring names no other way to
// build a holder.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startCustody } from '../../packages/core-custody/src/agent.ts';
import { startIssuer, type Issuer } from './fixtures/plan-issuer.ts';
import { openPlanRouteWorld } from './fixtures/plan-route-world.ts';
import { tempDir } from './fixtures/plan-token-world.ts';

const ROOT = resolve(import.meta.dirname, '../..');

/** Why custody would not start on `issuer`; a custody that did start is stopped and fails the case. */
async function refusal(issuer: string): Promise<string> {
  try {
    const world = await openPlanRouteWorld({ issuer });
    await world.close();
    return 'custody started';
  } catch (error) {
    return (error as Error).message;
  }
}

let issuer: Issuer;
beforeAll(async () => {
  issuer = await startIssuer();
});
afterAll(async () => {
  await issuer.close();
});

it('custody told a loopback issuer refuses to start, and the issuer hears nothing', async () => {
  const before = issuer.count();
  expect(await refusal(issuer.url.origin)).toMatch(/custody did not start/u);
  expect(issuer.count() - before).toBe(0);
}, 15_000);

it('custody told an issuer that is not the plan’s refuses to start', async () => {
  for (const other of ['http://auth.openai.com', 'https://auth.openai.com.example']) {
    // oxlint-disable-next-line no-await-in-loop -- one custody at a time
    expect(await refusal(other)).toMatch(/custody did not start/u);
  }
}, 15_000);

it('custody given a plan token file with no issuer refuses to start', async () => {
  const dir = tempDir();
  const credentialsFile = join(dir.dir, 'credentials.json');
  writeFileSync(credentialsFile, '[]', { mode: 0o600 });
  try {
    const started = await startCustody({
      credentialsFile,
      destinations: [],
      plan: { tokenFile: dir.file, issuer: '' },
    }).then(
      async (custody) => {
        await custody.stop();
        return 'custody started';
      },
      (error: Error) => error.message,
    );
    expect(started).toMatch(/custody did not start/u);
  } finally {
    dir.done();
  }
}, 15_000);

it('custody on the plan issuer starts and prepares a live pair from its file alone', async () => {
  const world = await openPlanRouteWorld();
  try {
    expect(await world.custody.prepare()).toStrictEqual({ ok: true });
    expect(world.sent).toStrictEqual([]);
  } finally {
    await world.close();
  }
}, 15_000);

it('custody’s plan wiring builds its holder through the production holder only', () => {
  const sources = ['custody-main.ts', 'custody-plan.ts'].map((file) =>
    readFileSync(join(ROOT, 'packages/core-custody/src', file), 'utf8'),
  );
  const all = sources.join('\n');
  expect(all).toMatch(/\bproductionTokenHolder\(/u);
  expect(all).not.toMatch(/\btokenHolder\b/u);
});
