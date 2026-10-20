// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- the crossings and the canary over one world */
//
// C57 (#2016): a change request is filed and decided at its review's client. A party grant on
// client B reaches nothing of client A's, a grant in beta nothing of alpha's, and a foreign id
// answers as a fabricated one. A client's words planted in the pin and in the request never
// reach a refusal, the audit rows or the logs.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c57World, type C57World } from './c57-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C57 isolation: DATABASE_URL is unset.');

const PIN_CANARY = 'client-canary-pin-7d41';
const TEXT_CANARY = 'client-canary-request-93be';

let w: C57World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c57World('c57iso');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(serverUrl === undefined)('C57 isolation', () => {
  it('C57 isolation', async () => {
    const { clientPin } = await w.pins();
    const id = String(detailOf(await w.propose(w.ava, clientPin))['changeRequestId']);

    // dee's party B grant reaches nothing of client A's.
    expect(codeOf(await w.propose(w.dee, clientPin))).toBe('SCOPE_NOT_GRANTED');
    expect(codeOf(await w.decide(w.dee, id, 'approve'))).toBe('SCOPE_NOT_GRANTED');
    // eve's business-wide grant in beta reaches nothing of alpha's, by any id.
    expect(codeOf(await w.propose(w.eve, clientPin, {}, w.beta))).toBe('NOT_FOUND');
    expect(codeOf(await w.decide(w.eve, id, 'approve', w.beta))).toBe('NOT_FOUND');
    expect(codeOf(await w.decide(w.eve, randomUUID(), 'approve', w.beta))).toBe('NOT_FOUND');

    const [row] = await w.requests(w.world.business);
    expect(row).toMatchObject({ id, state: 'proposed', party_id: w.partyA });
    expect(await w.requests(w.beta)).toHaveLength(0);
  });

  it('C57 canary', async () => {
    const logged: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
    const { clientPin } = await w.pins(`Please fix ${PIN_CANARY}`);
    const answers = [
      await w.propose(w.ava, clientPin, { text: `Change ${TEXT_CANARY}` }),
      await w.propose(w.ben, clientPin, { text: `Again ${TEXT_CANARY}` }),
      await w.propose(w.cal, clientPin, { text: `Cal ${TEXT_CANARY}` }),
      await w.propose(w.eve, clientPin, { text: `Eve ${TEXT_CANARY}` }, w.beta),
      await w.propose(w.ava, clientPin, { text: `${TEXT_CANARY}${'x'.repeat(2000)}` }),
    ];
    const id = detailOf(answers[0] as never)['changeRequestId'];
    answers.push(
      await w.decide(w.dee, id, 'approve'),
      await w.decide(w.ava, id, 'refuse'),
      await w.decide(w.ava, id, 'approve'),
    );

    // The filing and ava's refusal of it apply; every other answer is a refusal, and none
    // carries the client's words.
    expect(answers.filter((answer) => codeOf(answer) === 'not-a-refusal')).toHaveLength(2);
    const said = JSON.stringify(answers);
    expect(said).not.toContain(PIN_CANARY);
    expect(said).not.toContain(TEXT_CANARY);

    const audit = await w.world.db.admin.execute<{ readonly row: string }>(
      `select row_to_json(a)::text as row from public.audit_events a
        where business_id = any($1::uuid[]) and command like 'review.%_change'`,
      [[w.world.business, w.beta]],
    );
    expect(audit.length).toBeGreaterThanOrEqual(answers.length);
    for (const { row } of audit) {
      expect(row).not.toContain(PIN_CANARY);
      expect(row).not.toContain(TEXT_CANARY);
    }
    const logs = logged.join('\n');
    expect(logs).not.toContain(PIN_CANARY);
    expect(logs).not.toContain(TEXT_CANARY);
  });
});
