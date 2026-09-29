// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody's two writes (C31). Not yet built: both refuse.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';

const NOT_BUILT = ['Custody is not built on this head.'];

export async function setCustodySecret(
  _tx: TenantQuery,
  _context: CommandContext,
  _request: { readonly name: string; readonly value: unknown },
): Promise<HandlerOutcome> {
  return await Promise.resolve(
    refused(refuseCommand('DEPENDENCY_NOT_LANDED', ['secret.set'], NOT_BUILT)),
  );
}

export async function clearCustodySecret(
  _tx: TenantQuery,
  _context: CommandContext,
  _request: { readonly secretId: string },
): Promise<HandlerOutcome> {
  return await Promise.resolve(
    refused(refuseCommand('DEPENDENCY_NOT_LANDED', ['secret.clear'], NOT_BUILT)),
  );
}
