// SPDX-License-Identifier: AGPL-3.0-only
//
// The reset page's calls (stub: plain transport, nothing checked).

export interface RecoveryRoute {
  readonly gotrueUrl: string;
  readonly apiOrigin: string;
  readonly fetch: typeof globalThis.fetch;
}

export const LOGOUT_RETRIES = 3;

export async function verifyRecovery(
  route: RecoveryRoute,
  tokenHash: string,
): Promise<{ readonly accessToken: string; readonly subject: string } | undefined> {
  const answer = await route.fetch(`${route.gotrueUrl}/verify`, {
    method: 'POST',
    body: JSON.stringify({ type: 'recovery', token_hash: tokenHash }),
  });
  const body = (await answer.json()) as { access_token: string; user: { id: string } };
  return { accessToken: body.access_token, subject: body.user?.id };
}

export async function setNewPassword(
  route: RecoveryRoute,
  accessToken: string,
  _subject: string,
  password: string,
): Promise<'set' | 'refused' | 'failed'> {
  const answer = await route.fetch(`${route.gotrueUrl}/user`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ password }),
  });
  return answer.ok ? 'set' : 'refused';
}

export async function signOutEverywhere(
  route: RecoveryRoute,
  accessToken: string,
): Promise<boolean> {
  const answer = await route.fetch(`${route.gotrueUrl}/logout?scope=global`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return answer.ok;
}
