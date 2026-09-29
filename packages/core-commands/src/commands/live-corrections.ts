// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's commands (stub: red run only).

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';

type Of<K extends CommandRequest['command']> = CommandRequest & { readonly command: K };

const notYet = (): Promise<HandlerOutcome> =>
  Promise.resolve(refused(refuseCommand('DEPENDENCY_NOT_LANDED', [], ['stub'])));

export const requestLiveCorrection = (
  _tx: TenantQuery,
  _context: CommandContext,
  _request: Of<'live_correction.request'>,
): Promise<HandlerOutcome> => notYet();

export const approveLiveCorrection = (
  _tx: TenantQuery,
  _context: CommandContext,
  _request: Of<'live_correction.approve'>,
): Promise<HandlerOutcome> => notYet();
