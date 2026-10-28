// SPDX-License-Identifier: AGPL-3.0-only
//
// #2270: Hermes Agent is the owner's own agent, so the side chat offers it
// only to a person `OPS_HERMES_PEOPLE` lists for this business, read in any
// spelling an operator might type, and never in a conversation on a client's
// task: no client's privacy setting names it. The offer is the one rule
// `conversation.models`, `conversation.set_model` and the exchange all ask.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  conversationOperationOf,
  CONVERSATION_MODELS,
  HERMES_CONVERSATION_KEY,
  HERMES_MODEL,
  HERMES_PROVIDER,
  hermesPeopleOf,
  OLLAMA_PROVIDER,
} from '../../packages/core-connectors/src/index.ts';
import {
  hermesListed,
  offeredModels,
  type ModelFacts,
} from '../../packages/core-commands/src/commands/conversation-model.ts';
import type { Session, TenantQuery } from '../../packages/core-records/src/index.ts';

const business = randomUUID();
const owner = randomUUID();
const colleague = randomUUID();

/** A transaction that answers no query: the offer asks none for a model no client setting names. */
const tx = (businessId: string): TenantQuery =>
  ({
    businessId,
    query: async () => await Promise.reject(new Error('asked the database')),
  }) as unknown as TenantQuery;

const session = (personId: string): Session => ({ personId }) as unknown as Session;

const ids = (models: readonly { readonly id: string }[]): readonly string[] =>
  models.map((model) => model.id);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Hermes Agent in the catalogue', () => {
  it('is one unpriced local model on its own operation, named for the picker', () => {
    const hermes = CONVERSATION_MODELS.filter((model) => model.provider === HERMES_PROVIDER);
    expect(hermes).toStrictEqual([
      {
        id: HERMES_MODEL,
        provider: HERMES_PROVIDER,
        reach: 'local',
        egressName: null,
        ceilingMinor: 0,
        label: 'Hermes Agent',
      },
    ]);
    expect(conversationOperationOf(HERMES_PROVIDER)).toBe(HERMES_CONVERSATION_KEY);
  });
});

describe('who is offered Hermes Agent', () => {
  it('only a person the setting lists for this business, in any spelling', () => {
    vi.stubEnv('OPS_HERMES_PEOPLE', ` ${business}:${owner}`.toUpperCase() + ' ');
    expect(hermesPeopleOf(process.env)).toStrictEqual([`${business}:${owner}`]);
    expect(hermesListed(tx(business), session(owner))).toBe(true);
    expect(hermesListed(tx(business), session(colleague))).toBe(false);
    expect(hermesListed(tx(randomUUID()), session(owner))).toBe(false);
  });

  it('nobody with the setting unset', () => {
    vi.stubEnv('OPS_HERMES_PEOPLE', '');
    expect(hermesPeopleOf(process.env)).toStrictEqual([]);
    expect(hermesListed(tx(business), session(owner))).toBe(false);
  });

  it('the offer holds Hermes Agent for a listed person, and not for anyone else', async () => {
    const listed = await offeredModels(tx(business), OLLAMA_PROVIDER, null, false, false, true);
    expect(ids(listed)).toContain(HERMES_MODEL);
    const unlisted = await offeredModels(tx(business), OLLAMA_PROVIDER, null, false, false, false);
    expect(ids(unlisted)).not.toContain(HERMES_MODEL);
    expect(ids(unlisted).length).toBeGreaterThan(0);
  });

  it('never in a conversation on a client’s task, even for a listed person', async () => {
    const onClient: ModelFacts = { model: null, clientId: randomUUID(), unseen: false };
    const offered = await offeredModels(
      tx(business),
      OLLAMA_PROVIDER,
      onClient,
      false,
      false,
      true,
    );
    expect(ids(offered)).not.toContain(HERMES_MODEL);
  });

  it('on an internal task it is offered as on no task', async () => {
    const internal: ModelFacts = { model: null, clientId: null, unseen: false };
    const offered = await offeredModels(
      tx(business),
      OLLAMA_PROVIDER,
      internal,
      false,
      false,
      true,
    );
    expect(ids(offered)).toContain(HERMES_MODEL);
  });
});
