// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11 hostile provider, on AW-03's exchange: an answer that is oversized,
// redirected, malformed, slow or longer than a message may be comes back as a
// failed reply in fixed words, and nothing is kept. The model is custody's
// real process and the replay provider on loopback in each hostile mode; the
// stored rows, read as admin, are the oracle. A planted instruction is text
// like any other answer: aw-03-exchange's canary keeps it out of every log and
// record, and the drawer draws it inert (mp-7-11-assistant-view).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelAnswer } from '../../packages/core-connectors/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, started, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { personPath } from './controls-fixture.ts';
import {
  authorised,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const replyOf = (answer: Answer): unknown => (answer.body as Record<string, unknown>)['reply'];

// eslint-disable-next-line max-lines-per-function -- one world, each hostile answer on it
describe.skipIf(serverUrl === undefined)('MP-7-11 hostile provider', () => {
  let fixture: ApiFixture;
  let w: ConversationWorld;
  let model: LocalModel;

  const agentRows = async (conversationId: string): Promise<number> =>
    await w.count(
      `select count(*) as n from public.conversation_messages
        where conversation_id = $1 and role = 'agent'`,
      [conversationId],
    );

  beforeAll(async () => {
    fixture = await createApiFixture('mp_7_11_hostile');
    model = await localModel();
    w = await conversationWorld({ fixture, api: composedWith(fixture, model.exchange) });
  }, 120_000);

  afterAll(async () => {
    await model?.close();
    await fixture?.drop();
  });

  it('MP-7-11 hostile provider: an oversized, redirected, malformed or slow answer is a failed reply, and nothing is kept', async () => {
    const conversationId = await started(w, w.owner, { body: 'hostile?' });
    for (const mode of ['oversized', 'redirect', 'malformed', 'slow'] as const) {
      model.provider.mode(mode);
      try {
        // eslint-disable-next-line no-await-in-loop -- one mode at a time on one provider
        const answer = await w.as(w.owner, 'conversation.message', {
          conversationId,
          body: `and in ${mode}?`,
        });
        expect(answer.status).toBe(200);
        expect(replyOf(answer)).toEqual({
          answered: false,
          code: expect.any(String) as string,
          words: expect.stringMatching(/could not be used/iu) as string,
        });
        expect(JSON.stringify(answer.body)).not.toContain('203.0.113.9');
      } finally {
        model.provider.mode('answer');
      }
    }
    expect(await agentRows(conversationId)).toBe(1);
  }, 60_000);

  it('MP-7-11 hostile provider: an answer longer than a message may be is a failed reply, and nothing is kept', async () => {
    const long = await localModel((body: unknown): ModelAnswer | undefined =>
      typeof body === 'object' && body !== null
        ? {
            text: 'x'.repeat(20_001),
            model: 'replay-1',
            usage: { inputUnits: 1, outputUnits: 1 },
            providerCode: null,
          }
        : undefined,
    );
    try {
      const api = composedWith(fixture, long.exchange);
      const answer = await post(
        api,
        personPath('conversation.start'),
        { operationId: randomUUID(), body: 'a long answer?' },
        authorised(await tokenFor(w.owner.presented.subject)),
      );
      expect(replyOf(answer)).toMatchObject({ answered: false });
      expect(await agentRows(String(detail(answer)['conversationId']))).toBe(0);
    } finally {
      await long.close();
    }
  });
});
