// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-8 isolation, the third crossing: another person under a live
// delegation. An agent's pool is its one task and the board is not an
// operation its delegation carries, so it is refused the board, and the
// refusal carries no rank, stage or canary from another task.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { agentWorld, codeOf, type AgentWorld } from '../commands/agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'mp-5-8-board-agent: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const CANARY = `canary-${randomUUID()}`;

describe.skipIf(serverUrl === undefined)(
  'MP-5-8 isolation: an agent under a live delegation',
  () => {
    let world: AgentWorld;

    beforeAll(async () => {
      world = await agentWorld('b8', `mp58-agent-${randomUUID().slice(0, 8)}`);
    }, 180_000);

    afterAll(async () => {
      await world?.drop();
    });

    it('is refused the board and shown no rank, stage or canary', async () => {
      const decider = await world.decider('decider');
      const other = await world.asPerson(decider, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: CANARY },
      });
      const otherId = isCommandRefusal(other) ? '' : (other.recordId ?? '');
      const picked = await world.pickUp(decider, 'the agent’s task');
      const answer = await world.asAgent(
        { command: 'task.board', operationId: randomUUID(), board: null },
        picked.credential,
      );
      expect(codeOf(answer)).toBe('DELEGATION_EXCLUDES_OPERATION');
      const text = JSON.stringify(answer);
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain(otherId);
      expect(text).not.toMatch(/"rank"|"stage"/u);
    });
  },
);
