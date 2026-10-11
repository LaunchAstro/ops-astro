// SPDX-License-Identifier: AGPL-3.0-only
//
// The business settings' one write handler, moved whole from `handlers.ts` for its line cap.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import type { HandlerOutcome } from './outcome.ts';
import type { CommandRequest } from './requests.ts';
import { setBusinessSetting } from './settings-write.ts';

type RequestOf<K extends CommandRequest['command']> = CommandRequest & { readonly command: K };

export function setting(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<
    | 'settings.set_four_eyes_threshold'
    | 'settings.set_client_sign_off'
    | 'settings.set_money_step_up'
    | 'settings.set_conversation_window'
    | 'settings.set_retention_window'
    | 'settings.set_priority_stages'
  >,
): Promise<HandlerOutcome> {
  return setBusinessSetting(tx, context, request.command, request.value, request.expectedRevision);
}
