// SPDX-License-Identifier: AGPL-3.0-only
//
// The graduation region's one write at a time (MP-14-10a), through
// `useMoneyCommand` since mandate:manage needs a fresh sign-in (C59). An answer
// lost on the way back (`unknown`) keeps its operation, so pressing again with
// the same body is the same attempt and files once; a resend after a fresh
// sign-in is a new attempt. `drop` withdraws a write held for that sign-in,
// and its refusal with it.

import { useRef } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import { useMoneyCommand } from '../../records/use-money-command.ts';

type Change = 'mandate.file' | 'mandate.revoke' | 'graduation.promote' | 'graduation.demote';
export type Send = (
  name: Change,
  body: Readonly<Record<string, unknown>>,
  revision?: number,
  done?: () => void,
) => void;
/** Withdraws a write held for a fresh sign-in, and its refusal with it. */
export type Drop = () => void;

/** The region's commands, the one write at a time and how a held one is dropped. */
export function useSend(client: OperationsClient, reload: () => void) {
  const command = useMoneyCommand(client);
  const unresolved = useRef<{ readonly key: string; readonly id: string } | null>(null);
  const send: Send = (name, body, revision, done) => {
    const key = JSON.stringify([name, body, revision ?? null]);
    let id = unresolved.current?.key === key ? unresolved.current.id : client.newOperationId();
    let first = true;
    const attempt = (to: OperationsClient): string => {
      if (!first) id = to.newOperationId();
      first = false;
      return id;
    };
    const expected = revision === undefined ? {} : { expectedRevision: revision };
    command.run(
      (to) => to.mutate(name, body, { ...expected, operationId: attempt(to) }),
      (settlement) => {
        unresolved.current = settlement.kind === 'unknown' ? { key, id } : null;
        if (settlement.kind === 'ok') done?.();
        reload();
      },
    );
  };
  const drop: Drop = () => {
    command.withdraw();
    command.reset();
  };
  return { command, send, drop };
}
