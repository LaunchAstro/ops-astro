// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7: the research skill a research run follows, pinned by digest. Stub (red).

import {
  refuse,
  type AdmittedActivation,
  type FileIdentity,
  type InstructionSource,
  type RuntimeResult,
} from '../../../core-runtime/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';

export const RESEARCH_SKILL = {
  folder: '.claude/skills/research',
  entry: 'SKILL.md',
  digest: 'c8c1cba327a6f824b554cd978079a3dadd7406d73174f8fb9bfef58824691970',
} as const;

export async function pinResearchSkill(
  _tx: TenantQuery,
  _activation: AdmittedActivation,
  _pin: {
    readonly runId: string;
    readonly source: InstructionSource;
    readonly files: readonly string[];
  },
): Promise<RuntimeResult<FileIdentity>> {
  return await Promise.resolve(refuse('DEFINITION_UNAVAILABLE', 'stub', 'stub'));
}
