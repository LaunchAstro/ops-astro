// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent CLI's small general command set (API-3). Not built yet: the
// named tests in `tests/cli/api-3*.test.ts` come first.

import type { CliOptions } from './client.ts';
import type { CommandName } from '../../packages/core-wire/src/index.ts';

export interface VerbAnswer {
  readonly exit: number;
  readonly out: string;
}

export interface VerbRow {
  readonly verb: string;
  readonly command: CommandName;
}

export const VERB_TABLE: readonly VerbRow[] = [];

export function createVerbCli(_options: CliOptions): {
  readonly run: (argv: readonly string[]) => Promise<VerbAnswer>;
} {
  return { run: async () => await Promise.resolve({ exit: 4, out: 'not built' }) };
}
