// SPDX-License-Identifier: AGPL-3.0-only
//
// One automation, owner-written (C33): a definition, a version permitting
// manual and scheduled, and a manual activation pinned to it at revision 1.
// For the meta-suites that need another business's rows to aim at; the C33
// suites release and activate through the commands.

import { randomUUID } from 'node:crypto';

export interface OwnerConnection {
  execute(sql: string, params?: readonly unknown[]): Promise<unknown>;
}

export interface SeededAutomation {
  readonly definitionId: string;
  readonly versionId: string;
  readonly activationId: string;
}

export async function seedAutomation(
  admin: OwnerConnection,
  business: string,
  actorId: string,
): Promise<SeededAutomation> {
  const seeded = {
    definitionId: randomUUID(),
    versionId: randomUUID(),
    activationId: randomUUID(),
  };
  await admin.execute(
    `insert into public.automation_definitions (business_id, id, kind, name, created_by_actor_id)
     values ($1, $2, 'automation', 'a seeded automation', $3)`,
    [business, seeded.definitionId, actorId],
  );
  await admin.execute(
    `insert into public.definition_versions
       (business_id, id, definition_id, number, content_digest, content_size, inputs, operations,
        modes, released_by_actor_id)
     values ($1, $2, $3, 1, repeat('c', 64), 1, '[]', '[]', '{manual,scheduled}', $4)`,
    [business, seeded.versionId, seeded.definitionId, actorId],
  );
  await admin.execute(
    `insert into public.activations
       (business_id, id, definition_id, version_id, mode, enabled, changed_by_actor_id)
     values ($1, $2, $3, $4, 'manual', false, $5)`,
    [business, seeded.activationId, seeded.definitionId, seeded.versionId, actorId],
  );
  return seeded;
}
