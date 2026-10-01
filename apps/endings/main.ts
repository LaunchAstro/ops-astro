// SPDX-License-Identifier: AGPL-3.0-only
//
// C58's endings loop entry: `pnpm endings [--once]` (ORCH46 ruling B, ORCH47).
// The loop itself is `loop.ts`.

import { main } from './loop.ts';

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env);
