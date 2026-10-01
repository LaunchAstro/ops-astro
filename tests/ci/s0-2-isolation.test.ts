// SPDX-License-Identifier: AGPL-3.0-only
// S0-2 isolation: the alerts count each business, client and person apart,
// and an alert names none of them.
//
// Two businesses (alpha, beta), two clients (c1 in alpha, c2 in beta), one
// grant each. The API is built with the product's own door (`createApi`) over
// executors that answer as a real envelope would, and a database that throws
// on any use: the alerts path holds no connection, so it cannot read, list,
// count, export or change a row. What it counts is signals, each under the
// scope it came from; one business's refusals never bring another's alert
// closer, and one person's failed sign-ins never bring another's.
import { describe, expect, it } from 'vitest';
import {
  createApi,
  type AgentExecutor,
  type CommandExecutor,
  type ReadExecutor,
} from '../../apps/api/app.ts';
import type { Verifier } from '../../apps/api/auth/supabase.ts';
import { createAlerts, type SinkEvent } from '../../apps/api/alerts/sink.ts';
import { refuseCommand } from '../../packages/core-commands/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { DELEGATION_HEADER, PREFIX, pathOf } from '../../packages/core-wire/src/index.ts';
import { times } from './s0-2-plain.ts';

const ALPHA = '11111111-1111-4111-8111-111111111111';
const BETA = '33333333-3333-4333-8333-333333333333';
const NAMES = ['alpha', 'beta', ALPHA, BETA, 'mia', 'noah', 'c1', 'c2'];

// The subject a provider verified, from a test header; none is a failed bearer.
const verify: Verifier = (request) => {
  const subject = request.header('x-subject');
  return Promise.resolve(subject === undefined ? undefined : { provider: 'test', subject });
};

// eslint-disable-next-line max-lines-per-function -- one world, built in one place
function world() {
  let databaseUses = 0;
  const database = new Proxy({} as Database, {
    get: () => {
      databaseUses += 1;
      throw new Error('the alerts path must not reach the database');
    },
  });
  const events: SinkEvent[] = [];
  const alerts = createAlerts({
    send: (e) => Promise.resolve(void events.push(e)),
    where: 'staging',
    root: '/',
  });
  // The envelope's answer, named by the body: a refusal code, or done.
  const executeCommand = ((_db, _business, _presented, _source, request) => {
    const answer = (request as { answer?: string }).answer;
    if (answer === 'SCOPE_NOT_GRANTED' || answer === 'AUTH_UNKNOWN_LOGIN') {
      return Promise.resolve(refuseCommand(answer, [], ['fix']));
    }
    return Promise.resolve({ code: 'ok' });
  }) as CommandExecutor;
  const api = createApi({
    database,
    verify,
    resolveBusiness: (key) =>
      Promise.resolve(({ alpha: ALPHA, beta: BETA } as Record<string, string>)[key]),
    // A read that hands out as many tasks as the body asks for.
    executeRead: ((_db: unknown, _business: unknown, _presented: unknown, request: unknown) => {
      const size = Number((request as { size?: number }).size ?? 0);
      return Promise.resolve({ ok: true, tasks: Array.from({ length: size }, () => ({})) });
    }) as unknown as ReadExecutor,
    executeCommand,
    // The agent's envelope refuses the same way; the delegation names the person it acts for.
    executeAgentCommand: ((_db, _business, _presented, _delegation, request) =>
      executeCommand(_db, _business, _presented, 'api', request as never)) as AgentExecutor,
    observe: alerts.observe,
  });
  async function call(
    business: string,
    person: string | undefined,
    command: string,
    answer = 'done',
  ) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (person !== undefined) headers['x-subject'] = person;
    const response = await api.fetch(
      new Request(`http://api.test${PREFIX.person}${business}${pathOf(command as never)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ answer }),
      }),
    );
    return response.status;
  }
  /** A read by `who`, handed `size` records. */
  async function read(business: string, who: string, size: number) {
    const response = await api.fetch(
      new Request(`http://api.test${PREFIX.person}${business}${pathOf('task.board')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-subject': who },
        body: JSON.stringify({ size }),
      }),
    );
    return response.status;
  }
  /** An agent acting for `person` under a live delegation. */
  async function asDelegate(business: string, agent: string, person: string, answer: string) {
    const response = await api.fetch(
      new Request(`http://api.test${PREFIX.agent}${business}${pathOf('task.update')}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The agent prefix reads its caller from the bearer alone (API-2); this is
          // no agent credential, so the verifier above answers from x-subject.
          authorization: 'Bearer agent-delegation-token',
          'x-subject': agent,
          [DELEGATION_HEADER]: `delegation-for-${person}`,
        },
        body: JSON.stringify({ answer, operationId: 'op' }),
      }),
    );
    return response.status;
  }
  return {
    call,
    read,
    asDelegate,
    events,
    alerts,
    databaseUses: () => databaseUses,
    raised: async () => {
      await alerts.settled();
      return events.map((e) => e.tags['alert']);
    },
  };
}

describe('S0-2 isolation', () => {
  isolationCases1();
  isolationCases2();
});

function isolationCases1() {
  it('business to business: one business’s cross-scope refusals never bring another’s alert closer', async () => {
    const w = world();
    await times(9, async () => {
      expect(await w.call('alpha', 'mia', 'task.update', 'SCOPE_NOT_GRANTED')).toBe(403);
      expect(await w.call('beta', 'mia', 'task.update', 'SCOPE_NOT_GRANTED')).toBe(403);
    });
    expect(await w.raised()).toEqual([]);
    await w.call('alpha', 'mia', 'task.update', 'SCOPE_NOT_GRANTED');
    expect(await w.raised()).toEqual(['cross-scope-burst']);
  });

  it('person to person: one person’s failed sign-ins never bring another’s alert closer', async () => {
    const w = world();
    await times(4, async () => {
      expect(await w.call('alpha', 'mia', 'task.update', 'AUTH_UNKNOWN_LOGIN')).toBe(401);
      expect(await w.call('alpha', 'noah', 'task.update', 'AUTH_UNKNOWN_LOGIN')).toBe(401);
    });
    expect(await w.raised()).toEqual([]);
    await w.call('alpha', 'mia', 'task.update', 'AUTH_UNKNOWN_LOGIN');
    expect(await w.raised()).toEqual(['sign-in-failures']);
  });

  it('a bearer that fails verification counts per business key, never across keys', async () => {
    const w = world();
    await times(4, async () => {
      expect(await w.call('alpha', undefined, 'task.update')).toBe(401);
      expect(await w.call('beta', undefined, 'task.update')).toBe(401);
    });
    expect(await w.raised()).toEqual([]);
    await w.call('beta', undefined, 'task.update');
    expect(await w.raised()).toEqual(['sign-in-failures']);
  });

  it('client to client: one client’s exports never count towards another’s, in the same business or not', async () => {
    const w = world();
    w.alerts.observe({ kind: 'export', business: ALPHA, who: 'c1', items: 3000 });
    w.alerts.observe({ kind: 'export', business: ALPHA, who: 'c2', items: 3000 });
    w.alerts.observe({ kind: 'export', business: BETA, who: 'c1', items: 3000 });
    expect(await w.raised()).toEqual([]);
    w.alerts.observe({ kind: 'export', business: ALPHA, who: 'c1', items: 2000 });
    expect(await w.raised()).toEqual(['export-volume']);
  });
}

function isolationCases2() {
  it('client to client, through the door: the records each read hands out count per business and reader', async () => {
    const w = world();
    await times(2, async () => {
      expect(await w.read('alpha', 'c1', 2400)).toBe(200);
      expect(await w.read('alpha', 'c2', 2400)).toBe(200);
      expect(await w.read('beta', 'c1', 2400)).toBe(200);
    });
    expect(await w.raised()).toEqual([]);
    expect(await w.read('alpha', 'c1', 200)).toBe(200);
    expect(await w.raised()).toEqual(['export-volume']);
  });

  it('person to delegate: an agent under a live delegation is counted apart from the person it acts for', async () => {
    const w = world();
    await times(9, async () => {
      expect(await w.call('alpha', 'mia', 'task.update', 'SCOPE_NOT_GRANTED')).toBe(403);
      expect(await w.asDelegate('alpha', 'agent-one', 'mia', 'SCOPE_NOT_GRANTED')).toBe(403);
    });
    expect(await w.raised()).toEqual([]);
    expect(await w.asDelegate('alpha', 'agent-one', 'mia', 'SCOPE_NOT_GRANTED')).toBe(403);
    expect(await w.raised()).toEqual(['cross-scope-burst']);
  });

  it('a grant revoked in one business raises its alert; a refused revoke raises none', async () => {
    const w = world();
    expect(await w.call('alpha', 'mia', 'grant.revoke', 'SCOPE_NOT_GRANTED')).toBe(403);
    expect(await w.raised()).toEqual([]);
    expect(await w.call('alpha', 'mia', 'grant.revoke')).toBe(200);
    expect(await w.raised()).toEqual(['authority-changed']);
  });

  it('no alert names a business, a client or a person, and the database was never reached', async () => {
    const w = world();
    await times(10, async () => await w.call('alpha', 'mia', 'task.update', 'SCOPE_NOT_GRANTED'));
    await times(5, async () => await w.call('beta', 'noah', 'task.update', 'AUTH_UNKNOWN_LOGIN'));
    w.alerts.observe({ kind: 'export', business: ALPHA, who: 'c1', items: 20000 });
    await w.call('beta', 'noah', 'grant.revoke');
    expect(await w.raised()).toHaveLength(4);
    // The random event id and the time are left out: a short name can occur in hex by chance.
    const sent = JSON.stringify(
      w.events.map(({ message, tags, level }) => ({ message, tags, level })),
    );
    for (const name of NAMES) expect(sent.includes(`"${name}"`), 'a scope name').toBe(false);
    for (const name of NAMES.slice(2)) expect(sent.includes(name), 'a scope name').toBe(false);
    expect(w.databaseUses()).toBe(0);
  });
}
