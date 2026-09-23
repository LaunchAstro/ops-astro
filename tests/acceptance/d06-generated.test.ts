// SPDX-License-Identifier: AGPL-3.0-only
//
// D06 on the three person surfaces, generated. `d06-cases.ts` says what a cell
// is and where each of its three lists comes from; this file runs them.
//
// Two recipes are added here beside `role-case-bodies.ts`'s, for the two
// controls that recipe file leaves to other cases: `grant.revoke` revokes a
// grant minted for this cell, and `delegation.revoke` revokes the delegation a
// fresh agent pickup just opened. With those, every operation a person may
// call has a positive control in this file, and the three it may not call are
// named in `PERSON_NOT_APPLICABLE` with the reason.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_OWNED_FIELDS } from '../../packages/core-records/src/commands/prepare.ts';
import type { CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  FIELDS_PAYLOAD_OPERATIONS,
  PAYLOAD_CELLS,
  PERSON_NOT_APPLICABLE,
  SYSTEM_PAYLOAD_FIELDS,
  TOP_LEVEL_CELLS,
  Tally,
  declarationFor,
  durableProbe,
  roomToApprove,
  expectUnchanged,
  inertBody,
  lastAudit,
  probeValue,
  surfacesOf,
  type Durable,
  type Said,
  type Surface,
  type TopCell,
} from './d06-cases.ts';
import { createHarness, type Harness } from './role-case-harness.ts';
import { serverUrl } from './world.ts';

/** The two commands that write a record's generic fields, through `tasks-write.ts`. */
const GENERIC_WRITES: ReadonlySet<CommandName> = new Set(['task.create', 'task.update']);

if (serverUrl === undefined) {
  console.warn('acceptance/d06-generated: DATABASE_URL is unset, so nothing below ran.');
}

// eslint-disable-next-line max-lines-per-function -- one fixture, and the cells that share it
describe.skipIf(serverUrl === undefined)('D06: every operation, field and surface', () => {
  let harness: Harness;
  let send: (surface: Surface, name: CommandName, body: Record<string, unknown>) => Promise<Said>;
  let durable: () => Promise<Durable>;
  const tally = new Tally();

  beforeAll(async () => {
    harness = await createHarness('d06g');
    send = surfacesOf(harness);
    await roomToApprove(harness);
    durable = await durableProbe(harness);
  }, 120_000);

  afterAll(async () => {
    tally.print('person surfaces');
    await harness?.close();
  });

  /** A valid body for one operation, as ada, or `undefined` when a person has none. */
  async function positive(name: CommandName): Promise<Record<string, unknown> | undefined> {
    if (PERSON_NOT_APPLICABLE[name] !== undefined) return undefined;
    const operationId = randomUUID();
    if (name === 'grant.revoke') {
      const { world } = harness;
      const grantId = await world.db.app.withBusiness(world.alpha, async (tx) => {
        return await grantTo(tx, world.noah as Parameters<typeof grantTo>[1], 'read');
      });
      return { operationId, grantId };
    }
    if (name === 'delegation.revoke') {
      const { decided } = await harness.approvedReservation();
      const detail = decided.body['detail'] as Record<string, unknown>;
      const picked = await harness.asAgent('task.pickup', {
        reservationId: String(detail['reservationId']),
      });
      expect(picked.code, 'the pickup a delegation revoke needs').toBe('ok');
      const delegationId = (picked.body['detail'] as Record<string, unknown>)['delegationId'];
      return { operationId, delegationId };
    }
    const prepared = await harness.positiveBody(declarationFor(name));
    if (!('body' in prepared)) throw new Error(`d06: ${name} has no recipe: ${prepared.exception}`);
    // A read carries no attempt identity on the web surface, so it carries none anywhere.
    return declarationFor(name).kind === 'read' ? prepared.body : { operationId, ...prepared.body };
  }

  /** The cell, whichever list it came from. `inject` puts the field where the list says. */
  async function runCell(
    cell: TopCell,
    inject: (body: Record<string, unknown>, value: unknown) => Record<string, unknown>,
    code: string,
  ): Promise<void> {
    const value = probeValue(cell.key);
    const notApplicable = PERSON_NOT_APPLICABLE[cell.operation];

    // First, a valid request succeeds, so a refusal below is not a refusal of everything.
    if (notApplicable === undefined) {
      const first = await positive(cell.operation);
      const control = await send(cell.surface, cell.operation, first ?? {});
      expect(control.code, `positive control for ${cell.operation}`).toBe('ok');
    }

    const body = (await positive(cell.operation)) ?? {
      operationId: randomUUID(),
      ...inertBody(cell.operation),
    };
    const before = await durable();
    const answer = await send(cell.surface, cell.operation, inject(body, value));
    // Counted on the answer, so a cell that goes red is still a cell that ran.
    tally.count(cell.operation, cell.surface, answer.code === code, notApplicable);
    expect(answer.code).toBe(code);
    expect(answer.names).toStrictEqual([cell.key]);
    if (typeof value === 'string') expect(JSON.stringify(answer.body)).not.toContain(value);
    const after = await durable();
    const audit = await lastAudit(harness);
    const attempt = declarationFor(cell.operation).kind !== 'read';
    expectUnchanged(before, after, audit, { operation: cell.operation, code, attempt });
    if (inject(body, value)[cell.key] !== undefined) {
      expect(audit['attempted']).toStrictEqual({ [cell.key]: value });
    }

    // And the same request without the field succeeds, under a fresh identity:
    // the refused one is registered and replays its refusal.
    if (notApplicable === undefined) {
      const retry = attempt ? { ...body, operationId: randomUUID() } : body;
      const clean = await send(cell.surface, cell.operation, retry);
      expect(clean.code, `the injected request, without the field`).toBe('ok');
    }
  }

  it('reads the installed field metadata the payload cells are generated from', async () => {
    const { world } = harness;
    const rows = await world.db.admin.execute<{ readonly key: string }>(
      `select fd.key from public.field_defs fd
         join public.record_types rt on rt.business_id = fd.business_id and rt.id = fd.record_type_id
        where fd.business_id = $1 and rt.key = 'task' and fd.write_mode = 'system'
        order by 1`,
      [world.alpha],
    );
    expect(rows.map((row) => row.key)).toStrictEqual(SYSTEM_PAYLOAD_FIELDS);
    expect(SYSTEM_OWNED_FIELDS.length).toBeGreaterThan(0);
  });

  it('lists exactly the operations whose positive body carries record fields', async () => {
    const carrying: CommandName[] = [];
    for (const cell of TOP_LEVEL_CELLS) {
      if (cell.key !== SYSTEM_OWNED_FIELDS[0] || cell.surface !== 'api') continue;
      // A plan's `fields` is not a record's, and the two revokes are this file's own recipes.
      if (['preset.plan', 'grant.revoke', 'delegation.revoke'].includes(cell.operation)) continue;
      // eslint-disable-next-line no-await-in-loop -- one recipe at a time, as a person would
      const body = await positive(cell.operation);
      const fields = body?.['fields'];
      if (typeof fields === 'object' && fields !== null && !Array.isArray(fields)) {
        carrying.push(cell.operation);
      }
    }
    expect(carrying.toSorted()).toStrictEqual([...FIELDS_PAYLOAD_OPERATIONS]);
  }, 60_000);

  it.each(TOP_LEVEL_CELLS)(
    '$operation refuses top-level $key on $surface, and writes nothing',
    async (cell) => {
      await runCell(cell, (body, value) => ({ ...body, [cell.key]: value }), 'FIELD_NOT_WRITABLE');
    },
    60_000,
  );

  /**
   * Inside `fields`, the refusal is the field engine's rather than the
   * envelope's. `source` is `SOURCE_SPOOFED` on the generic write path, which
   * is `tasks-write.ts` behind `task.create` and `task.update`, for the reason
   * `protected-fields.test.ts` gives: claiming a provenance is a different
   * mistake from writing a derived value. The operation-owned commands never
   * reach that check and the engine refuses it as the derived field it is.
   */
  it.each(PAYLOAD_CELLS)(
    '$operation refuses fields.$key on $surface, and writes nothing',
    async (cell) => {
      await runCell(
        cell,
        (body, value) => ({
          ...body,
          fields: { ...(body['fields'] as Record<string, unknown>), [cell.key]: value },
        }),
        cell.key === 'source' && GENERIC_WRITES.has(cell.operation)
          ? 'SOURCE_SPOOFED'
          : 'FIELD_NOT_WRITABLE',
      );
    },
    60_000,
  );
});
