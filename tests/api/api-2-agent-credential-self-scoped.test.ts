// SPDX-License-Identifier: AGPL-3.0-only
//
// API-2: `credential:write` is self-scoped. Every signed-in person holds it on
// their own credentials and nobody grants it (`core-wire/src/permission-keys.ts`;
// ops-astro-roadmap `CAPABILITY-SLICES.md`, the `credential:write` row), and
// `access.grant` refuses the credential collection. So a member who holds task
// keys and no grant on `credential` still issues a credential no wider than
// their own grants. The world is `api-2-agent-credential-world.ts`, where Mia
// holds alpha's member keys on `task` and nothing on `credential`.

import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { harness, issue, issueBody, openWorld } from './api-2-agent-credential-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'api/api-2-agent-credential-self-scoped: DATABASE_URL is unset, so nothing below ran.',
  );
}

openWorld();

describe.skipIf(serverUrl === undefined)('API-2 credential:write is self-scoped', () => {
  it('API-2 self-scoped: a member with no credential grant issues a credential inside their own task:read', async () => {
    const answer = await issue(
      issueBody({ scope: [{ collection: 'task', action: 'read' }] }),
      harness.world.mia.token,
    );
    expect(answer.status, `${answer.code ?? ''}`).toBe(200);
  });
});
