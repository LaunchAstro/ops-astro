// SPDX-License-Identifier: AGPL-3.0-only
//
// What bravo owns for the identifier suites beyond tasks, work and grants: a
// custody key (C31), a broken connection (MP-14-7a), a ready graduation row
// with a mandate on it (MP-14-10a), an automation (C33) and a client with an
// onboarding under way (C41-A). Split from `ident-audit-cases.ts` so that file
// stays under the per-file cap; `createIdentWorld` spreads it into `foreign`.

import { randomUUID } from 'node:crypto';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import {
  seedBrokenConnection,
  seedMandate,
  seedReadyClass,
  type OwnerConnection,
} from '../connections/fixture.ts';
import { seedAutomation, type SeededAutomation } from '../automations/seed.ts';

export interface ForeignRows {
  /** A key bravo's admin set in custody (C31). */
  secretId: string;
  /** A broken connection of bravo's, owner-written (MP-14-7a). */
  connectionId: string;
  /** A ready graduation row of bravo's, its client and a mandate on it (MP-14-10a). */
  classId: string;
  clientId: string;
  mandateId: string;
  /** An automation of bravo's: definition, version, activation (C33). */
  automation: SeededAutomation;
  /** A client of bravo's and a step of its onboarding (C41-A). */
  onboardingClientId: string;
  stepTaskId: string;
}

/**
 * Seeds bravo's rows. `asBravo` runs one of bravo's own commands as its admin
 * and answers the detail, so what a route makes is made through that route.
 */
export async function seedForeignRows(
  admin: OwnerConnection,
  bravo: string,
  bravoActorId: string,
  asBravo: (
    name: CommandName,
    body: Readonly<Record<string, unknown>>,
  ) => Promise<Record<string, unknown>>,
): Promise<ForeignRows> {
  const secret = await asBravo('secret.set', { name: 'bravo.key', value: `bravo-${randomUUID()}` });
  const graduation = await seedReadyClass(admin, bravo);
  const mandateId = await seedMandate(admin, bravo, graduation.clientId, bravoActorId);
  // New client onboarding (C41-A): a bravo client, and a step of its onboarding.
  const client = await asBravo('record.create', {
    type: 'client',
    fields: { name: 'a bravo client' },
  });
  const onboarding = await asBravo('onboarding.start', {
    clientId: String(client['recordId']),
    templateKey: 'standard',
  });
  const steps = onboarding['steps'] as readonly { readonly taskId: string }[];
  return {
    secretId: String(secret['secretId']),
    connectionId: await seedBrokenConnection(admin, bravo, 'a bravo source'),
    ...graduation,
    mandateId,
    automation: await seedAutomation(admin, bravo, bravoActorId),
    onboardingClientId: String(client['recordId']),
    stepTaskId: String(steps[0]?.taskId),
  };
}
