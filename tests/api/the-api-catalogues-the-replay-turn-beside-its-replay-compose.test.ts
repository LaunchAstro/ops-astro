// SPDX-License-Identifier: AGPL-3.0-only
//
// #1624 R8b (#1717, director ruling register 162): the API serves the agent's
// turn as the local replay stand-in, beside the replay compose it already
// serves: in the 'api' and 'local-gpt' catalogues, over the replay provider,
// its one field business-internal. The Ollama install serves no replay at all,
// and no real provider's turn is catalogued here.

import { describe, expect, it } from 'vitest';
import { catalogueOf } from '../../apps/api/broker-catalogue.ts';
import { REPLAY_COMPOSE, REPLAY_TURN } from '../../packages/core-connectors/src/index.ts';

describe("the API's turn operation", () => {
  it.each(['api', 'local-gpt'] as const)(
    'is the replay turn in the %s catalogue, over the replay provider',
    (provider) => {
      const { operations, providers } = catalogueOf(provider, false);
      expect(operations.get(REPLAY_TURN.key)).toMatchObject({
        provider: REPLAY_COMPOSE.provider,
        fields: { turn: 'business_internal' },
        turn: true,
      });
      expect(providers.has(String(REPLAY_COMPOSE.provider))).toBe(true);
    },
  );

  it('is in no other catalogue, and no turn but the replay is served', () => {
    expect(catalogueOf('ollama', false).operations.has(REPLAY_TURN.key)).toBe(false);
    for (const provider of ['api', 'local-gpt', 'ollama'] as const) {
      const turns = [...catalogueOf(provider, true).operations.values()].filter(
        (operation) => (operation as { turn?: boolean }).turn === true,
      );
      expect(turns.map((operation) => operation.key)).toEqual(
        provider === 'ollama' ? [] : [REPLAY_TURN.key],
      );
    }
  });
});
