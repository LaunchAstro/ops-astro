// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01's closed list of product network sites, read by case 10 of
// `aw-01-egress.test.ts`. Apart from it to keep that file under the line limit.

/**
 * Every place product code may touch the network, and why. A new one is a
 * reviewed line here, never a quiet import.
 */
export const NETWORK_SITES: Readonly<Record<string, string>> = {
  'packages/core-custody/src/egress.ts': 'the one outbound path of a model call',
  'packages/core-custody/src/custody.ts': "starts custody's own process",
  'packages/core-connectors/src/replay.ts':
    'the replay stand-in listens on loopback; it calls nothing',
  'packages/core-connectors/src/replay-faults.ts':
    "the replay stand-in's faults end its own loopback response's socket; it calls nothing",
  'packages/core-connectors/src/email-fake.ts':
    'the fake email provider listens on loopback; it calls nothing (AW-07b)',
  'apps/api/server.ts': "the API serves its own routes on loopback; `app.fetch` is Hono's handler",
  'apps/web/src/main.tsx': "the browser's own fetch, bound once at the composition root",
  'apps/web/src/App.tsx': "threads that fetch to the product's own API, same origin",
  'apps/web/src/app-props.ts': 'declares the type of the fetch App.tsx threads; it calls nothing',
  'apps/web/src/session/use-signed-in.ts':
    "threads that fetch to the held-address offer, the product's own API",
  'apps/web/src/screens/SignIn.tsx': "threads that fetch to the product's own sign-in route",
  'apps/web/src/screens/Enrol.tsx': "sends a link's token to the product's own enrol route",
  // Main's core after the slice's base (rebase onto 8eba5e6):
  'apps/cli/client.ts':
    "the CLI's and the worker's one transport to the product's own API (T2b), and sign-in fetch",
  'apps/api/identity.ts':
    'runs the local git once at process start to read its own checkout (T4); no network',
  'apps/web/src/operations/client.ts': "the browser calls the product's own API, same origin",
  'apps/web/src/session/sign-in.ts':
    "the browser signs in through the product's own API, same origin",
  'apps/web/src/session/password-grant.ts': 'the password grant, to the sign-in provider only',
  'apps/web/src/session/sign-in-again.ts':
    'signs out, at the sign-in provider, a new session the tab never adopted (C59)',
  // Batch 1's, taken at 5d3e129 (reviewed there):
  'apps/api/auth/jwks.ts':
    "reads the sign-in provider's published key set at its pinned address (S0-6b)",
  'apps/api/auth/supabase.ts': 'threads that key-set fetch to the verifier; it calls nothing',
  'apps/api/function.ts': "the hosted function hands each request to the API's own handler",
  'apps/web/build-stamp.ts': 'runs the local git once at build time to stamp the build; no network',
  'apps/web/src/held-address.tsx': "threads the page's fetch to the product's own API",
  'apps/local-agent/codex.ts': 'LA-1, laptop only: spawns `codex`, which calls its vendor',
  'apps/local-agent/runner.ts': "LA-1, laptop only: listens on loopback for custody's dispatch",
  // C80: not a model call, so not through custody's broker. Whether its
  // provider calls should leave through custody instead is open for Sol.
  'packages/core-connectors/src/capture/transport.ts':
    "C80's pinned HTTPS transport: only to an address already checked, no redirect",
  // Main's, taken at the a352c11 join (reviewed in batch 2):
  'apps/api/auth/factors.ts':
    "the sign-in provider's second-factor calls at its one fixed address (C59)",
  'apps/api/auth/logins.ts': "the sign-in provider's admin calls for an ended login (C58)",
  'apps/api/auth/provider-logins.ts':
    "names the `https` issuer C58's admin key is for; it calls nothing (a comment's word)",
  'apps/api/health/tracing.ts': "reads the tracing service's public health route (C34)",
  'apps/web/src/screen-registry.tsx':
    "threads the page's fetch to the public legal page's reader, same origin (C81)",
  // Password reset on the sign-in provider's recovery session (20261013060059):
  'apps/api/auth/provider-user.ts':
    "the sign-in provider's `/user` on a person's own bearer (the reset's read and password write, the door's session probe), at its issuer's origin, no redirect",
  'apps/api/password-reset.ts':
    "threads an injected fetch to `provider-user.ts`'s calls on the reset's own bearer",
  'apps/web/src/screens/Reset.tsx': "threads the page's fetch to the reset's calls",
  'apps/web/src/session/recovery.ts':
    "the reset page's calls: the sign-in provider's recovery session and the product's own reset routes, no redirect",
};
