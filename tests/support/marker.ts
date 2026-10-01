// SPDX-License-Identifier: AGPL-3.0-only
//
// The one marker every test-only sign-in value carries (the owner's option A,
// 30 Sep 2026): a value is this marker and random bytes made at run time, so no
// test value exists anywhere to copy, and the bundle scanner
// (`tests/ci/fixture-bundle.ts`) refuses any built file that carries it.

export const TEST_ONLY_MARKER = 'ops-astro-test-only';
