// SPDX-License-Identifier: AGPL-3.0-only
//
// Bringing an installed task type's shared fields forward (SURFACE-R-1).
//
// `installTaskSpine` touches nothing already installed, bar this: a business
// installed before the I09 ruling holds title and state `internal`, and a
// reseed that never looks at them leaves its client reading a shared task as
// `{}`. Kept beside the installer because it is the installer's step, run only
// on its existing-type path.

import type { TenantQuery } from '../tenancy/database.ts';
import { TASK_SPINE } from './spine.ts';

/**
 * The spine fields whose visibility an existing install is brought forward to.
 *
 * Named rather than derived from every declared class, because each is its own
 * ruling: I09 decided a shared task shows its client the title and the status,
 * and a field a later spine declares shared is a later decision about whether
 * installed businesses follow it.
 */
const RECONCILED_VISIBILITY: ReadonlySet<string> = new Set(['title', 'state']);

/**
 * Bring title and state on an installed task type to their declared class.
 *
 * A business installed before 77bcc54 holds both `internal`, because the
 * installer then declared no class and wrote the deny-by-default one, and the
 * installer's early return on an existing type never read its fields again.
 * `visibility_class` is not an immutable column (0004's `field_defs_immutable`
 * names the ones that are), so the row is updated in place. Only the core rows
 * of these two keys on this task type, and only where they differ, so a second
 * call writes nothing and no preset field or other core field is read, let
 * alone rewritten.
 */
export async function reconcileVisibility(tx: TenantQuery, taskTypeId: string): Promise<void> {
  for (const field of TASK_SPINE) {
    if (!RECONCILED_VISIBILITY.has(field.key)) continue;
    // Two rows on one connection inside the caller's transaction.
    // oxlint-disable-next-line no-await-in-loop
    await tx.query(
      `update field_defs set visibility_class = $4
        where business_id = $1 and record_type_id = $2 and key = $3 and origin = 'core'
          and visibility_class is distinct from $4`,
      [tx.businessId, taskTypeId, field.key, field.visibilityClass ?? 'internal'],
    );
  }
}
