// SPDX-License-Identifier: AGPL-3.0-only
//
// The graduation region's one write at a time (MP-14-10a), through
// `useMoneyCommand` since mandate:manage needs a fresh sign-in (C59). An answer
// lost on the way back (`unknown`) keeps its operation, so pressing again with
// the same body is the same attempt and files once. The server stores a
// refusal under its operation too, so a resend after a fresh sign-in is a new
// operation, unless the refused send was such a retry: that operation may have
// applied, so it stays the one sent, and the one kept, until it is answered.
// `drop` withdraws a write held for that sign-in, and its refusal with it; a
// promotion form drops only the write it sent.

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
/**
 * Withdraws a write held for a fresh sign-in, and its refusal with it; given
 * an owner (`promotionOf`), only when that owner sent the write.
 */
export type Drop = (owner?: string) => void;

/** The owner of a promotion form's write, by its class. */
export const promotionOf = (classId: string): string => `promote:${classId}`;

const ownerOf = (name: Change, body: Readonly<Record<string, unknown>>): string | null =>
  name === 'graduation.promote' ? promotionOf(String(body['classId'])) : null;

/** The region's commands, the one write at a time and how a held one is dropped. */
export function useSend(client: OperationsClient, reload: () => void) {
  const command = useMoneyCommand(client);
  const unresolved = useRef<{ readonly key: string; readonly id: string } | null>(null);
  const owner = useRef<string | null>(null);
  const send: Send = (name, body, revision, done) => {
    const key = JSON.stringify([name, body, revision ?? null]);
    const kept = unresolved.current;
    const retry = kept?.key === key;
    let id = retry ? kept.id : client.newOperationId();
    let first = true;
    const attempt = (to: OperationsClient): string => {
      if (!first && !retry) id = to.newOperationId();
      first = false;
      return id;
    };
    const expected = revision === undefined ? {} : { expectedRevision: revision };
    owner.current = ownerOf(name, body);
    command.run(
      (to) => to.mutate(name, body, { ...expected, operationId: attempt(to) }),
      (settlement) => {
        // A retry refused may still have applied: only its answer settles it.
        const open = settlement.kind !== 'ok' && (retry || settlement.kind === 'unknown');
        unresolved.current = open ? { key, id } : null;
        if (settlement.kind === 'ok') {
          owner.current = null;
          done?.();
        }
        reload();
      },
    );
  };
  const drop: Drop = (from) => {
    if (from !== undefined && from !== owner.current) return;
    owner.current = null;
    command.withdraw();
    command.reset();
  };
  return { command, send, drop };
}
