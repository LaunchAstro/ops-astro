// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's lines are joined again with the login's current token on a
// schedule, the old line left once the new one is taken: one line stays
// joined per topic, each renewal presents the token as it is then, and no
// offer rung across renewals is lost.

import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { agentTopic } from '../../packages/core-custody/src/agent.ts';
import { renewing } from '../../apps/model-agent/renewing.ts';
import { memoryCarriage } from '../support/memory-carriage.ts';

const topic = agentTopic(randomUUID(), randomUUID());

it('each renewal joins with the token as it is then and leaves the old line', async () => {
  const carriage = memoryCarriage();
  const tokens: string[] = [];
  carriage.admit = (_topic, token) => {
    tokens.push(token);
    return true;
  };
  let issued = 0;
  const token = async () => await Promise.resolve(`token-${String((issued += 1))}`);
  const joined = await renewing(carriage, token, 40).join(topic, 'token-0');
  if (!joined.ok) throw new Error('not joined');
  await sleep(150);
  expect(tokens.length).toBeGreaterThan(2);
  expect(tokens.slice(0, 3)).toStrictEqual(['token-0', 'token-1', 'token-2']);
  expect(carriage.joined().filter((name) => name === topic)).toHaveLength(1);
  await joined.line.leave();
  await sleep(100);
  expect(carriage.joined()).toStrictEqual([]);
});

it('no ring across renewals is lost', async () => {
  const carriage = memoryCarriage();
  const joined = await renewing(carriage, async () => await Promise.resolve('fresh'), 15).join(
    topic,
    'first',
  );
  const bell = await carriage.join(topic, 'database');
  if (!joined.ok || !bell.ok) throw new Error('not joined');
  const heard: unknown[] = [];
  joined.line.hear((_event, message) => heard.push(message));
  for (let ring = 0; ring < 20; ring += 1) {
    // oxlint-disable-next-line no-await-in-loop -- rings spread across renewals
    await bell.line.send('offer', { ring });
    // oxlint-disable-next-line no-await-in-loop -- rings spread across renewals
    await sleep(5);
  }
  await sleep(50);
  const rings = new Set(heard.map((message) => (message as { ring: number }).ring));
  expect([...rings].toSorted((a, b) => a - b)).toStrictEqual(
    Array.from({ length: 20 }, (_none, ring) => ring),
  );
  await joined.line.leave();
  await bell.line.leave();
});
