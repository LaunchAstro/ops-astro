// SPDX-License-Identifier: AGPL-3.0-only
//
// #1918: a pre-check batch is a pull request labelled `precheck-batch` from a branch of this
// repository. With `ci-next` it runs the merge-group set on hosted runners: the database
// conformance shards run, and scripts/ci-scope.ts decides as it does on a merge group. The
// conditions ci.yml writes for it, read by the workflow tests.

/** The label, as scripts/ci-scope.ts reads it. */
export const LABEL = 'precheck-batch';

/** True on a pull request labelled `precheck-batch` whose head is a branch of this repository. */
export const BATCH: string = `contains(github.event.pull_request.labels.*.name, '${LABEL}') && github.event.pull_request.head.repo.full_name == github.repository`;

/** The database conformance shards' condition: every event but a pull request, and a batch. */
export const SHARDS_RUN: string = `github.event_name != 'pull_request' || (${BATCH})`;
