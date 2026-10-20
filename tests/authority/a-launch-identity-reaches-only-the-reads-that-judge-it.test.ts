// SPDX-License-Identifier: AGPL-3.0-only
//
// #1760 (owner, #804): a grant on a Launch's minting identity counts only
// while it is active (#1499). Only the reads that judge that may be asked
// with a Launch's subjects; the compiler refuses them to every other reach
// read, which would count a dormant identity's grants.
import { expect, it } from 'vitest';
import {
  checkAuthority,
  effectiveGrants,
  grantFingerprint,
} from '../../packages/core-records/src/authority/grants.ts';
import type { delegatingSubjects } from '../../packages/core-records/src/authority/delegations.ts';
import { grantedScopes } from '../../packages/core-records/src/authority/grant-reach.ts';
import { heldScopes } from '../../packages/core-records/src/authority/held-scopes.ts';
import { coveredScopes } from '../../packages/core-records/src/authority/covered-scopes.ts';
import {
  readableRecordIds,
  readableScope,
  readableTaskParams,
} from '../../packages/core-records/src/authority/readable-scope.ts';
import { clientsReached } from '../../packages/core-records/src/clients/clients.ts';
import { listSecrets } from '../../packages/core-records/src/custody/secrets.ts';
import { coveredAt } from '../../packages/core-records/src/site/covering.ts';
import { listCoveredCorrections } from '../../packages/core-records/src/site/live-corrections.ts';
import { changesSince } from '../../packages/core-records/src/tasks/changes.ts';
import { readTaskFamily } from '../../packages/core-records/src/tasks/family.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';

/** What a Launch's delegation draws on, its minting identity marked (`delegatingSubjects`). */
type LaunchSubjects = Awaited<ReturnType<typeof delegatingSubjects>>;

it("only the reads that judge whether the launcher identity is active take a Launch's subjects", () => {
  // Compiled, never called: the proof is the type check.
  const request = { collection: 'task', action: 'read' } as const;
  const scope = { ...request, scope: { kind: 'business', id: null } } as const;
  const unjudged = (tx: TenantQuery, drawsOn: LaunchSubjects): readonly unknown[] => [
    // @ts-expect-error -- does not judge the mark
    readableScope(tx, drawsOn, 'task', 'read'),
    // @ts-expect-error -- does not judge the mark
    readableRecordIds(tx, drawsOn, { ...request, recordTypeId: '' }),
    // @ts-expect-error -- does not judge the mark
    readableTaskParams(drawsOn),
    // @ts-expect-error -- does not judge the mark
    grantedScopes(tx, drawsOn, request),
    // @ts-expect-error -- does not judge the mark
    heldScopes(tx, drawsOn, request),
    // @ts-expect-error -- does not judge the mark
    coveredScopes(tx, drawsOn, request),
    // @ts-expect-error -- does not judge the mark
    coveredAt(tx, { subjects: drawsOn, ...request }, null),
    // @ts-expect-error -- does not judge the mark
    clientsReached(tx, drawsOn),
    // @ts-expect-error -- does not judge the mark
    listSecrets(tx, drawsOn),
    // @ts-expect-error -- does not judge the mark
    changesSince(tx, drawsOn, null),
    // @ts-expect-error -- does not judge the mark
    readTaskFamily(tx, '', '', drawsOn),
    // @ts-expect-error -- does not judge the mark
    listCoveredCorrections(tx, drawsOn),
  ];
  const judged = (tx: TenantQuery, drawsOn: LaunchSubjects): readonly unknown[] => [
    effectiveGrants(tx, drawsOn, scope),
    checkAuthority(tx, drawsOn, scope),
    grantFingerprint(tx, drawsOn),
  ];
  expect([unjudged, judged]).toHaveLength(2);
});
