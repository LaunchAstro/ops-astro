// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7: the research skill a research run follows, pinned by digest on the
// run's pinned-versions record. Stub (red).

import { refuseCommand, type CommandRefusal } from './refusal.ts';
import type {
  AdmittedActivation,
  FileIdentity,
  InstructionSource,
} from '../../../core-runtime/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';

/** The vendored skill: its folder, its entry file. */
export const RESEARCH_SKILL = { folder: '.claude/skills/research', entry: 'SKILL.md' } as const;

export type SkillPin =
  | { readonly ok: true; readonly entry: FileIdentity; readonly folderDigest: string }
  | { readonly ok: false; readonly refusal: CommandRefusal };

export async function pinResearchSkill(
  _tx: TenantQuery,
  _activation: AdmittedActivation,
  _pin: {
    readonly runId: string;
    readonly source: InstructionSource;
    readonly files: readonly string[];
    readonly lockedDigest: string;
  },
): Promise<SkillPin> {
  return await Promise.resolve({
    ok: false,
    refusal: refuseCommand('DEFINITION_UNAVAILABLE', [], []),
  });
}
