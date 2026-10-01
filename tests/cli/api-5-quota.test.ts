// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-await-in-loop, max-lines-per-function -- a burst is calls in order; one suite over one world */
//
// `API-5 quota` (#633, TR-SEC-4): the tracker operations are charged by the
// one quota table (`core-records/src/identity/quota.ts`) like every call. A
// burst of them beyond a credential's, a person's or a business's requests,
// or beyond a credential's calls at once, is refused in one plain line and
// does nothing. The tracker exports nothing, so no export limit applies to it.

import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeApi } from '../../apps/api/server.ts';
import { createVerbCli } from '../../apps/cli/verbs.ts';
import type { Transport } from '../../apps/cli/client.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { QUOTAS, type QuotaLimits } from '../../packages/core-records/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { ISSUER, tokenFor } from '../api/fixture.ts';
import { testSignIn } from '../support/sign-in.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { wayfinderWorld, type WayfinderWorld } from '../wayfinder/world.ts';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
const WINDOW = 60_000;

function limits(change: {
  readonly requests?: Partial<QuotaLimits['requests']>;
  readonly concurrent?: Partial<QuotaLimits['concurrent']>;
}): QuotaLimits {
  return {
    ...QUOTAS,
    requests: { ...QUOTAS.requests, windowMs: WINDOW, ...change.requests },
    concurrent: { ...QUOTAS.concurrent, ...change.concurrent },
  };
}

/** A promise and the call that settles it. */
function settleable(): { readonly promise: Promise<void>; readonly settle: () => void } {
  const settles: (() => void)[] = [];
  const promise = new Promise<void>((resolve) => {
    settles.push(resolve);
  });
  return { promise, settle: () => settles[0]?.() };
}

/** A read that holds after its answer, the first time only, until `open()`. */
function latch(): {
  readonly hold: () => Promise<void>;
  readonly entered: Promise<void>;
  readonly open: () => void;
} {
  const opened = settleable();
  const inside = settleable();
  let first = true;
  return {
    hold: async () => {
      if (!first) return;
      first = false;
      inside.settle();
      await opened.promise;
    },
    entered: inside.promise,
    open: opened.settle,
  };
}

async function cliFor(api: Hono, member: Member, business = 'api5quota') {
  const transport: Transport = async (path, body, bearer) =>
    await api.fetch(
      new Request(`http://api.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body,
      }),
    );
  const credential = await tokenFor(member.presented.subject);
  return createVerbCli({ transport, businessKey: business, credential, entry: 'person' });
}

describe.skipIf(serverUrl === undefined)('API-5 quota', () => {
  let w: WayfinderWorld;
  let ann: Member;
  let ben: Member;
  let map = '';
  let clock = 1_000_000;

  beforeAll(async () => {
    w = await wayfinderWorld('api5quota', 'api5quota');
    ann = await w.member('ann', ['read', 'write', 'assign', 'decide']);
    ben = await w.member('ben', ['read', 'write']);
    map = (await w.create(ann, { title: 'quota map' }, { taskType: 'map' })).id;
  }, 180_000);

  afterAll(async () => await w?.drop());

  function app(quota: QuotaLimits, hold?: () => Promise<void>) {
    return composeApi({
      keys: runtimeKeys({ ...process.env }),
      database: w.db.app,
      admin: w.db.admin,
      signIn: testSignIn(ISSUER),
      executeRead: async (...args) => {
        const answer = await executeRead(...args);
        if (hold !== undefined) await hold();
        return answer;
      },
      quota: { limits: quota, now: () => clock },
    }).app;
  }

  const chartCount = async (): Promise<number> => {
    const rows = await w.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.audit_events
        where business_id = $1 and command = 'map.chart' and outcome = 'applied'`,
      [w.business],
    );
    return Number(rows[0]?.n ?? 0);
  };

  it('API-5 quota: a burst of tracker operations beyond a credential’s requests is refused in one plain line, and does nothing', async () => {
    const cli = await cliFor(app(limits({ requests: { credential: 3 } })), ann);
    clock += WINDOW + 1;
    for (let n = 0; n < 3; n += 1) expect((await cli.run(['map', 'frontier', map])).exit).toBe(0);
    const charts = await chartCount();
    const refused = await cli.run(['map', 'chart', '--title', 'over quota']);
    expect(refused.exit).toBe(1);
    expect(refused.out).toMatch(
      /^refused QUOTA_EXCEEDED\. .*Too many requests for this credential\./u,
    );
    expect(refused.out.split('\n')).toHaveLength(1);
    expect(await chartCount()).toBe(charts);
  });

  it('API-5 quota: a person’s tracker requests are counted, and a business’s are shared by its people', async () => {
    const perPerson = await cliFor(app(limits({ requests: { person: 2 } })), ann);
    clock += WINDOW + 1;
    await perPerson.run(['map', 'status', map]);
    await perPerson.run(['map', 'status', map]);
    expect((await perPerson.run(['map', 'status', map])).out).toMatch(
      /Too many requests for this person/u,
    );

    const api = app(limits({ requests: { business: 3 } }));
    clock += WINDOW + 1;
    const annCli = await cliFor(api, ann);
    const benCli = await cliFor(api, ben);
    await annCli.run(['map', 'frontier', map]);
    await annCli.run(['map', 'frontier', map]);
    expect((await benCli.run(['map', 'frontier', map])).exit).toBe(0);
    expect((await benCli.run(['map', 'frontier', map])).out).toMatch(
      /Too many requests for this business/u,
    );
  });

  it('API-5 quota: tracker calls at once beyond a credential’s are refused, and the slot comes back', async () => {
    const gate = latch();
    const api = app(limits({ concurrent: { credential: 1 } }), gate.hold);
    clock += WINDOW + 1;
    const cli = await cliFor(api, ann);
    const held = cli.run(['map', 'frontier', map]);
    await gate.entered;
    const refused = await cli.run(['map', 'status', map]);
    expect(refused.out).toMatch(
      /^refused QUOTA_EXCEEDED\. .*Too many calls at once for this credential/u,
    );
    gate.open();
    expect((await held).exit).toBe(0);
    expect((await cli.run(['map', 'status', map])).exit).toBe(0);
  });
});
