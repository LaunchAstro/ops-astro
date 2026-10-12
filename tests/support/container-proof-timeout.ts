// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's PR #1357 round-two proof lists the suites through a vitest process
// and stops a container, past the 5 s default. It gets the 120 s its review
// ran with here, so the proof keeps its bytes, as capture-chain-timeout.ts
// does for the browser proofs.
import { expect, vi } from 'vitest';

const proofs = ['tests/ci/production-unit-liveness-and-parked-stop.proof.test.ts'];
const path = expect.getState().testPath ?? '';
if (proofs.some((file) => path.endsWith(`/${file}`))) vi.setConfig({ testTimeout: 120_000 });
