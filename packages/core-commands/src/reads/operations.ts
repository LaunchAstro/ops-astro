// SPDX-License-Identifier: AGPL-3.0-only
//
// The operations view (C55), as the holder of `operations:read` is shown it.
// It places other parts' reads rather than keeping lists of its own; the
// privacy incidents are the part that is this view's own record.

import { readPrivacyIncidents } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { OperationsReadResult } from '../../../core-wire/src/index.ts';

export async function readOperations(tx: TenantQuery): Promise<Omit<OperationsReadResult, 'ok'>> {
  const incidents = await readPrivacyIncidents(tx);
  return {
    privacyIncidents: incidents.map((incident) => ({
      id: incident.id,
      whatHappened: incident.whatHappened,
      foundAt: incident.foundAt.toISOString(),
      foundBy: incident.foundBy,
      affected: incident.affected,
      informationKinds: incident.informationKinds,
      assessBy: incident.assessBy.toISOString(),
      status: incident.status,
      recordedAt: incident.recordedAt.toISOString(),
      recordedByActorId: incident.recordedByActorId,
    })),
  };
}
