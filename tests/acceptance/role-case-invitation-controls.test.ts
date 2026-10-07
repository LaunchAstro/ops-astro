// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-await-in-loop -- D06 cells commit their control before their refusal and clean retry */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './role-case-harness.ts';
import {
  TOP_LEVEL_CELLS,
  declarationFor,
  probeValue,
  roomToApprove,
  surfacesOf,
} from './d06-cases.ts';
import { serverUrl } from './world.ts';

describe.skipIf(serverUrl === undefined)('C39-T invitation recipes in the D06 matrix', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness('invitecontrols');
    await roomToApprove(harness);
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('invitation recipes support every generated D06 positive control', async () => {
    const send = surfacesOf(harness);
    const positive = async () => {
      const prepared = await harness.positiveBody(declarationFor('invitation.create'));
      if ('exception' in prepared) throw new Error(prepared.exception);
      return { ...prepared.body, operationId: randomUUID() };
    };
    for (const cell of TOP_LEVEL_CELLS.filter((one) => one.operation === 'invitation.create')) {
      const control = await send(cell.surface, cell.operation, await positive());
      expect(control.code, `${cell.key} on ${cell.surface}: positive control`).toBe('ok');
      const body = await positive();
      const refused = await send(cell.surface, cell.operation, {
        ...body,
        [cell.key]: probeValue(cell.key),
      });
      expect(refused.code).toBe('FIELD_NOT_WRITABLE');
      const clean = await send(cell.surface, cell.operation, {
        ...body,
        operationId: randomUUID(),
      });
      expect(clean.code, `${cell.key} on ${cell.surface}: clean retry`).toBe('ok');
    }
  });
});
