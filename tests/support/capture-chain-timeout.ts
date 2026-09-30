// SPDX-License-Identifier: AGPL-3.0-only
//
// The browser-capture proof and the proofs that run it, nested up to three
// runs deep, each run the real named page capture: past the 5 s default. A
// longer timeout here keeps Sol's proofs byte-for-byte (ORCH45, REVB1ENDFIXWEBC).

import { expect, vi } from 'vitest';

const captureChain = [
  'harness-capture-needs-browser',
  'browser-proof-coloured-summary',
  'coloured-browser-summary-recognises-named-capture',
  'coloured-summary-fails-without-named-capture',
  'coloured-summary-rejects-failed-capture',
  'coloured-summary-rejects-mixed-capture-failure',
];

const path = expect.getState().testPath ?? '';
if (captureChain.some((name) => path.endsWith(`/tests/visual/${name}.test.ts`))) {
  vi.setConfig({ testTimeout: 120_000 });
}
