// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #418: Sol's OW-009 criterion 2 proof (title named by behaviour, body unchanged)
// (R/sol/proofs/OW-009-4126931d1.patch), and the rest of the agent view
// API.md gives a credential (security review on 4add9c9).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { bearer, serverUrl } from '../acceptance/world.ts';
import { harness, openWorld } from './api-2-agent-credential-world.ts';
import { asCredential, issued } from './api-2-agent-credential-use-world.ts';

openWorld();

it.skipIf(serverUrl === undefined)(
  'person to agent credential separation keeps the issuer time private',
  async () => {
    const task = await harness.freshTask('Sol private time boundary');
    const canary = 'SOL-OW009-ISSUER-PRIVATE-TIME';
    const logged = await harness.asPerson('time.log', {
      taskId: task.id,
      duration: '37',
      note: canary,
    });
    expect(logged.code).toBe('ok');
    const owner = await harness.asPerson('task.read', { recordId: task.id });
    expect(owner.code).toBe('ok');
    expect(owner.text).toContain(canary);
    const credential = await issued({ scope: [{ collection: 'task', action: 'read' }] });
    const agent = await asCredential('task.read', { recordId: task.id }, bearer(credential.secret));
    expect(agent.code).toBe('ok');
    expect(agent.text, 'a task:read credential must receive time: null').not.toContain(canary);
    expect(JSON.parse(agent.text)).toMatchObject({ task: { time: null } });
  },
);

it.skipIf(serverUrl === undefined)(
  'a task:read credential reads the agent view: no internal note, no ledger, no client facts',
  async () => {
    const task = await harness.freshTask('credential agent view');
    const note = 'CAT-418-INTERNAL-NOTE';
    const commented = await harness.asPerson('task.comment', {
      operationId: randomUUID(),
      recordId: task.id,
      expectedRevision: task.revision,
      body: note,
      audience: 'internal',
    });
    expect(commented.code).toBe('ok');
    const owner = await harness.asPerson('task.read', { recordId: task.id });
    expect(owner.text).toContain(note);
    const credential = await issued({ scope: [{ collection: 'task', action: 'read' }] });
    const agent = await asCredential('task.read', { recordId: task.id }, bearer(credential.secret));
    expect(agent.code).toBe('ok');
    expect(agent.text, 'an internal note is absent from an agent answer').not.toContain(note);
    const read = JSON.parse(agent.text) as { task: Record<string, unknown> };
    expect(read.task['ledger']).toBeNull();
    expect(read.task).not.toHaveProperty('client');
    expect(read.task).not.toHaveProperty('hasContent');
  },
);

it.skipIf(serverUrl === undefined)(
  'a task:read credential reads the agent view at every detail level (API-3)',
  async () => {
    const task = await harness.freshTask('credential agent view by level');
    const note = 'API-3-LEVELED-INTERNAL-NOTE';
    const commented = await harness.asPerson('task.comment', {
      operationId: randomUUID(),
      recordId: task.id,
      expectedRevision: task.revision,
      body: note,
      audience: 'internal',
    });
    expect(commented.code).toBe('ok');
    const owner = await harness.asPerson('task.read', { recordId: task.id, detail: 'full' });
    expect(owner.code).toBe('ok');
    const ownerView = (JSON.parse(owner.text) as { view: Record<string, unknown> }).view;
    expect(ownerView, 'a member reads the Client field facts at full').toHaveProperty('hasContent');
    const credential = await issued({ scope: [{ collection: 'task', action: 'read' }] });
    const levels = ['standard', 'full'] as const;
    const answers = await Promise.all(
      levels.map(
        async (detail) =>
          await asCredential('task.read', { recordId: task.id, detail }, bearer(credential.secret)),
      ),
    );
    for (const [at, agent] of answers.entries()) {
      const detail = levels[at];
      expect(agent.code, detail).toBe('ok');
      expect(agent.text, `an internal note is absent at ${detail}`).not.toContain(note);
      const { view } = JSON.parse(agent.text) as { view: Record<string, unknown> };
      expect(view, detail).not.toHaveProperty('client');
      expect(view, detail).not.toHaveProperty('hasContent');
    }
  },
);

/** A fresh task with all three marks at `mark`. */
const scored = async (title: string, mark: number) => {
  const task = await harness.freshTask(title);
  const set = await harness.asPerson('task.set_scores', {
    operationId: randomUUID(),
    recordId: task.id,
    expectedRevision: task.revision,
    fields: { impact: mark, confidence: mark, ease: mark },
  });
  expect(set.code).toBe('ok');
  return task.id;
};

/** The `#N` a task.read answer gives its task. */
const rankOf = (text: string) =>
  (JSON.parse(text) as { task: { rank: { number: number | null } } }).task.rank.number;

it.skipIf(serverUrl === undefined)(
  'a task:read credential ranks the task it reads alone, not among every task its person reaches',
  async () => {
    await scored('credential rank pool, the higher task', 10);
    const lower = await scored('credential rank pool, the lower task', 1);
    const owner = await harness.asPerson('task.read', { recordId: lower });
    expect(owner.code).toBe('ok');
    expect(rankOf(owner.text), 'the person ranks it among every task they reach').toBeGreaterThan(
      1,
    );
    const credential = await issued({ scope: [{ collection: 'task', action: 'read' }] });
    const agent = await asCredential('task.read', { recordId: lower }, bearer(credential.secret));
    expect(agent.code).toBe('ok');
    expect(rankOf(agent.text), 'the credential ranks the one task it reads').toBe(1);
  },
);
