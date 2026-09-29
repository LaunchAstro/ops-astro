// SPDX-License-Identifier: AGPL-3.0-only
//
// The key a refused write needed, in one line. A grant refusal does not name
// the key it looked for, so the page names the one the command is declared
// with on the surface, as the CLI's refusal line does (`apps/cli/render.ts`).
// Only for codes about who may act; any other refusal gets nothing added.

import { COMMAND_SURFACE } from '../../../../packages/core-wire/src/index.ts';
import type { CommandName } from '../../../../packages/core-wire/src/index.ts';
import type { WireRefusal } from '../operations/client.ts';

const AUTHORITY = /GRANT|PERMIT|DELEGATION|AUTH|AGENT/u;

export function needsKey(command: CommandName, refusal: WireRefusal | undefined): string | null {
  const row = COMMAND_SURFACE.find((one) => one.name === command);
  return row !== undefined && refusal !== undefined && AUTHORITY.test(refusal.code)
    ? `You need ${row.collection}:${row.action}.`
    : null;
}
