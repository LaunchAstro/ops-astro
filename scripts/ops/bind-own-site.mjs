// SPDX-License-Identifier: AGPL-3.0-only
//
// Bind the business's own site, the command. The decisions are in
// `bind-own-site.ts`; this file runs them.
//
//   node scripts/ops/bind-own-site.mjs
//
// A person's act under operations:manage, with OPS_ASTRO_TOKEN (their own
// sign-in), OPS_ASTRO_BUSINESS (the business acted on), OPS_ASTRO_DEPLOYMENTS
// (the record folder), DATABASE_URL (the application's login),
// DATABASE_ADMIN_URL and GOTRUE_URL set. Exit 0 when bound or already bound,
// 1 when refused. The runbook is scripts/ops/README.md.

import { runBindOwnSite } from './bind-own-site.ts';

const { status, lines } = await runBindOwnSite(process.env);
for (const line of lines) {
  if (status === 0) console.log(line);
  else console.error(line);
}
process.exitCode = status;
