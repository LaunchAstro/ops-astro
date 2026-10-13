// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried deployment's call that custody has already handed to Ollama, with
// no send recorded on its carriers row, is not released by the sweep as unsent
// once it is 60 seconds old: only the carriage's own records prove nothing went.

import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createApiFixture } from './fixture.ts';
import { conversationWorld, detail } from './aw-03-fixture.ts';
import { carriedApi, carriedOllama } from './carried-exchange-fixture.ts';
import { insertAgentActor } from '../identity/fixture.ts';
import { standInOllama } from './ollama-stand-in-fixture.ts';
import { sweepModelCalls } from '../../packages/core-custody/src/index.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a carried broker call already received by Ollama is not swept as unsent',
  // eslint-disable-next-line max-lines-per-function -- one carried call followed to the sweep
  async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    const fixture = await createApiFixture('carried_received_send');
    const agent = await fixture.db.app.withBusiness(fixture.business, (tx) => insertAgentActor(tx));
    const carrier = { agent, people: [fixture.member.personId] };
    const composed = carriedApi(fixture, carrier);
    const world = await conversationWorld({ fixture, api: composed.api });
    const ollama = await standInOllama();
    const broker = await carriedOllama(ollama.origin, carrier);
    ollama.shut();
    let pending: ReturnType<typeof broker.exchange> | undefined;
    try {
      const started = await world.as(world.owner, 'conversation.start', {
        operationId: randomUUID(),
        body: 'Slow answer?',
      });
      const asked = {
        conversationId: String(detail(started)['conversationId']),
        messageId: String(detail(started)['messageId']),
      };
      pending = broker.exchange(fixture.db.app, fixture.business, world.owner.presented, asked);
      await ollama.arrived(1);
      // Only the call's age moves, as the sweep's own tests age a call; the model stays gated.
      await fixture.db.admin.execute(
        `update public.model_calls
          set accepted_at = accepted_at - interval '61 seconds',
              started_at = started_at - interval '61 seconds'
        where conversation_id = $1`,
        [asked.conversationId],
      );
      const result = await fixture.db.app.withBusiness(fixture.business, (tx) =>
        sweepModelCalls(tx),
      );
      const rows = await fixture.db.admin.execute(
        `select state from public.model_calls where conversation_id = $1`,
        [asked.conversationId],
      );
      expect(ollama.seen).toHaveLength(1);
      expect(
        { released: result.released, rows },
        'The sent call is recorded as unsent and released while Ollama is still answering',
      ).toMatchObject({ released: 0, rows: [{ state: 'dispatched' }] });
    } finally {
      ollama.open();
      await pending?.catch(() => null);
      await broker.stop();
      await ollama.close();
      await composed.database.close();
      await world.drop();
      vi.unstubAllEnvs();
    }
  },
  180_000,
);
