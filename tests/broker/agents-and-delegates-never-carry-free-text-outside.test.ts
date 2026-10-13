// SPDX-License-Identifier: AGPL-3.0-only
//
// Only the conversation's owner, in their own session with nobody between,
// sends a paid call. An agent's own call, a delegated session, unattended
// work, and another person are each refused before any row or request; so is
// the owner's session carrying words another actor wrote.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelCaller } from '../../packages/core-custody/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { noCaller, pricedWorld, scopeOf, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)(
  'agents and delegates never carry free text outside',
  // oxlint-disable-next-line max-lines-per-function -- one world, one schedule per caller
  () => {
    let p: PricedWorld;

    beforeAll(async () => {
      p = await pricedWorld('priced_people_only');
    }, 180_000);

    afterAll(async () => {
      await p?.stop();
    });

    const callers = (): readonly (readonly [string, ModelCaller, string])[] => [
      [
        'an agent on its own',
        { actorId: p.w.fixture.agentActorId, delegationId: null, attendedByPersonId: null },
        'AUTHORITY_LOST',
      ],
      ['a delegated session', { ...p.owner, delegationId: randomUUID() }, 'AUTHORITY_LOST'],
      ['unattended work', { ...p.owner, attendedByPersonId: null }, 'AUTHORITY_LOST'],
      [
        'another person',
        {
          actorId: p.w.colleague.actorId,
          delegationId: null,
          attendedByPersonId: p.w.colleague.personId,
        },
        'AUTHORITY_LOST',
      ],
      [
        "the owner's person with another actor's words",
        { ...p.owner, actorId: p.w.fixture.agentActorId },
        'LOCAL_MODEL_REQUIRED',
      ],
    ];

    it('each is refused before any row or request', async () => {
      for (const [name, caller, code] of callers()) {
        // oxlint-disable-next-line no-await-in-loop -- one conversation per caller, in turn
        const asked = await p.question(`Asked as ${name}`);
        const sent = p.openrouter.received.length;
        // oxlint-disable-next-line no-await-in-loop -- one conversation per caller, in turn
        const result = await p.direct(
          {
            ...scopeOf(p, asked),
            paid: { authors: [p.w.owner.actorId], asCaller: noCaller },
          },
          caller,
        );
        expect(result, name).toMatchObject({ ok: false, code });
        // oxlint-disable-next-line no-await-in-loop -- one conversation per caller, in turn
        expect(await p.calls(asked.conversationId), name).toHaveLength(0);
        expect(p.openrouter.received.length, name).toBe(sent);
      }
    });
  },
);
