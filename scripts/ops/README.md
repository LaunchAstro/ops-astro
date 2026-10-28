<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Operator steps

Steps an operator runs by hand, each as a person of the business holding
`operations:manage` over all of it. Each section is a runbook entry for the
owner.

## Bind agencyastro.com's About page to Agency Astro

The step is `bind-own-site.mjs` (decisions in `bind-own-site.ts`). It binds
Agency Astro's own site to the business itself, with no client:

- repository `launchastro/agency-astro-astro`, branch `main`;
- Vercel project `prj_ZP8jeokQCN6SJsyuzkz4ISihdlHm`, host `agencyastro.com`;
- the page `https://agencyastro.com/about`, which maps to `src/pages/about.astro`.

It writes nothing else. A second run changes nothing and prints the same
revision. Run it on staging first, then on production, in daylight, after the
deploy that carries the own-site migration (`20261018020000_own_business_site`).

1. Sign in as yourself with the command line's `login` (docs/local/CLI.md),
   so your bearer is in your own token file. Never paste it into a chat or a
   ticket.
2. In a terminal on the M5, in a clean checkout of `main`, set:
   - `OPS_ASTRO_TOKEN`: that bearer, read from your token file, never an agent's;
   - `OPS_ASTRO_BUSINESS`: Agency Astro's business key;
   - `OPS_ASTRO_DEPLOYMENTS`: the deployment record folder;
   - `DATABASE_URL`: the application's login (`ops_astro_app`), never the owner's;
   - `DATABASE_ADMIN_URL` and `GOTRUE_URL`: as for the other operator steps.

   Leave `OPS_ASTRO_AGENT` and `OPS_ASTRO_DELEGATION` unset.

3. Run `node scripts/ops/bind-own-site.mjs`.
4. Check it printed `bound launchastro/agency-astro-astro`, the page line and
   `stored revision N`. A first run says `written`; any later run says
   `unchanged: nothing written`. A line starting `REFUSED` wrote nothing: read
   the reason, fix it, and run again.
5. Copy the `stored revision N` line onto the parent ticket (#1686) as the
   production record. The same revision is in the deployment record folder,
   under `act: own-site.bind`.
6. The capture pool is not in the database. The step prints its entry as
   `capture pool agencyPages entry "https://agencyastro.com/about"`. Give the
   site runner's `CapturePool.agencyPages` exactly that address: no trailing
   slash, since `/about/` answers 308 and the capture refuses redirects.

## The nightly parts run on the M5

`nightly-parts.sh` runs the suites `tests/db/shard-plan.json` splits into parts
on `main`'s head at 02:00 (#2302), each through `scripts/db-conformance.mjs` on
its own throwaway Postgres, once the M5's load is under 27 and a gate slot in
`~/.oa-gate-slots` is free. A red suite opens one `nightly-parts` issue, or
comments on the one open for it, as the plist's `NIGHTLY_GH_USER`. Logs:
`~/Library/Logs/ops-astro-nightly-parts/<date>.log`. To install on the M5, copy
the script outside any checkout (to
`~/Library/Application Support/ops-astro-nightly-parts/`), fill the plist's
`@...@` fields into `~/Library/LaunchAgents/`, then
`launchctl bootstrap gui/501 <plist>`: through `gui/501`, never bare ssh, since
only there does `gh` reach the keychain.
