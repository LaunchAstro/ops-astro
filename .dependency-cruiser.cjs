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
      to: { path: '^packages/core-(runtime|commands|wire|digest|connectors)/' },
    },
    {
      name: 'layer-connectors-take-the-digest-only',
      severity: 'error',
      comment:
        'Provider operations sit beside the runtime, called by the command package once a ' +
        'gate has passed. They take the payload digest and nothing else of the product, so ' +
        'no path from them reaches a record, a grant or a command.',
      from: { path: '^packages/core-connectors/' },
      to: { path: '^packages/', pathNot: '^packages/core-(connectors|digest)/' },
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
