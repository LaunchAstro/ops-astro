// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #418: Sol's OW-009 criterion 2 proof, unchanged
// (R/sol/proofs/OW-009-4126931d1.patch), and the rest of the agent view
// API.md gives a credential (security review on 4add9c9).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { bearer, serverUrl } from '../acceptance/world.ts';
import { harness, openWorld } from './api-2-agent-credential-world.ts';
import { asCredential, issued } from './api-2-agent-credential-use-world.ts';

openWorld();

it.skipIf(serverUrl === undefined)(
  'Sol proof, criterion 2: person to agent credential separation keeps the issuer time private',
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
