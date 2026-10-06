// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A's four writes as up-to-commit races send them (c52a-approval-at-commit):
// an adoption, a roll back, a turn off and a revocation, each on an activation
// of its own, and how the owner's registry shows the four afterwards.

import { expect } from 'vitest';
import { pinnedFirstOf } from './race-hold.ts';
import { detail, type RegistryWorld } from './registry-world.ts';

/** One write: its activation, the command, and the body sent. */
export type Send = readonly [string, string, Record<string, unknown>];

/** The activation as the owner's registry shows it. */
async function shownOf(w: RegistryWorld, activationId: string) {
  return (await w.registry(w.admin)).definitions
    .flatMap((one) => one.activations)
    .find((one) => one.id === activationId);
}

/** Four activations: one to adopt on, one adopted twice to roll back, one to turn off, one approval to revoke. */
export async function fourCasesOf(w: RegistryWorld): Promise<readonly Send[]> {
  const adoptCase = await pinnedFirstOf(w);
  const backCase = await pinnedFirstOf(w);
  const firstOfBack = (await shownOf(w, backCase.activationId))?.versionId;
  for (const [versionId, expectedRevision] of [
    [firstOfBack, 1],
    [backCase.second, 2],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- one adoption after another
    const one = await w.as(w.admin, 'activation.adopt', {
      activationId: backCase.activationId,
      versionId,
      expectedRevision,
    });
    expect(one.status).toBe(200);
  }
  const offCase = await pinnedFirstOf(w);
  const revokeCase = await pinnedFirstOf(w);
  const adopted = await w.as(w.admin, 'activation.adopt', {
    activationId: revokeCase.activationId,
    versionId: (await shownOf(w, revokeCase.activationId))?.versionId,
    expectedRevision: 1,
  });
  const approvalId = String(detail(adopted)['approvalId']);
  return [
    [
      adoptCase.activationId,
      'activation.adopt',
      { activationId: adoptCase.activationId, versionId: adoptCase.second, expectedRevision: 1 },
    ],
    [
      backCase.activationId,
      'activation.roll_back',
      { activationId: backCase.activationId, expectedRevision: 3 },
    ],
    [
      offCase.activationId,
      'activation.turn_off',
      { activationId: offCase.activationId, expectedRevision: 1 },
    ],
    [revokeCase.activationId, 'approval.revoke', { approvalId }],
  ];
}

/** Each of the four cases as the owner shows it: revision, switch, and whether its approval is revoked. */
export const untouched: readonly (readonly unknown[])[] = [
  [1, true, null],
  [3, true, false],
  [1, true, null],
  [2, true, false],
];

export async function stateIn(
  w: RegistryWorld,
  sends: readonly Send[],
): Promise<readonly (readonly unknown[])[]> {
  const shown = await Promise.all(sends.map(async ([id]) => await shownOf(w, id)));
  return shown.map((one) => [one?.revision, one?.enabled, one?.approval?.revoked ?? null]);
}
