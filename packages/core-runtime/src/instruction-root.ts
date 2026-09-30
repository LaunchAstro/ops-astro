// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04: the instruction root the plan accept reads from (not built yet).

import type { InstructionSource } from './definitions.ts';

export const INSTRUCTION_ROOT_VARIABLE = 'OPS_ASTRO_INSTRUCTION_ROOT';

export function directorySource(_root: string): InstructionSource {
  throw new Error('directorySource: not built');
}

export function configuredInstructionSource(
  _env: Readonly<Record<string, string | undefined>> = process.env,
): InstructionSource | undefined {
  throw new Error('configuredInstructionSource: not built');
}
