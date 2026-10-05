// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent CLI's small general command set (API-3, CS-15.18, CS-15.19). Its
// named tests come first: no verb is mapped yet, so every line is a usage error.

import type { CliOptions } from './client.ts';
import type { CommandName } from '../../packages/core-wire/src/index.ts';

export interface VerbAnswer {
  readonly exit: number;
  readonly out: string;
}

export interface VerbRow {
  readonly verb: string;
  readonly command: CommandName;
  readonly usage: string;
  readonly body: (
    id: string | undefined,
    flags: Readonly<Record<string, string | true>>,
  ) => Record<string, unknown>;
}

export const VERB_TABLE: readonly VerbRow[] = [];

export function createVerbCli(_options: CliOptions): {
  readonly run: (argv: readonly string[]) => Promise<VerbAnswer>;
} {
  return { run: async () => await Promise.resolve({ exit: 2, out: 'usage: no verbs yet' }) };
}
