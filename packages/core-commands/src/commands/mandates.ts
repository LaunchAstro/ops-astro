// SPDX-License-Identifier: AGPL-3.0-only
//
// Standing mandates and graduation (MP-14-10a): not built yet.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';

const notYet = (): HandlerOutcome =>
  refused(refuseCommand('DEPENDENCY_NOT_LANDED', ['MP-14-10a'], ['not built yet']));

export async function fileMandate(
  _tx: TenantQuery,
  _context: CommandContext,
  _request: object,
): Promise<HandlerOutcome> {
  return await Promise.resolve(notYet());
}
type Handler = typeof fileMandate;
export const revokeStandingMandate: Handler = fileMandate;
export const promoteClass: Handler = fileMandate;
export const demoteClass: Handler = fileMandate;
