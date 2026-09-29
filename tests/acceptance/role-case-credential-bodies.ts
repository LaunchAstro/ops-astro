// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipes for API-2's commands, the agent credential,
// beside role-case-bodies.ts to keep that file under the line limit. The admin
// holds `credential:write`, as the owner does, and `task:read` to tick.

import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer } from './world.ts';

type CredentialCommand = Extract<CommandName, 'credential.issue' | 'credential.revoke'>;

/** What these recipes need from the world: `BodyContext`'s person. */
interface CredentialContext {
  asPerson(name: CommandName, body: Readonly<Record<string, unknown>>): Promise<Answer>;
}

/** A body the admin may issue: task read, a day out. */
export const CREDENTIAL_ISSUE = (): Readonly<Record<string, unknown>> => ({
  scope: [{ collection: 'task', action: 'read' }],
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  purpose: 'A made-up credential the matrix issues',
});

export async function credentialBody(
  name: CredentialCommand,
  context: CredentialContext,
): Promise<{ readonly body: Readonly<Record<string, unknown>> }> {
  if (name === 'credential.issue') return { body: CREDENTIAL_ISSUE() };
  // A credential to revoke is the admin's own, issued first.
  const issued = await context.asPerson('credential.issue', CREDENTIAL_ISSUE());
  const detail = (issued.body['detail'] ?? {}) as Readonly<Record<string, unknown>>;
  return { body: { credentialId: detail['credentialId'] } };
}
