// SPDX-License-Identifier: AGPL-3.0-only
//
// API-2: the agent credential in use.
//
// Issuing and revoking a credential are built and proven
// (`api-2-agent-credential.test.ts`, `api-2-agent-credential-revoke.test.ts`).
// Using one needs the bearer-only agent route with no legacy signing secret
// (S0-6), and the CLI cases need the command catalogue's CLI (API-1). Neither
// is on main, so each case is held here by its name until they land. The row
// already keeps the key id the verification will read, and revoking already
// deactivates the agent actor.

import { it } from 'vitest';

it.todo(
  "API-2 revocation next call: a revoked credential's next command is refused in plain words, with no secret in the refusal (LEANS-ON SL01 S0-6)",
);
it.todo(
  'API-2 expiry on the agent route: a credential used one second before its expiry is accepted and one second after is refused in plain words, with no secret in the refusal or the logs (LEANS-ON SL01 S0-6)',
);
it.todo(
  'API-2 actor and person: every command made with the credential records the agent as actor and the person it acts for (LEANS-ON SL01 S0-6)',
);
it.todo(
  "API-2 own scheme: the credential is verified by the product's own scheme and never by the sign-in provider's legacy signing secret (LEANS-ON SL01 S0-6)",
);
it.todo(
  'API-2 bearer only: the credential is accepted only as a bearer token on the agent route, never as or in place of the browser session cookie, and the cookie is refused on the agent route (LEANS-ON SL01 S0-6)',
);
it.todo(
  'API-2 quota: per-credential, per-person and per-business request, concurrency and export limits hold under a burst, with a clear refusal (LEANS-ON SL01 S0-6)',
);
it.todo(
  'API-2 CLI credential.issue: the command line gives the same result and the same refusals as the API (LEANS-ON SL02 API-1)',
);
it.todo(
  'API-2 CLI credential.revoke: the command line gives the same result and the same refusals as the API (LEANS-ON SL02 API-1)',
);
