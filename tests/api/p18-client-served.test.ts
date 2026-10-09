// SPDX-License-Identifier: AGPL-3.0-only
// P18 through the actual API process, verified bearer/JWKS and real PostgreSQL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { enrolExternal } from '../acceptance/world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  applied,
  auditCount,
  client,
  detailOf,
  linkedTask,
  memberOf,
  objectOf,
  openServedWorld,
  reach,
  reader,
  records,
  task,
  work,
  type ServedWorld,
} from './p18-p19-served-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('P18 served proof: no DATABASE_URL; nothing proved.');

const live = describe.skipIf(serverUrl === undefined);
let s: ServedWorld;
beforeAll(async () => {
  s = await openServedWorld('p18_client_served');
}, 180_000);
afterAll(async () => {
  await s?.close();
});

live('P18 permitted client over served API', () => {
  it('serves readable and explicit none, audits each read and does not mutate the task', async () => {
    const clientName = 'P18 permitted client canary';
    const clientId = await client(s, clientName);
    const linked = await linkedTask(s, 'P18 linked task', clientId);
    const idle = await task(s, 'P18 genuinely unlinked task');
    const before = await records(s, linked);
    const audited = await auditCount(s, 'task.read', 'applied');
    const named = objectOf(
      applied(await s.person(s.world.ada, 'task.read', { recordId: linked }))['task'],
    );
    expect(named['client']).toBe(clientId);
    expect(named['clientSummary']).toStrictEqual({ kind: 'readable', name: clientName });
    const none = objectOf(
      applied(await s.person(s.world.ada, 'task.read', { recordId: idle.id }))['task'],
    );
    expect(none['client']).toBeNull();
    expect(none['clientSummary']).toStrictEqual({ kind: 'none' });
    expect(await auditCount(s, 'task.read', 'applied')).toBe(audited + 2);
    expect(await records(s, linked)).toStrictEqual(before);
  });
});

live('P18 permitted client over served API', () => {
  it('allows the task-only/other-client reader but withholds client identity and foreign business data', async () => {
    const a = await client(s, 'P18 protected A name');
    const b = await client(s, 'P18 permitted B name');
    const id = await linkedTask(s, 'P18 readable own title', a);
    const held = await reader(s, 'P18 held to B');
    await reach(s, held, 'party', b);
    await reach(s, held, 'record', id);
    const answer = await s.person(held, 'task.read', { recordId: id });
    const own = objectOf(applied(answer)['task']);
    expect(own['clientSummary']).toStrictEqual({ kind: 'withheld' });
    expect(own['client']).toBeNull();
    expect(own['clientSet']).toBe(true);
    expect(answer.text).toContain('P18 readable own title');
    expect(answer.text).not.toContain(a);
    expect(answer.text).not.toContain('P18 protected A name');
    const other = await s.person(s.world.bea, 'task.read', { recordId: id });
    expect(other.code).toBe('NOT_FOUND');
    expect(other.text).not.toContain(a);
    expect(other.text).not.toContain('P18 protected A name');
    expect(
      objectOf(applied(await s.person(s.world.ada, 'task.read', { recordId: id }))['task'])[
        'client'
      ],
    ).toBe(a);
  });
});

live('P18 permitted client over served API', () => {
  it('reauthorises metadata after revocation while preserving the permitted task title', async () => {
    const name = 'P18 revoked metadata canary';
    const clientId = await client(s, name);
    const id = await linkedTask(s, 'P18 retained task title', clientId);
    const who = await reader(s, 'P18 revocation reader');
    await reach(s, who, 'record', id);
    const metadataGrant = await reach(s, who, 'party', clientId);
    const first = await s.person(who, 'task.read', { recordId: id });
    expect(objectOf(applied(first)['task'])['clientSummary']).toStrictEqual({
      kind: 'readable',
      name,
    });
    await s.world.db.app.withBusiness(s.world.alpha, async (tx) => {
      expect(await revokeGrant(tx, metadataGrant)).not.toBeNull();
    });
    const second = await s.person(who, 'task.read', { recordId: id });
    expect(objectOf(applied(second)['task'])['clientSummary']).toStrictEqual({ kind: 'withheld' });
    expect(second.text).toContain('P18 retained task title');
    expect(second.text).not.toContain(name);
    expect(second.text).not.toContain(clientId);
  });
});

live('P18 permitted client over served API', () => {
  it('keeps shared external and live delegated Agent DTOs narrow with own positive controls', async () => {
    const name = 'P18 narrow view hidden client';
    const clientId = await client(s, name);
    const shared = await linkedTask(s, 'P18 shared own title', clientId);
    const sibling = await linkedTask(s, 'P18 sibling hidden title', clientId);
    const ext = await enrolExternal(s.world);
    await s.world.db.app.withBusiness(s.world.alpha, async (tx) => {
      const issued = await shareRecord(tx, memberOf(s.world.ada), {
        collection: 'task',
        recordId: shared,
        personId: memberOf(ext).personId,
      });
      expect(issued.ok).toBe(true);
    });
    const external = await s.person(ext, 'task.read', { recordId: shared });
    const sharedTask = objectOf(applied(external)['sharedTask']);
    expect(Object.keys(sharedTask).toSorted()).toStrictEqual([
      'comments',
      'fields',
      'id',
      'revision',
    ]);
    expect(external.body['task']).toBeUndefined();
    expect(external.text).toContain('P18 shared own title');
    expect((await s.person(ext, 'task.read', { recordId: sibling })).code).not.toBe('ok');
    const active = await work(s, 'P18 delegated own title', clientId);
    const credential = String(active.picked['credential']);
    const agent = await s.agent('task.read', { recordId: active.taskId }, credential);
    const narrow = objectOf(detailOf(agent)['task']);
    expect(narrow['title']).toBe('P18 delegated own title');
    expect(agent.text).toContain('P18 delegated own title');
    expect(narrow['client']).toBeUndefined();
    expect(narrow['hasContent']).toBeUndefined();
    expect(narrow['clientSummary']).toBeUndefined();
    expect(narrow['ledger']).toBeNull();
    expect((await s.agent('task.read', { recordId: sibling }, credential)).code).toBe(
      'DELEGATION_OUT_OF_PURPOSE',
    );
    for (const text of [external.text, agent.text]) {
      expect(text).not.toContain(name);
      expect(text).not.toContain(clientId);
      expect(text).not.toContain('P18 sibling hidden title');
      expect(text).not.toContain('clientSummary');
      expect(text).not.toContain('execution');
    }
  });
});
