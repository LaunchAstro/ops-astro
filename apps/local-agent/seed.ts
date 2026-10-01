// SPDX-License-Identifier: AGPL-3.0-only
// LA-1 (#859): stub for the red run.
import type {
  AdminConnection,
  Database,
} from '../../packages/core-records/src/tenancy/database.ts';

export interface LocalIdentity {
  readonly businessId: string;
  readonly agentSubject: string;
  readonly workerActorId: string;
}
export type IdentityRead =
  | { readonly ok: true; readonly identity: LocalIdentity }
  | { readonly ok: false; readonly code: string; readonly message: string };

export function agentSubjectOf(_agents: string, _key: string): string | undefined {
  return undefined;
}
export async function localIdentity(
  _db: { readonly admin: AdminConnection; readonly app: Database },
  _key: string,
  _subject: string,
): Promise<IdentityRead> {
  return { ok: false, code: 'STUB', message: 'stub' };
}
export async function identityFromSeed(
  _env: Readonly<Record<string, string | undefined>>,
): Promise<IdentityRead> {
  return { ok: false, code: 'STUB', message: 'stub' };
}
