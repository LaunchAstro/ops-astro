// SPDX-License-Identifier: AGPL-3.0-only
//
// A second sign-in for the P2 proofs: custody's final hold in its own
// process. It answers on IPC only and writes nothing to stdout or stderr.

import { storeSignIn, type SignInAsk } from '../../../packages/core-custody/src/plan-sign-in.ts';
import type { PlanTokens } from '../../../packages/core-custody/src/token-file.ts';

const { file, ask, tokens } = JSON.parse(process.argv[2] ?? '{}') as {
  file: string;
  ask: SignInAsk;
  tokens: PlanTokens;
};
const out = await storeSignIn({ file }, ask, tokens);
await new Promise<void>((resolve) => {
  process.send?.({ answer: out.ok ? 'ok' : out.code }, () => resolve());
});
process.disconnect();
