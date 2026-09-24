// SPDX-License-Identifier: AGPL-3.0-only
//
// A foreign lineage and a fabricated one answer byte-identically on every
// route that takes a caller-presented lineage id (root ruling 2 of 906613f,
// applied beyond `task.decide`; minimum contract 8.2 cases 1 and 2).
//
// `task.propose` takes `lineageId` to add a version to an existing lineage,
// and the runtime refused an unknown one with `GATE_NOT_FOUND` and a reason
// that echoed the presented id. A foreign id and a fabricated id therefore
// answered with different bytes, and the difference was the id itself.
// `task.restart` takes `lineageId` too; its command layer answers `NOT_FOUND`
// before the runtime runs, and this suite keeps it that way.
//
// `task.decide` takes `gateId` and `versionId`. A gate that is not this
// business's answers `NOT_FOUND` from the command layer. The caller's own
// gate, named with a version that is not its version, reaches the runtime's
// comparison under the locks, whose VERSION_SUPERSEDED reason once named the
// presented version; it now names only the gate and the version it carries.
//
// Each call goes through the real HTTP route, as ada in alpha, naming either
// a real live lineage in bravo or an id that names nothing. The status and the
// raw response text are compared as they arrive, with no id or fragment
// stripped first. The refused attempt is audited in alpha, never in bravo, and
// the caller's own lineage is the positive control.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { PROPOSAL } from '../acceptance/role-case-bodies.ts';
import { bearer, call, createWorld, personPath, serverUrl } from '../acceptance/world.ts';
import type { Caller, World } from '../acceptance/world.ts';

if (serverUrl === undefined) {
  console.warn('commands/gate-reason-lineage: DATABASE_URL is unset, so nothing below ran.');
}

interface Raw {
  readonly status: number;
  readonly text: string;
}

interface Proposed {
  readonly taskId: string;
  readonly lineageId: string;
  readonly gateId: string;
  readonly versionId: string;
}

describe.skipIf(serverUrl === undefined)(
  'a foreign or fabricated lineage, gate or version id',
  () => {
    let world: World;

    beforeAll(async () => {
      world = await createWorld('gatereason');
    }, 120_000);

    afterAll(async () => {
      await world?.close();
    });

    /** A task with a live proposal on it, made by `caller` through the real routes. */
    async function proposedBy(caller: Caller): Promise<Proposed> {
      const made = await call(
        world.api,
        personPath(caller.businessKey, '/task/create'),
        { operationId: randomUUID(), fields: { title: `a task of ${caller.name}` } },
        bearer(caller.token),
      );
      expect(made.code, 'task.create').toBe('ok');
      const proposed = await call(
        world.api,
        personPath(caller.businessKey, '/task/propose'),
        {
          operationId: randomUUID(),
          recordId: made.body['recordId'],
          expectedRevision: made.body['revision'],
          ...PROPOSAL,
        },
        bearer(caller.token),
      );
      expect(proposed.code, 'task.propose').toBe('ok');
      const detail = proposed.body['detail'] as Record<string, string>;
      return {
        taskId: String(made.body['recordId']),
        lineageId: String(detail['lineageId']),
        gateId: String(detail['gateId']),
        versionId: String(detail['versionId']),
      };
    }

    /** One of ada's commands on alpha's prefix, read as the bytes the caller receives. */
    async function raw(path: string, body: Readonly<Record<string, unknown>>): Promise<Raw> {
      const response = await world.api.fetch(
        new Request(`http://api.test${personPath('alpha', path)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...bearer(world.ada.token) },
          body: JSON.stringify(body),
        }),
      );
      return { status: response.status, text: await response.text() };
    }

    async function currentRevision(taskId: string): Promise<number> {
      const rows = await world.db.admin.execute<{ readonly revision: string }>(
        `select revision::text from public.records where id = $1`,
        [taskId],
      );
      return Number(rows[0]?.revision);
    }

    async function auditIn(business: BusinessId, operationId: string) {
      return await world.db.app.withBusiness(business, async (tx) =>
        (await readAuditEvents(tx))
          .filter((event) => event.operation_id === operationId)
          .map((event) => [event.outcome, event.refusal_code]),
      );
    }

    async function lineageRow(lineageId: string) {
      const rows = await world.db.admin.execute<Record<string, unknown>>(
        `select * from public.proposal_lineages where id = $1`,
        [lineageId],
      );
      return rows[0];
    }

    async function gateRow(gateId: string) {
      const rows = await world.db.admin.execute<Record<string, unknown>>(
        `select * from public.gates where id = $1`,
        [gateId],
      );
      return rows[0];
    }

    /** Both probes, sent to one route with only the presented id differing. */
    async function probe(
      path: string,
      body: (presented: string) => Readonly<Record<string, unknown>>,
      foreign: string,
      untouched: (id: string) => Promise<unknown> = lineageRow,
    ): Promise<void> {
      const fabricated = randomUUID();
      const before = await untouched(foreign);
      const foreignOperation = randomUUID();
      const fabricatedOperation = randomUUID();
      const toForeign = await raw(path, { operationId: foreignOperation, ...body(foreign) });
      const toFabricated = await raw(path, {
        operationId: fabricatedOperation,
        ...body(fabricated),
      });

      // The whole answer, as sent. Nothing is stripped first.
      expect(toForeign).toStrictEqual(toFabricated);
      expect(toForeign.status).not.toBe(200);
      expect(JSON.parse(toForeign.text)).toMatchObject({ refused: true });
      for (const id of [foreign, fabricated]) expect(toForeign.text).not.toContain(id);

      const code = (JSON.parse(toForeign.text) as Record<string, unknown>)['code'];
      expect(await auditIn(world.alpha, foreignOperation)).toStrictEqual([['refused', code]]);
      expect(await auditIn(world.alpha, fabricatedOperation)).toStrictEqual([['refused', code]]);
      expect(await auditIn(world.bravo, foreignOperation)).toStrictEqual([]);
      expect(await untouched(foreign)).toStrictEqual(before);
    }

    it('task.propose answers the same bytes for both, echoes neither id and audits at home', async () => {
      const foreign = await proposedBy(world.bea);
      const own = await proposedBy(world.ada);
      const revision = await currentRevision(own.taskId);
      await probe(
        '/task/propose',
        (lineageId) => ({
          recordId: own.taskId,
          expectedRevision: revision,
          ...PROPOSAL,
          lineageId,
        }),
        foreign.lineageId,
      );
    });

    it('task.restart answers the same bytes for both, echoes neither id and audits at home', async () => {
      const foreign = await proposedBy(world.bea);
      const own = await proposedBy(world.ada);
      await probe(
        '/task/restart',
        (lineageId) => ({ recordId: own.taskId, lineageId }),
        foreign.lineageId,
      );
    });

    it('task.decide answers the same bytes for a foreign or fabricated gate id', async () => {
      const foreign = await proposedBy(world.bea);
      const own = await proposedBy(world.ada);
      await probe(
        '/task/decide',
        (gateId) => ({ gateId, versionId: own.versionId, decision: 'reject', note: 'probe' }),
        foreign.gateId,
        gateRow,
      );
      expect(await gateRow(own.gateId)).toMatchObject({ state: 'pending' });
    });

    it('task.decide on the caller’s own gate echoes neither a foreign nor a fabricated version id', async () => {
      // The gate is found, so this reaches the runtime's version comparison
      // under the locks (`decide.ts`, VERSION_SUPERSEDED), which once named the
      // presented version in its reason.
      const foreign = await proposedBy(world.bea);
      const own = await proposedBy(world.ada);
      await probe(
        '/task/decide',
        (versionId) => ({ gateId: own.gateId, versionId, decision: 'reject', note: 'probe' }),
        foreign.versionId,
        async () => await gateRow(own.gateId),
      );
      expect(await gateRow(own.gateId)).toMatchObject({ state: 'pending' });
    });

    it('still decides the caller’s own gate through the same route', async () => {
      const own = await proposedBy(world.ada);
      const answer = await raw('/task/decide', {
        operationId: randomUUID(),
        gateId: own.gateId,
        versionId: own.versionId,
        decision: 'reject',
        note: 'the positive control',
      });
      expect(answer.status, answer.text).toBe(200);
      expect(await gateRow(own.gateId)).toMatchObject({ state: 'rejected' });
    });

    // Timeout only (TEST-TIMEOUTS): this case ran past the 5 s default while the
    // machine was busy and passes alone; the assertions are unchanged.
    it('still restarts the caller’s own cancelled lineage through the same route', async () => {
      const own = await proposedBy(world.ada);
      const cancelled = await raw('/task/cancel', {
        operationId: randomUUID(),
        recordId: own.taskId,
        lineageId: own.lineageId,
        reason: 'the positive control',
      });
      expect(cancelled.status, cancelled.text).toBe(200);
      const answer = await raw('/task/restart', {
        operationId: randomUUID(),
        recordId: own.taskId,
        lineageId: own.lineageId,
      });
      expect(answer.status, answer.text).toBe(200);
      const detail = (JSON.parse(answer.text) as Record<string, Record<string, unknown>>)['detail'];
      expect(detail?.['restartsLineageId']).toBe(own.lineageId);
    }, 30_000);

    it('still adds a version to the caller’s own lineage through the same route', async () => {
      const own = await proposedBy(world.ada);
      const answer = await raw('/task/propose', {
        operationId: randomUUID(),
        recordId: own.taskId,
        expectedRevision: await currentRevision(own.taskId),
        ...PROPOSAL,
        lineageId: own.lineageId,
      });
      expect(answer.status, answer.text).toBe(200);
      const detail = (JSON.parse(answer.text) as Record<string, Record<string, unknown>>)['detail'];
      expect(detail?.['lineageId']).toBe(own.lineageId);
      expect(detail?.['versionId']).not.toBe(own.versionId);
    });
  },
);
