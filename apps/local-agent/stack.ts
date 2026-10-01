// SPDX-License-Identifier: AGPL-3.0-only
// LA-1 (#859): the one-command local stack (stub; red).
import type { Runner } from './runner.ts';

export interface Stack {
  readonly home: string;
  readonly runner: Runner;
  readonly credentialsFile: string;
  readonly apiEnvFile: string;
  close(): Promise<void>;
}

export type StackStart =
  | { readonly ok: true; readonly stack: Stack }
  | { readonly ok: false; readonly code: string; readonly message: string };

export function readApiEnv(_text: string): Record<string, string> {
  return {};
}

export async function startStack(
  _env: Readonly<Record<string, string | undefined>>,
  _userHome?: string,
  _print?: (line: string) => void,
): Promise<StackStart> {
  return await Promise.resolve({ ok: false, code: 'NOT_BUILT', message: 'not built' });
}
