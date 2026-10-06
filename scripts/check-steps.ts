// SPDX-License-Identifier: AGPL-3.0-only
// The steps `pnpm check` runs (scripts/check.mjs), in order: [script, label,
// light]. scripts/ci-shards.ts reads them too, to split the `local checks`
// shards, so they sit apart from the script that runs them.

/** [script, label] or, for the step a pull request narrows, [script, label, 'changed']. */
export const STEPS: readonly (readonly [string, string] | readonly [string, string, 'changed'])[] =
  [
    ['brand:check', 'product name headings'],
    ['brand:cases', 'the actual product name CLI'],
    ['typecheck', 'types'],
    ['lint', 'lint'],
    ['lint:ratchet', 'no new lint warning, no product source file over 1,000 lines'],
    ['format:check', 'format'],
    ['build', 'build'],
    ['test', 'tests', 'changed'],
    ['gate:selftest', 'the gate proves itself'],
    ['gate:cases', 'the gate catches what it must'],
    ['gate:hooks', 'the hook handles every exit code'],
    ['commits:cases', 'commit messages and provenance'],
    ['migrations:cases', 'a changed applied migration fails'],
    ['provenance:cases', 'the actual commit message hook'],
    ['candidate:cases', 'candidate snapshots and public-content cases'],
    ['public:history:cases', 'public policy on outgoing history and metadata'],
    ['size:cases', 'the size report measures and never blocks'],
    ['review:cases', 'review evidence binds to a revision'],
    ['session:cases', 'the session check reads a scope correctly'],
    ['pins:cases', 'pins-check refuses an unpinned action, image or container'],
    ['pins', 'actions pinned and recorded'],
    ['skills:refs', 'every skill reference resolves'],
    ['merge:policy', 'nothing merges itself'],
    ['gate', 'the gate sweeps'],
    ['secrets', 'secrets, over the working tree'],
    ['public:content:tree', 'public content policy, over the working tree'],
    ['licences:cases', 'the licence checker refuses what it must'],
    ['licences', 'licence compatibility'],
    ['type:census', 'every text style on the declared scale'],
    ['spdx:cases', 'source licence header rejection cases'],
    ['spdx', 'source licence headers'],
    ['deps:cases', 'the dependency cruise refuses a cruise that read nothing'],
    ['deps:cruise', 'structural dependency rules'],
    ['db:cases', 'the database gate refuses a skip, a missing suite and an empty run'],
    ['local:cases', 'the local scripts never reuse a database on another major'],
  ];
