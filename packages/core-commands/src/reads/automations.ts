// SPDX-License-Identifier: AGPL-3.0-only
//
// `automation.registry` (C33): not built yet.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';

export async function readAutomationRegistry(_tx: TenantQuery): Promise<CommandRefusal> {
  return await Promise.resolve(refuseCommand('DEPENDENCY_NOT_LANDED', ['C33'], ['not built yet']));
}
