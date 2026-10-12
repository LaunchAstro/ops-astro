// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent credential's command that raised past its one retry rolled its
// transaction back, the attempt's record with it. The attempt is recorded
// again here, as the person entry records one (`recordFailure`): a `failed`
// audit event in a transaction of its own, attributed to the credential's
// agent actor while the credential is live, with no message, since a message
// may carry a value. A read writes no attempt, as on the person entry, and an
// answer past the export limit is not a fault.

import { payloadDigest } from '../../../core-digest/src/index.ts';
import { resolveAgentCredential } from '../../../core-records/src/index.ts';
import type { BusinessId, Database } from '../../../core-records/src/index.ts';
import { declarationOf } from '../../../core-wire/src/index.ts';
import { writeAuditEvent } from './audit.ts';
import { describeFault } from './envelope.ts';
import { comparablePayload } from './payload.ts';
import { hasIdentity, type UncheckedRequest } from './requests.ts';

/** Thrown inside the transaction so an answer over the export limit applies nothing. */
export class ExportLimitReached extends Error {}

/** The secret presented, and the time its expiry is read against. */
interface Presented {
  readonly credential: string;
  readonly now: Date;
}

/** A payload with no canonical form gets the all-zero digest, as on the person entry. */
const UNREPRESENTABLE_DIGEST = '0'.repeat(64);

function failedDigest(request: UncheckedRequest): string {
  try {
    return payloadDigest(comparablePayload(request));
  } catch {
    return UNREPRESENTABLE_DIGEST;
  }
}

/** Records the failed attempt of `request`; a fault in recording it is logged, never thrown. */
export async function recordCredentialFailure(
  database: Database,
  businessId: BusinessId,
  call: Presented,
  request: UncheckedRequest,
  original: unknown,
): Promise<void> {
  if (original instanceof ExportLimitReached) return;
  try {
    if (declarationOf(request.command).kind === 'read') return;
    await database.withBusiness(businessId, async (tx) => {
      const standing = await resolveAgentCredential(tx, call.credential, call.now);
      if (standing === 'not-live') return;
      await writeAuditEvent(tx, {
        actorId: standing.agentActorId,
        command: request.command,
        operationId: hasIdentity(request) ? request.operationId : null,
        outcome: 'failed',
        payloadDigest: failedDigest(request),
      });
    });
  } catch (secondary) {
    console.warn(
      `executeCredentialCommand: the failed attempt at ${request.command} could not be ` +
        `recorded (${describeFault(secondary)}); the attempt itself failed with ` +
        describeFault(original),
    );
  }
}
