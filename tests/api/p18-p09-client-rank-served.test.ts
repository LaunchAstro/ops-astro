// SPDX-License-Identifier: AGPL-3.0-only
// The composed owning task response carries canonical client facts and ICE marks.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { readAuditEvents } from '../../packages/core-commands/src/commands/audit.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  applied,
  client,
  linkedTask,
  objectOf,
  openServedWorld,
  reach,
  reader,
  records,
  type ServedWorld,
} from './p18-p19-served-world.ts';

const serverUrl = databaseUrlFromEnvironment();
const live = describe.skipIf(serverUrl === undefined);
let s: ServedWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) s = await openServedWorld('p18_p09_client_rank');
}, 180_000);
afterAll(async () => {
  await s?.close();
});

live('P18/P09 owning task client and rank composition over served API', () => {
  it('preserves exact score effects and permitted rank while revoked client metadata is withheld', async () => {
    const clientName = 'P18 P09 protected client canary';
    const clientId = await client(s, clientName);
    const title = 'P18 P09 permitted task title';
    const id = await linkedTask(s, title, clientId);
    const who = await reader(s, 'P18 P09 record and client reader');
    await reach(s, who, 'record', id);
    const metadataGrant = await reach(s, who, 'party', clientId);
    const initial = objectOf(
      applied(await s.person(s.world.ada, 'task.read', { recordId: id }))['task'],
    );
    const before = objectOf((await records(s, id))[0]?.record);
    const revision = Number(initial['revision']);
    const operationId = randomUUID();
    const marks = { impact: 7, confidence: 9, ease: 8 };
    const auditBefore = Array.from(
      await s.world.db.app.withBusiness(s.world.alpha, readAuditEvents),
    );
    const written = applied(
      await s.person(s.world.ada, 'task.set_scores', {
        operationId,
        recordId: id,
        expectedRevision: revision,
        fields: marks,
      }),
    );
    expect(written['revision']).toBe(revision + 1);
    const held = objectOf((await records(s, id))[0]?.record);
    expect(held).toStrictEqual({
      ...before,
      data: { ...objectOf(before['data']), ...marks },
      num_3: 7,
      num_4: 9,
      num_5: 8,
      revision: revision + 1,
      updated_at: held['updated_at'],
    });
    expect(held['updated_at']).toBeTypeOf('string');
    const auditWritten = Array.from(
      await s.world.db.app.withBusiness(s.world.alpha, readAuditEvents),
    );
    expect(auditWritten.slice(0, auditBefore.length)).toStrictEqual(auditBefore);
    expect(
      auditWritten
        .slice(auditBefore.length)
        .map(({ command, operation_id, outcome, subject_record_id }) => ({
          command,
          operation_id,
          outcome,
          subject_record_id,
        })),
    ).toStrictEqual([
      {
        command: 'task.set_scores',
        operation_id: operationId,
        outcome: 'applied',
        subject_record_id: id,
      },
    ]);

    const own = objectOf(
      applied(await s.person(s.world.ada, 'task.read', { recordId: id }))['task'],
    );
    expect(own).toMatchObject({
      id,
      title,
      revision: revision + 1,
      scores: marks,
      client: clientId,
      clientSummary: { kind: 'readable', name: clientName },
      rank: { score: 504 },
    });
    const permitted = objectOf(applied(await s.person(who, 'task.read', { recordId: id }))['task']);
    expect(permitted).toMatchObject({
      id,
      title,
      scores: marks,
      client: clientId,
      clientSummary: { kind: 'readable', name: clientName },
      hasContent: own['hasContent'],
      rank: { number: 1, score: 504, calc: objectOf(own['rank'])['calc'] },
    });
    await s.world.db.app.withBusiness(s.world.alpha, async (tx) => {
      expect(await revokeGrant(tx, metadataGrant)).not.toBeNull();
    });
    const answer = await s.person(who, 'task.read', { recordId: id });
    const withheld = objectOf(applied(answer)['task']);
    expect(withheld).toMatchObject({
      id,
      title,
      revision: revision + 1,
      scores: marks,
      rank: permitted['rank'],
      client: null,
      clientSet: true,
      clientSummary: { kind: 'withheld' },
      hasContent: own['hasContent'],
    });
    expect(answer.text).not.toContain(clientId);
    expect(answer.text).not.toContain(clientName);
    expect(objectOf((await records(s, id))[0]?.record)).toStrictEqual(held);
    const auditAfter = Array.from(
      await s.world.db.app.withBusiness(s.world.alpha, readAuditEvents),
    );
    expect(auditAfter.slice(0, auditWritten.length)).toStrictEqual(auditWritten);
    expect(
      auditAfter
        .slice(auditWritten.length)
        .map(({ command, operation_id, outcome, subject_record_id }) => ({
          command,
          operation_id,
          outcome,
          subject_record_id,
        })),
    ).toStrictEqual([
      { command: 'task.read', operation_id: null, outcome: 'applied', subject_record_id: id },
      { command: 'task.read', operation_id: null, outcome: 'applied', subject_record_id: id },
      { command: 'task.read', operation_id: null, outcome: 'applied', subject_record_id: id },
    ]);
    expect(auditAfter.filter((event) => event.operation_id === operationId)).toStrictEqual(
      auditWritten.filter((event) => event.operation_id === operationId),
    );
  });
});
