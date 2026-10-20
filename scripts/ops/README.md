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

## Fill a business with demo data, and take it out again

The step is `demo-data.mjs` (plan in `demo-data-plan.ts`, safeguards in
`demo-data-checks.ts`, removal in `demo-data-remove.ts`). It needs the grants
its commands are declared with, and checks them before it writes. It makes
three made-up clients, a `Demo` tag, fourteen tasks across every state
(new, planned, waiting on review, accepted, in progress, waiting on client,
on hold and done) with comments, three plans played back for review, and
three side-chat threads. Every name starts `Demo `, every address is
example.com or .test, and nothing is assigned, launched, invited, mentioned
or sent to a model.

1. Sign in as yourself with the command line's `login`, as above.
2. Set `OPS_ASTRO_TOKEN` (that bearer), `OPS_ASTRO_API` (the app's address)
   and `OPS_ASTRO_BUSINESS`. Leave `OPS_ASTRO_AGENT` and
   `OPS_ASTRO_DELEGATION` unset.
3. Run `node scripts/ops/demo-data.mjs seed <manifest.json>`. The manifest
   lists every id the run made, and holds no credential. Running it again
   with the same manifest carries on and makes nothing twice.
4. To take it out, run `node scripts/ops/demo-data.mjs remove <manifest.json>`.
   It reads every task the manifest lists, stops before any change if one is no
   longer the demo task it made, then trashes them. The clients, the tag and
   the threads stay, named Demo: no command removes them yet (#2209).
