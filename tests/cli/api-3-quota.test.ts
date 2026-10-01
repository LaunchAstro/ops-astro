// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-await-in-loop, max-lines-per-function -- a burst is calls in order; one suite over one world */
//
// `API-3 quota` (TR-SEC-4): requests and concurrent calls per credential, per
// person and per business, and the page size, set in one place
// (`core-records/src/identity/quota.ts`). A burst beyond a quota is refused
// with a plain reason and recorded; a refused call does nothing; the quota
// comes back when its window passes or its call ends. Each case runs over the
// real composed API with small limits and a clock the test moves.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeApi } from '../../apps/api/server.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { PAGE_SIZE } from '../../packages/core-commands/src/reads/detail.ts';
import { QUOTAS, type QuotaLimits } from '../../packages/core-records/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { DELEGATION_HEADER, PREFIX } from '../../packages/core-wire/src/index.ts';
import { ISSUER, tokenFor } from '../api/fixture.ts';
import { testSignIn } from '../support/sign-in.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { wayfinderWorld, type WayfinderWorld } from '../wayfinder/world.ts';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WINDOW = 60_000;

/** Generous everywhere but the one line a case sets low. */
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

interface Answer {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

function expectQuotaRefusal(answer: Answer, dimension: string, holder: string): void {
  expect(answer.status).toBe(429);
  expect(answer.body['code']).toBe('QUOTA_EXCEEDED');
  expect(answer.body['names']).toStrictEqual([dimension, holder]);
  const fixes = answer.body['fixes'] as readonly string[];
  expect(fixes).toHaveLength(1);
  // A plain reason: what ran out, for whom, and when to try again.
  expect(fixes[0]).toMatch(/^Too many .+ for this (credential|person|business)\..+again/u);
}

/**
 * A read that stops after its answer until `open()` is called, the first
 * time only: `entered` settles once it is holding.
 */
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

function settleable(): { readonly promise: Promise<void>; readonly settle: () => void } {
  const settles: (() => void)[] = [];
  const promise = new Promise<void>((resolve) => {
    settles.push(resolve);
  });
  return { promise, settle: () => settles[0]?.() };
}

describe.skipIf(serverUrl === undefined)('API-3 quota', () => {
  let w: WayfinderWorld;
  let ann: Member;
  let ben: Member;
  let bea: Member;
  let clock = 1_000_000;
  const now = (): number => clock;

  beforeAll(async () => {
    w = await wayfinderWorld('api3quota', 'api3quota');
    ann = await w.member('ann', ['read', 'write']);
    ben = await w.member('ben', ['read', 'write']);
    bea = await w.outsider('bea');
  }, 180_000);

  afterAll(async () => await w?.drop());

  /** An app over the world's database with these limits, and an optional hold on reads. */
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
      quota: { limits: quota, now },
    }).app;
  }

  async function call(
    api: ReturnType<typeof app>,
    member: Member | string,
    path: string,
    body: Readonly<Record<string, unknown>>,
    options: { readonly business?: string; readonly delegation?: string } = {},
  ): Promise<Answer> {
    const subject = typeof member === 'string' ? member : member.presented.subject;
    const prefix = options.delegation === undefined ? PREFIX.person : PREFIX.agent;
    const response = await api.fetch(
      new Request(`http://api.test${prefix}${options.business ?? 'api3quota'}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor(subject)}`,
          ...(options.delegation === undefined ? {} : { [DELEGATION_HEADER]: options.delegation }),
        },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as Answer['body'] };
  }

  const board = { board: null, detail: 'brief' };

  async function refusedAttempts(business = w.business): Promise<number> {
    const rows = await w.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.authentication_attempts
        where business_id = $1 and outcome = 'refused' and refusal_code = 'QUOTA_EXCEEDED'`,
      [business],
    );
    return Number(rows[0]?.n ?? 0);
  }

  it('API-3 quota: a burst beyond a credential’s requests is refused, recorded, and writes nothing', async () => {
    const api = app(limits({ requests: { credential: 3 } }));
    for (let n = 0; n < 3; n += 1) {
      expect((await call(api, ann, '/task/board', board)).status).toBe(200);
    }
    const before = await refusedAttempts();
    const refused = await call(api, ann, '/task/create', {
      operationId: crypto.randomUUID(),
      fields: { title: 'quota-canary-refused-write' },
    });
    expectQuotaRefusal(refused, 'requests', 'credential');
    expect(await refusedAttempts()).toBe(before + 1);
    const made = await w.db.admin.execute(
      `select 1 from public.records where business_id = $1 and data->>'title' = $2`,
      [w.business, 'quota-canary-refused-write'],
    );
    expect(made).toHaveLength(0);
  });

  it('API-3 quota: exhaustion lasts until the window passes, and refused calls do not extend it', async () => {
    const api = app(limits({ requests: { credential: 2 } }));
    await call(api, ann, '/task/board', board);
    await call(api, ann, '/task/board', board);
    for (let n = 0; n < 5; n += 1) {
      expectQuotaRefusal(await call(api, ann, '/task/board', board), 'requests', 'credential');
    }
    clock += WINDOW + 1;
    expect((await call(api, ann, '/task/board', board)).status).toBe(200);
  });

  it('API-3 quota: a person’s requests are counted across what they call with', async () => {
    const api = app(limits({ requests: { person: 2 } }));
    clock += WINDOW + 1;
    await call(api, ann, '/task/board', board);
    await call(api, ann, '/task/board', board);
    expectQuotaRefusal(await call(api, ann, '/task/board', board), 'requests', 'person');
  });

  it('API-3 quota: a business’s requests are shared by its people, and never another business’s', async () => {
    const api = app(limits({ requests: { business: 3 } }));
    clock += WINDOW + 1;
    await call(api, ann, '/task/board', board);
    await call(api, ann, '/task/board', board);
    expect((await call(api, ben, '/task/board', board)).status).toBe(200);
    expectQuotaRefusal(await call(api, ben, '/task/board', board), 'requests', 'business');
    // Another business's quota is its own: bravo answers, and nothing is
    // recorded against it.
    const bravoBefore = await refusedAttempts(w.bravo);
    expect(
      (await call(api, bea, '/task/board', board, { business: 'api3quota-bravo' })).status,
    ).toBe(200);
    expect(await refusedAttempts(w.bravo)).toBe(bravoBefore);
  });

  it('API-3 quota: a caller the business does not admit uses none of its quota', async () => {
    const api = app(limits({ requests: { business: 2 } }));
    clock += WINDOW + 1;
    for (let n = 0; n < 5; n += 1) {
      const outside = await call(api, bea, '/task/board', board);
      expect(outside.body['code']).toBe('AUTH_NO_MEMBERSHIP');
    }
    expect((await call(api, ann, '/task/board', board)).status).toBe(200);
    expect((await call(api, ben, '/task/board', board)).status).toBe(200);
  });

  it('API-3 quota: concurrent calls beyond a credential’s are refused, and the slot comes back when the call ends', async () => {
    const held = latch();
    const api = app(limits({ concurrent: { credential: 1 } }), held.hold);
    clock += WINDOW + 1;
    const first = call(api, ann, '/task/board', board);
    await held.entered;
    expectQuotaRefusal(await call(api, ann, '/task/board', board), 'concurrent', 'credential');
    // Another person's calls are not this credential's.
    expect((await call(api, ben, '/task/board', board)).status).toBe(200);
    held.open();
    expect((await first).status).toBe(200);
    expect((await call(api, ann, '/task/board', board)).status).toBe(200);
  });

  it('API-3 quota: a call that faults gives its concurrent slot back', async () => {
    let fault = true;
    const api = app(limits({ concurrent: { credential: 1 } }), () => {
      if (!fault) return Promise.resolve();
      fault = false;
      return Promise.reject(new Error('a fault after the read'));
    });
    clock += WINDOW + 1;
    expect((await call(api, ann, '/task/board', board)).status).toBe(503);
    expect((await call(api, ann, '/task/board', board)).status).toBe(200);
  });

  it('API-3 quota: an agent’s calls count against its own credential', async () => {
    const api = app(limits({ requests: { credential: 2 } }));
    clock += WINDOW + 1;
    const picked = await w.pickUp(await w.decider('quota-delegator'), 'quota agent task');
    const agentCall = async () =>
      await call(
        api,
        w.agentSubject(),
        '/task/read',
        { operationId: crypto.randomUUID(), recordId: picked.taskId },
        {
          delegation: picked.credential,
        },
      );
    expect((await agentCall()).status).toBe(200);
    expect((await agentCall()).status).toBe(200);
    expectQuotaRefusal(await agentCall(), 'requests', 'credential');
    // The agent's burst is not the person's.
    expect((await call(api, ann, '/task/board', board)).status).toBe(200);
  });

  it('API-3 quota: page size is set in the one quota table, and a larger page is refused', async () => {
    expect(PAGE_SIZE).toBe(QUOTAS.pageSize);
    const api = app(QUOTAS);
    const over = await call(api, ann, '/task/board', {
      ...board,
      limit: QUOTAS.pageSize.most + 1,
    });
    expect(over.status).toBe(422);
    expect(over.body['code']).toBe('FIELD_VALUE_INVALID');
    expect(over.body['names']).toStrictEqual(['limit']);
  });

  it('API-4 quota: map status is charged like every call', async () => {
    const api = app(limits({ requests: { credential: 2 } }));
    clock += WINDOW + 1;
    const map = (await w.create(ann, { title: 'quota status map' }, { taskType: 'map' })).id;
    const status = async () => await call(api, ann, '/map/status', { recordId: map });
    expect((await status()).status).toBe(200);
    expect((await status()).status).toBe(200);
    expectQuotaRefusal(await status(), 'requests', 'credential');
  });

  it('API-4 quota: work this ticket is charged like every call', async () => {
    const api = app(limits({ requests: { credential: 2 } }));
    clock += WINDOW + 1;
    const ticket = (await w.create(ann, { title: 'quota context ticket' })).id;
    const bundle = async () => await call(api, ann, '/task/context', { recordId: ticket });
    expect((await bundle()).status).toBe(200);
    expect((await bundle()).status).toBe(200);
    expectQuotaRefusal(await bundle(), 'requests', 'credential');
  });
});
