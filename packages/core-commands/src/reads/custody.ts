// SPDX-License-Identifier: AGPL-3.0-only
//
// `secret.list` (C31): custody's rows as set or not set, scope and last used.
//
// The rows are filtered by the scopes the caller holds `custody:manage` at,
// inside the statement, in the serving transaction: a business-wide holder
// sees every row, a client-scoped holder that client's rows only, and a
// caller holding the key nowhere is refused rather than shown an empty list.
// No column that could carry a value is selected, and the application role
// could not select one if it tried (0032).

import {
  grantedScopes,
  listSecrets,
  subjectsOf,
  type Session,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type { SecretView } from '../../../core-wire/src/index.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';
import type { ReadResult } from './requests.ts';

export async function listCustodySecrets(
  tx: TenantQuery,
  session: Session,
): Promise<ReadResult | CommandRefusal> {
  const scopes = await grantedScopes(tx, subjectsOf(session), 'custody', 'manage');
  if (scopes.length === 0) {
    return refuseCommand(
      'SCOPE_NOT_GRANTED',
      ['custody:manage'],
      ['no live grant covers it', 'ask a holder who may delegate'],
    );
  }
  const rows = await listSecrets(tx, scopes);
  const secrets: SecretView[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    clientId: row.scope.id,
    state: row.isSet ? 'set' : 'not set',
    setAt: row.setAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revision: row.revision,
  }));
  return { ok: true, secrets };
}
