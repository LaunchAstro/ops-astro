// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-await-in-loop, max-lines-per-function -- calls in order; one isolation case, three crossings in order */
//
// `API-3 isolation`: the verb CLI over the composed API makes the three real
// crossings (another business; another client's map in the same business;
// an agent under a live delegation), each refusal's status checked, and no
// foreign id, title or text in any answer, refusals included.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, idOf, type Caller, type CliWorld } from './api-3-world.ts';
import { must } from '../wayfinder/world.ts';
import { grantTo, type Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('API-3 isolation', () => {
  let w: CliWorld;
  let lead: Member;

  beforeAll(async () => {
    w = await cliWorld('api3iso', 'api3iso');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
  }, 180_000);

  afterAll(async () => await w?.drop());

  const map = async (title: string, client: string) => {
    const made = must(
      await w.as(lead, { command: 'task.create', fields: { title }, taskType: 'map' }),
      title,
    );
    must(
      await w.as(lead, {
        command: 'map.scope',
        recordId: made.id,
        expectedRevision: await w.revisionOf(made.id),
        client,
      }),
      'scope',
    );
    return made.id;
  };

  it('API-3 isolation', async () => {
    const lead0 = await w.person(lead);
    const mapA = await map('canary-map-A', randomUUID());
    const mapB = await map('canary-map-B', randomUUID());
    const ticketB = idOf(
      await lead0.run(
        'task',
        'create',
        '--title',
        'canary-ticket-B',
        '--parent',
        mapB,
        '--type',
        'research',
      ),
    );
    expect(
      (
        await lead0.run(
          'task',
          'comment',
          ticketB,
          '--revision',
          String(await w.revisionOf(ticketB)),
          '--text',
          'canary-thread-B',
        )
      ).exit,
    ).toBe(0);
    const foreign = [mapB, ticketB, 'canary-map-B', 'canary-ticket-B', 'canary-thread-B'];
    const clean = (caller: string, out: string) => {
      for (const canary of foreign) expect(out, `${caller}: ${out}`).not.toContain(canary);
    };
    const refusedAs = async (caller: Caller, code: string, name: string, argv: string[]) => {
      const answer = await caller.run(...argv);
      expect(answer.exit, `${name} ${argv.join(' ')}: ${answer.out}`).toBe(1);
      expect(answer.out).toContain(code);
      clean(name, answer.out);
    };

    // 1. Another business: bravo's person, on bravo's own key, reaches none of alpha's.
    // Bea holds comment too, so each crossing reaches the record and not the key check.
    const beaMember = await w.outsider('bea');
    await w.db.app.withBusiness(w.bravo, async (tx) => await grantTo(tx, beaMember, 'comment'));
    const bea = await w.person(beaMember, `${w.key}-bravo`);
    for (const argv of [
      ['task', 'get', ticketB],
      ['map', 'view', mapB],
      ['task', 'comment', ticketB, '--revision', '1', '--text', 'x'],
      ['task', 'update', ticketB, '--revision', '1', '--title', 'x'],
      ['task', 'link', ticketB, '--blocked-by', mapA, '--revision', '1'],
      ['task', 'resolve', ticketB, '--revision', '1', '--answer', 'x', '--gist', 'x'],
    ]) {
      await refusedAs(bea, 'NOT_FOUND', 'bravo', argv);
    }
    const beaList = await bea.run('task', 'list', '--detail', 'brief', '--json');
    expect(beaList.exit).toBe(0);
    clean('bravo list', beaList.out);

    // 2. Another client in the same business: the map-A holder never reaches map B.
    const onA = await w.person(
      await w.member('on-a', ['read', 'write', 'comment'], { kind: 'record', id: mapA }),
    );
    expect((await onA.run('map', 'view', mapA)).exit).toBe(0);
    for (const argv of [
      ['task', 'get', ticketB],
      ['map', 'view', mapB],
      ['map', 'frontier', mapB],
      ['task', 'comment', ticketB, '--revision', '1', '--text', 'x'],
      ['task', 'update', ticketB, '--revision', '1', '--title', 'x'],
    ]) {
      await refusedAs(onA, 'SCOPE_NOT_GRANTED', 'client A', argv);
    }
    const onAList = await onA.run('task', 'list', '--detail', 'brief', '--json');
    clean('client A list', onAList.out);

    // 3. An agent under a live delegation: its purpose is its own task, never map B.
    const picked = await w.pickUp(await w.decider('delegator'), 'delegated work');
    const agent = await w.agent(picked.credential);
    expect((await agent.run('task', 'get', picked.taskId, '--detail', 'brief')).exit).toBe(0);
    for (const argv of [
      ['task', 'get', ticketB],
      ['task', 'comment', ticketB, '--revision', '1', '--text', 'x'],
      ['map', 'frontier', mapB],
    ]) {
      const answer = await agent.run(...argv);
      expect(answer.exit, `agent ${argv.join(' ')}: ${answer.out}`).toBe(1);
      clean('agent', answer.out);
    }
    const agentList = await agent.run('task', 'list', '--detail', 'brief', '--json');
    clean('agent list', agentList.out);
  });

  it('API-3 isolation: a blocker the reader may not read is withheld, never named', async () => {
    const lead0 = await w.person(lead);
    const hidden = idOf(await lead0.run('task', 'create', '--title', 'canary-hidden-blocker'));
    const mine = idOf(await lead0.run('task', 'create', '--title', 'scoped task'));
    const link = async (id: string) =>
      await lead0.run(
        'task',
        'link',
        id,
        '--revision',
        String(await w.revisionOf(id)),
        '--blocked-by',
        hidden,
      );
    expect((await link(mine)).exit).toBe(0);
    const scoped = await w.person(
      await w.member('only-mine', ['read'], { kind: 'record', id: mine }),
    );
    const picked = await w.pickUp(await w.decider('blocker-delegator'), 'agent blocked task');
    expect((await link(picked.taskId)).exit).toBe(0);
    const agent = await w.agent(picked.credential);
    for (const [who, answer] of [
      ['scoped standard', await scoped.run('task', 'get', mine, '--json')],
      ['scoped full', await scoped.run('task', 'get', mine, '--detail', 'full', '--json')],
      ['agent standard', await agent.run('task', 'get', picked.taskId, '--json')],
      ['agent full', await agent.run('task', 'get', picked.taskId, '--detail', 'full', '--json')],
    ] as const) {
      expect(answer.exit, `${who}: ${answer.out}`).toBe(0);
      expect(answer.out, who).not.toContain(hidden);
      expect(JSON.parse(answer.out) as Record<string, unknown>, who).toHaveProperty(
        'blockersWithheld',
        1,
      );
    }
    // The lead, who may read it, is shown it.
    expect((await lead0.run('task', 'get', mine, '--json')).out).toContain(hidden);
  });
});
