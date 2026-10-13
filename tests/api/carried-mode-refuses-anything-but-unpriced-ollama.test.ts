// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried deployment carries an unpriced Ollama chat and nothing else. Its
// start-up refuses any other provider, a provider credential or destination,
// and a carrier without an Ollama local route (the composition tests). Here
// the seam's own refusal holds through the carried path: a priced operation
// writes no call, opens no line, rings no doorbell, and the agent and Ollama
// hear nothing. The unpriced chat on the same world is answered.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { ask, callFor, repliesTo, stored } from './carried-schedules.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('carried mode and a priced operation', () => {
  let world: CarriedWorld | undefined;

  afterEach(async () => {
    await world?.close();
    world = undefined;
    vi.unstubAllEnvs();
  });

  it.each([
    ['priced', 25, false],
    ['unpriced', undefined, true],
  ] as const)(
    'a %s conversation operation: offered and answered only when unpriced',
    async (name, maximumMinor, answered) => {
      vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
      world = await carriedWorld(
        `carried_${name}`,
        undefined,
        maximumMinor === undefined ? {} : { maximumMinor },
      );
      world.ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, ['Due.']) });
      const body = `What is due? (${name})`;
      const events = await (await ask(world, body)).rest();
      expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({ reply: { answered } });
      const asked = answered ? 1 : 0;
      expect(world.joined).toHaveLength(asked);
      expect(await stored(world)).toHaveLength(asked);
      expect(world.agent.sent).toHaveLength(asked);
      expect(world.ollama.seen).toHaveLength(asked);
      expect(await repliesTo(world, body)).toBe(asked);
      expect(await callFor(world, body)).toEqual(
        answered ? [{ state: 'settled', offered: true, requested: true, actual: 0 }] : [],
      );
    },
    180_000,
  );
});
