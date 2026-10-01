// SPDX-License-Identifier: AGPL-3.0-only
// Structural dependency rules, checked.
//
// Item 9 of the PG0 product ticket. The rules are the ones that are true of
// this tree today and that a person would otherwise have to notice in review.
//
// Read scripts/deps-cruise.mjs before changing the scope below. This
// configuration is run through that script and not through `depcruise`
// directly, because dependency-cruiser 18.4.0 exits 0 after cruising nothing
// at all, and a gate that passes when it read no files is not a gate.
//
// `parser: 'swc'` is load-bearing. dependency-cruiser 18.4.0 supports
// `typescript >=2.0.0 <7.0.0` and this tree pins typescript 7.0.2, so its
// default TypeScript path reads no .ts file here and says nothing about it.
// @swc/core parses TypeScript without the TypeScript compiler, so the whole
// configured tree is read, and a file it cannot parse stops the cruise with
// an error rather than being skipped.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A cycle has no entry point, so it cannot be read, tested or replaced one part ' +
        'at a time. Break it with a module both sides depend on.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-scripts-to-tests',
      severity: 'error',
      comment:
        'The checks are what the tests are run against. A check that imports a test ' +
        'fixture proves the fixture, not the tree.',
      from: { path: '^scripts/' },
      to: { path: '^tests/' },
    },
    {
      name: 'no-orphan-checks',
      severity: 'error',
      comment:
        'Every module under scripts/ is either reachable from another module or is run ' +
        'by a pnpm script. One that is neither is dead code wearing a gate badge.',
      from: { path: '^scripts/.+\\.mjs$', orphan: true },
      to: {},
    },
    {
      name: 'layer-records-is-the-bottom',
      severity: 'error',
      comment:
        'The packages are layered: records at the bottom, the runtime on it, the command ' +
        'package on both, and the apps on top. The wire contract and the payload digest are ' +
        'leaves beside them. Records imports none of the others.',
      from: { path: '^packages/core-records/' },
      to: { path: '^packages/core-(runtime|commands|wire|digest)/' },
    },
    {
      name: 'layer-runtime-below-commands',
      severity: 'error',
      comment: 'The runtime sits under the command package and never imports it.',
      from: { path: '^packages/core-runtime/' },
      to: { path: '^packages/core-commands/' },
    },
    {
      name: 'layer-wire-and-digest-are-leaves',
      severity: 'error',
      comment:
        'The web and the command line load the wire contract and the digest, so neither ' +
        'may reach the runtime or the command package. The wire contract takes records ' +
        'types only; the digest imports nothing of the product.',
      from: { path: '^packages/core-(wire|digest)/' },
      to: { path: '^packages/core-(runtime|commands)/' },
    },
    {
      name: 'layer-digest-imports-no-package',
      severity: 'error',
      comment: 'The digest is a leaf: it imports no other package.',
      from: { path: '^packages/core-digest/' },
      to: { path: '^packages/', pathNot: '^packages/core-digest/' },
    },
    {
      name: 'custody-process-imports-no-package',
      severity: 'error',
      comment:
        "Custody's process holds every provider credential, so adapter, connector and " +
        'database code never load in it (AW-01): its entry and the two modules it runs on ' +
        'import no other package.',
      from: { path: '^packages/core-custody/src/(custody-main|egress|credentials)\\.ts$' },
      to: { path: '^packages/', pathNot: '^packages/core-custody/' },
    },
    {
      name: 'connectors-are-a-leaf',
      severity: 'error',
      comment:
        'Provider operations say what a call is, what it may carry and to where. They hold ' +
        'no credential and open no connection, so they import no other package.',
      from: { path: '^packages/core-connectors/' },
      to: { path: '^packages/', pathNot: '^packages/core-connectors/' },
    },
    {
      name: 'index-only',
      severity: 'error',
      comment:
        "An app or package enters another package only through that package's index.ts, " +
        'stylesheets included, with no exception. Tests and scripts prove modules, not the interface, and may reach in.',
      from: { path: '^((?:apps|packages)/[^/]+)/' },
      to: {
        path: '^packages/[^/]+/src/',
        pathNot: ['^$1/', '^packages/[^/]+/src/index\\.ts$'],
      },
    },
    {
      name: 'worker-holds-no-database',
      severity: 'error',
      comment:
        'The worker is a client of the API and never connects (T2b, spike RN-04): neither it ' +
        'nor the command-line client it posts through imports a database package, the API or ' +
        'a Postgres driver. tests/worker/worker-boundary.test.ts walks the whole graph.',
      from: { path: '^apps/(worker/|cli/client\\.ts$)' },
      to: {
        path: ['^packages/core-(records|runtime|commands)/', '^apps/api/', '(^|/)(postgres|pg)/'],
      },
    },
    {
      name: 'pre-review-attribution-stays-in-its-read',
      severity: 'error',
      comment:
        'AW-04: attribution by digest is pre-review. It may floor a declaration of reach and ' +
        'nothing else, so no evaluation set, promotion input or conformance claim takes it: ' +
        'only its catalogue row loads the read.',
      from: {
        path: '^(apps|packages)/',
        pathNot: '^packages/core-commands/src/reads/(attribution|catalogue)\\.ts$',
      },
      to: { path: '^packages/core-commands/src/reads/attribution\\.ts$' },
    },
    {
      name: 'shippable-never-reaches-tests',
      severity: 'error',
      comment:
        'Test fixtures, the declining usage reporter first (specification 12.3), are for a ' +
        'test build only. Nothing under apps/ or packages/ imports from tests/.',
      from: { path: '^(apps|packages)/' },
      to: { path: '^tests/' },
    },
    {
      name: 'fixture-reporter-is-test-only',
      severity: 'error',
      comment:
        'T3b: the second, independent barrier. The declining usage reporter drives ' +
        'liability_unknown in tests, so it is named on its own: only a module under tests/ ' +
        'may import it, and relaxing the rule above does not open it. ' +
        'tests/runtime/t3b-shipped-graph.test.ts deletes that rule and plants the import.',
      from: { pathNot: '^tests/' },
      to: { path: '^tests/support/declining-reporter\\.ts$' },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment: 'An import that does not resolve is a module that was never read.',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    parser: 'swc',
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      mainFields: ['module', 'main'],
    },
    exclude: { path: '(^|/)node_modules/' },
    // The orphan rule needs the pnpm scripts' entry points to count as reachable.
    // They are, because every one of them is named in package.json and the
    // runner passes them in as cruise targets.
    reporterOptions: { text: { highlightFocused: true } },
  },
};
