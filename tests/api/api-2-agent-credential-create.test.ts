// SPDX-License-Identifier: AGPL-3.0-only
//
// API-2: an agent credential adds a task (ORCH47). `task.create` is reached
// by a credential only inside its delegation: the ticked `task:write`, the
// issuer's grants as they are now, in the business it was issued in, and
// audited against the agent. The pickup agent reaches the same surface row,
// and under its one-task delegation a create is outside the purpose. Helpers:
// `api-2-agent-credential-use-world.ts`.

import { expect, it } from 'vitest';
import { bearer, serverUrl, type Answer } from '../acceptance/world.ts';
import {
  credential as pickupCredential,
  harness,
  openWorld,
  revoke,
} from './api-2-agent-credential-world.ts';
import { asCredential, issued, wordsOf } from './api-2-agent-credential-use-world.ts';

openWorld();

const needsServer = it.skipIf(serverUrl === undefined);
const TASK_ACCESS = {
  scope: [
    { collection: 'task', action: 'read' },
    { collection: 'task', action: 'write' },
  ],
};

const create = async (
  headers: Record<string, string>,
  title: string,
  businessKey = 'alpha',
): Promise<Answer> =>
  await asCredential('task.create', { fields: { title } }, headers, undefined, businessKey);

/** Every record in a business, tasks and comments alike. */
async function recordsIn(businessId: string): Promise<number> {
  const rows = await harness.world.db.admin.execute<{ readonly n: string }>(
    'select count(*)::text as n from public.records where business_id = $1',
    [businessId],
  );
  return Number(rows[0]?.n ?? '-1');
}

needsServer(
  'API-2 owner check: a credential with only task access adds a task while it lives, and after revoking its next command is refused with a plain reason',
  async () => {
    const credential = await issued(TASK_ACCESS);
    const added = await create(bearer(credential.secret), 'added by my agent');
    expect(added.code, added.text).toBe('ok');
    const recordId = String(added.body['recordId']);
    const read = await asCredential('task.read', { recordId }, bearer(credential.secret));
    expect(read.code, 'the agent reads back what it added').toBe('ok');

    expect((await revoke(credential.id)).code).toBe('ok');
    const before = await recordsIn(harness.world.alpha);
    const refused = await create(bearer(credential.secret), 'after the revocation');
    expect(refused.status).toBe(401);
    expect(refused.code).toBe('DELEGATION_NOT_LIVE');
    expect(wordsOf(refused)).toMatch(/revoked/iu);
    expect(refused.text).not.toContain(credential.secret);
    expect(await recordsIn(harness.world.alpha), 'the refused create wrote nothing').toBe(before);
  },
);

needsServer(
  'API-2 create audited: each create by a credential is audited with the agent as actor',
  async () => {
    const credential = await issued(TASK_ACCESS, harness.world.noah.token);
    const created: string[] = [];
    for (const title of ['the first', 'the second']) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await create(bearer(credential.secret), title);
      expect(answer.code, answer.text).toBe('ok');
      created.push(String(answer.body['recordId']));
    }
    const rows = await harness.world.db.admin.execute<{
      readonly subject: string;
      readonly kind: string;
      readonly person_id: string;
      readonly register_actor: string;
      readonly source: string;
      readonly title: string;
    }>(
      `select e.subject_record_id::text as subject, a.kind, c.issued_by_person_id as person_id,
              o.actor_id as register_actor, r.data ->> 'source' as source,
              r.data ->> 'title' as title
         from public.audit_events e
         join public.actors a on a.business_id = e.business_id and a.id = e.actor_id
         join public.agent_credentials c
           on c.business_id = e.business_id and c.agent_actor_id = e.actor_id
         join public.operations o
           on o.business_id = e.business_id and o.operation_id = e.operation_id
          and o.actor_id = e.actor_id
         join public.records r on r.business_id = e.business_id and r.id = e.subject_record_id
        where c.id = $1 and e.command = 'task.create' and e.outcome = 'applied'
        order by r.data ->> 'title'`,
      [credential.id],
    );
    expect(rows.map((row) => row.subject).toSorted()).toStrictEqual(created.toSorted());
    for (const row of rows) {
      expect(row.kind).toBe('agent');
      expect(row.register_actor).not.toBe(harness.world.noah.actorId);
      expect(row.person_id).toBe(harness.world.noah.personId);
      expect(row.source, 'the record says an agent made it').toBe('agent:api');
    }
    expect(rows.map((row) => row.title)).toStrictEqual(['the first', 'the second']);
  },
);

needsServer(
  'API-2 create within scope: a credential without task:write cannot create, though its person can',
  async () => {
    const readOnly = await issued({ scope: [{ collection: 'task', action: 'read' }] });
    const before = await recordsIn(harness.world.alpha);
    const refused = await create(bearer(readOnly.secret), 'outside the ticked keys');
    expect(refused.status).toBe(403);
    expect(refused.code).toBe('SCOPE_NOT_GRANTED');
    expect(await recordsIn(harness.world.alpha)).toBe(before);

    const byPerson = await harness.asPerson('task.create', { fields: { title: 'Ada adds it' } });
    expect(byPerson.code, 'the person holds task:write').toBe('ok');
  },
);

needsServer(
  'API-2 create business to business: a credential creates only in its own business',
  async () => {
    const credential = await issued(TASK_ACCESS);
    const bravo = await recordsIn(harness.world.bravo);
    const elsewhere = await create(bearer(credential.secret), 'into bravo', 'bravo');
    expect(elsewhere.status).toBe(401);
    expect(elsewhere.code).toBe('DELEGATION_NOT_LIVE');

    // Under bravo's task, from alpha: the parent is not there, and says nothing of it.
    const under = await asCredential(
      'task.create',
      { fields: { title: 'under bravo' }, parentId: harness.bravoRecordId },
      bearer(credential.secret),
    );
    expect(under.code).toBe('NOT_FOUND');
    expect(under.text).not.toContain(harness.bravoRecordId);
    expect(await recordsIn(harness.world.bravo), 'nothing reached bravo').toBe(bravo);

    const home = await create(bearer(credential.secret), 'at home');
    expect(home.code, home.text).toBe('ok');
    const rows = await harness.world.db.admin.execute<{ readonly business_id: string }>(
      'select business_id from public.records where id = $1',
      [String(home.body['recordId'])],
    );
    expect(rows.map((row) => row.business_id)).toStrictEqual([harness.world.alpha]);
  },
);

needsServer(
  'API-2 pickup agent cannot create: under a pickup delegation task.create is refused and writes nothing',
  async () => {
    const before = await recordsIn(harness.world.alpha);
    const body = { fields: { title: 'from the pickup agent' } };
    const underPickup = await harness.asAgent('task.create', body, pickupCredential);
    expect(underPickup.status).toBe(403);
    expect(underPickup.code).toBe('DELEGATION_OUT_OF_PURPOSE');
    expect(wordsOf(underPickup)).toMatch(/another resource/iu);

    const beforeAny = await harness.asAgent('task.create', body);
    expect(beforeAny.status).toBe(403);
    expect(beforeAny.code).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(await recordsIn(harness.world.alpha), 'no task was added').toBe(before);
  },
);
