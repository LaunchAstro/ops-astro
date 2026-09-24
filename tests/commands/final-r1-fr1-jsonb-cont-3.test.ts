// SPDX-License-Identifier: AGPL-3.0-only
//
// FR1-JSONB continuation 3: the agent prefix answers a refusal in the bytes
// its replay will answer.
//
// `registerAttempt` stores a refusal in the form `storable` gives, and a
// replay answers from that row (`agent-replay.ts`). `settle` answered the raw
// refusal, so a name holding NUL or an unpaired surrogate came back raw the
// first time and escaped on the replay. It now answers the stored form, as
// the person prefix does (`envelope.ts`, `settle`).
//
// No agent operation echoes a caller's key in a refusal name today (every
// agent refusal names a fixed operand), so this is proved at `settle`, the
// one place every agent refusal passes, against the row a replay reads.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, installSpine, type Member } from './fixture.ts';
import { settle } from '../../packages/core-records/src/commands/agent-settle.ts';
import { refuseCommand } from '../../packages/core-records/src/commands/refusal.ts';
import { lookupAttempt } from '../../packages/core-records/src/commands/register-store.ts';
import type { AgentSession } from '../../packages/core-records/src/identity/agent-login.ts';

const serverUrl = databaseUrlFromEnvironment();

const NUL = String.fromCodePoint(0);
const LONE = String.fromCodePoint(0xd800);

/**
 * A refusal as the boundary writes it (`apps/api/app.ts`, `refuse`): the
 * members in a fixed order, so jsonb's own key order cannot differ.
 */
const wire = (refusal: unknown): string => {
  const { code, names, fixes } = refusal as Record<string, unknown>;
  return JSON.stringify({ refused: true, code, names, fixes });
};

describe.skipIf(serverUrl === undefined)('FR1-JSONB: agent settle answers the stored form', () => {
  let db: FreshDatabase;
  let business: string;
  let caller: Member;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'fr1_jsonb_cont3' });
    business = await insertBusiness(db.app, 'jsonbcont3');
    await installSpine(db.app, business);
    caller = await enrol(db.app, business, 'caller');
  }, 60_000);

  afterAll(async () => await db?.drop());

  /** The first answer, and the stored row a replay answers from, on the wire. */
  const answerAndReplay = async (names: readonly string[]) =>
    await db.app.withBusiness(business, async (tx) => {
      const session: AgentSession = {
        businessId: business,
        loginId: randomUUID(),
        actorId: caller.actorId,
        kind: 'agent',
      };
      const operationId = `op-agent-${randomUUID()}`;
      const first = await settle(
        tx,
        session,
        { command: 'task.queue', operationId },
        '0'.repeat(64),
        refuseCommand('FIELD_UNKNOWN', names, ['A fix line.']),
      );
      const stored = await lookupAttempt(tx, caller.actorId, operationId);
      return { first: wire(first), replay: wire(stored?.result) };
    });

  it('a name holding NUL and an unpaired surrogate: first answer and replay are byte-identical', async () => {
    const { first, replay } = await answerAndReplay([`x${NUL}`, `y${LONE}`]);
    expect(first).toBe(replay);
    expect(JSON.parse(first)).toMatchObject({ names: ['x\\u0000', 'y\\ud800'] });
  });

  it('control: an ordinary name is answered and replayed unchanged', async () => {
    const { first, replay } = await answerAndReplay(['estimate']);
    expect(first).toBe(replay);
    expect(JSON.parse(first)).toMatchObject({ names: ['estimate'] });
  });
});
