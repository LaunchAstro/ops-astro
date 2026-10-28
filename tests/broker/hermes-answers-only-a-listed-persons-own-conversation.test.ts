// SPDX-License-Identifier: AGPL-3.0-only
//
// #2270: Hermes Agent acts on the M5 with its own tools, for the owner's own
// chats only. So custody itself holds its operation to a person
// `OPS_HERMES_PEOPLE` lists, in their own undelegated session, whatever the
// command layer offered:
//
//   - a run's `model.call` naming Hermes Agent's operation is refused as its
//     step, on a task with no client, and the provider is asked nothing, so no
//     task text reaches it;
//   - in a conversation, a person the list does not name is refused before
//     any row or send, and a listed one is answered.
//
// The stand-in provider answers for Hermes Agent's destination, so a missing
// refusal shows as a send.

import { describe, expect, it } from 'vitest';
import {
  catalogue,
  HERMES_BODY_LIMIT,
  HERMES_CONVERSATION,
  HERMES_PROVIDER,
  hermesRequest,
  REPLAY_COMPOSE,
  replayAdapter,
  type ModelOperationDeclaration,
} from '../../packages/core-connectors/src/index.ts';
import {
  callModelInConversation,
  type Broker,
  type BrokerRoute,
} from '../../packages/core-custody/src/index.ts';
import {
  HERMES_PROVIDER_KEY,
  hermesStanding,
} from '../../packages/core-custody/src/hermes-standing.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import { call, LOCAL, noDatabase, rowsOf, s, useBrokerWorld, world } from './broker-world.ts';
import { ask, local, ownerOf } from './aw-04-planning-world.ts';

useBrokerWorld('hermesonly');

/** Hermes Agent's operation, sent to the stand-in's destination and read as its answer, so a missing refusal is seen. */
const HERMES: ModelOperationDeclaration = {
  ...HERMES_CONVERSATION,
  destination: REPLAY_COMPOSE.destination,
  answer: REPLAY_COMPOSE.answer,
};
const ROUTE: BrokerRoute = { ...LOCAL, key: 'm5_hermes', provider: HERMES_PROVIDER };

/** `base` with Hermes Agent catalogued on its local route, its list naming `people`. */
const withHermes = (base: Broker, people: readonly string[]): Broker => ({
  ...base,
  operations: catalogue([HERMES]),
  providers: new Map([[HERMES_PROVIDER, { build: replayAdapter, price: () => 0 }]]),
  routes: [ROUTE],
  hermesPeople: people,
});

describe('Hermes Agent’s standing', () => {
  const business = '7d6f6c1e-8a51-4c43-9a3f-0b8f3c2d9e10';
  const owner = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
  const broker = { hermesPeople: [`${business}:${owner}`.toUpperCase()] };

  it('names the connector’s provider', () => {
    expect(HERMES_PROVIDER_KEY).toBe(HERMES_PROVIDER);
  });

  it('is a listed person in their own session, with no delegation, in this business', () => {
    const attended = { delegationId: null, attendedByPersonId: owner };
    expect(hermesStanding(broker, business, attended)).toBe(true);
    expect(hermesStanding(broker, owner, attended)).toBe(false);
    expect(hermesStanding(broker, business, { ...attended, delegationId: owner })).toBe(false);
    expect(hermesStanding(broker, business, { ...attended, attendedByPersonId: null })).toBe(false);
    expect(hermesStanding({}, business, attended)).toBe(false);
  });
});

describe.skipIf(noDatabase)('Hermes Agent’s operation in the broker', () => {
  it('a run’s model.call naming it is refused as its step, and the provider is asked nothing', async () => {
    const work = await liveWork(s, 'hermes a run names it', 2_000);
    const seen = world.provider.seen.length;
    const listed = withHermes(local(s), [`${s.business}:${String(ownerOf(s).attendedByPersonId)}`]);
    const answer = await call(
      work,
      {
        operation: HERMES.key,
        fields: [{ name: 'message', from: { recordId: work.taskId, key: 'title' } }],
      },
      listed,
    );
    expect(answer).toMatchObject({ ok: false, code: 'OPERATION_NOT_CATALOGUED' });
    expect(await rowsOf(answer.ok ? null : (answer.callId ?? null))).toMatchObject([
      { state: 'refused', refusal_code: 'OPERATION_NOT_CATALOGUED', route_key: null },
    ]);
    expect(world.provider.seen.length).toBe(seen);
  }, 120_000);

  it('a person its list does not name is refused before any row or send; a listed one is answered', async () => {
    const owner = ownerOf(s);
    const seen = world.provider.seen.length;
    const unlisted = await callModelInConversation(
      s.db.app,
      s.business,
      owner,
      { ...(await ask(s)), operation: HERMES.key },
      withHermes(local(s), []),
    );
    expect(unlisted).toMatchObject({ ok: false, code: 'AUTHORITY_LOST', callId: null });
    expect(world.provider.seen.length).toBe(seen);

    const listed = await callModelInConversation(
      s.db.app,
      s.business,
      owner,
      { ...(await ask(s)), operation: HERMES.key },
      withHermes(local(s), [`${s.business}:${String(owner.attendedByPersonId)}`]),
    );
    expect(listed).toMatchObject({ ok: true, reservedMinor: 0 });
    expect(world.provider.seen.length).toBe(seen + 1);
  }, 120_000);
});

describe.skipIf(noDatabase)('Hermes Agent’s operation in the broker, sized', () => {
  it('a listed person’s message too large for Hermes Agent is refused here, before any row or send', async () => {
    const owner = ownerOf(s);
    const seen = world.provider.seen.length;
    // Under the panel's 20,000 characters, over 48 KiB once encoded: three bytes a character.
    const message = 'あ'.repeat(17_000);
    expect(Buffer.byteLength(hermesRequest({ message }).body)).toBeGreaterThan(HERMES_BODY_LIMIT);
    const listed = withHermes(local(s), [`${s.business}:${String(owner.attendedByPersonId)}`]);
    const sized: Broker = {
      ...listed,
      providers: new Map([
        [HERMES_PROVIDER, { build: hermesRequest, price: () => 0, bodyLimit: HERMES_BODY_LIMIT }],
      ]),
    };
    const asked = await ask(s);
    const answer = await callModelInConversation(
      s.db.app,
      s.business,
      owner,
      {
        ...asked,
        operation: HERMES.key,
        fields: [{ name: 'message', source: 'outside', value: message }],
      },
      sized,
    );
    expect(answer).toMatchObject({ ok: false, code: 'PROMPT_TOO_LARGE', callId: null });
    expect(world.provider.seen.length).toBe(seen);
  }, 120_000);
});
