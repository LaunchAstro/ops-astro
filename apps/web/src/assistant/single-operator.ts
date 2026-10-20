// SPDX-License-Identifier: AGPL-3.0-only
//
// R5 (#1781): whether the business is in single-operator mode, for the
// correction card's Launch control. It is the `single_operator_mode` row
// `settings.read` answers, read under the sidebar's business and grant, and
// only while a card offers a decision: a drawer with nothing to decide sends
// nothing more. A reader refused the read, an outage or an answer without the
// row is told nothing about it, and an answer for a business or grant the
// sidebar has left is never drawn; a later refusal withdraws an earlier answer.
// The line is information only: whether a Launch is taken stays the server's.

import { useEffect, useState } from 'react';
import type { SettingsReadResult } from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';

/** On, off, or null where the read did not answer it. */
export function useSingleOperatorMode(
  client: OperationsClient,
  grantKey: string | undefined,
  wanted: boolean,
): boolean | null {
  const owner = JSON.stringify([client.businessKey, grantKey ?? null]);
  const [held, setHeld] = useState<{ readonly owner: string; readonly on: boolean | null } | null>(
    null,
  );
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    const reading = async (): Promise<void> => {
      const result = await client.read<SettingsReadResult>('settings.read', {});
      const rows = 'value' in result ? result.value.settings : undefined;
      const row = Array.isArray(rows)
        ? rows.find((each) => each.key === 'single_operator_mode')
        : undefined;
      // A refusal, an outage or no row withdraws what an earlier answer showed.
      if (current) setHeld({ owner, on: typeof row?.value === 'boolean' ? row.value : null });
    };
    void reading();
    return () => {
      current = false;
    };
    // Read once per owner each time a decision comes to be offered; the client is the owner's.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, wanted]);
  return held !== null && held.owner === owner ? held.on : null;
}
