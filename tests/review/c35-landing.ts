// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's worker calls under a lease (#2011): the claim, the land, and reads of what landed.

import { randomUUID } from 'node:crypto';
import { PAGE, type C35World, type Lease } from './c35-world.ts';
import type { Member } from '../commands/fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';

type Body = Readonly<Record<string, unknown>>;

/** A page observation as the fenced capture makes it. */
export const observationOf = (width: number): Readonly<Record<string, unknown>> => ({
  url: PAGE,
  documentDigest: `sha256:${'a'.repeat(64)}`,
  text: `About us, seen ${String(width)} wide.`,
  html: `<main><h1>About</h1><p>${String(width)}</p></main>`,
  status: 200,
  stylesheets: { 'https://agency.example/site.css': `sha256:${'b'.repeat(64)}` },
});

/** A picture's bytes, distinct per `seed`. */
export const pictureBytes = (seed: number, length = 2_048): Buffer =>
  Buffer.alloc(length, seed % 256);

/** The agent's login, as `executeAgentCommand` is handed it. */
export const agentLogin = (w: C35World): VerifiedSubject => ({
  provider: 'supabase',
  subject: w.world.agentSubject(),
});

/** One worker call under `lease`, on `database` (the world's own pool unless given). */
export async function underLease(
  w: C35World,
  lease: Lease,
  body: Body,
  database: Database = w.world.db.app,
): Promise<{ readonly operationId: string; readonly result: CommandResult }> {
  const operationId = randomUUID();
  const result = (await executeAgentCommand(
    database,
    w.world.business,
    agentLogin(w),
    lease.credential,
    { operationId, leaseId: lease.leaseId, fence: lease.fence, ...body } as never,
  )) as CommandResult;
  return { operationId, result };
}

export const claimUnder = async (
  w: C35World,
  lease: Lease,
  revisionId: string,
  database?: Database,
): Promise<CommandResult> =>
  (await underLease(w, lease, { command: 'review.capture_claim', revisionId }, database)).result;

/** The land of one width's picture and observation, with the operation it went under. */
export const landUnder = async (
  w: C35World,
  lease: Lease,
  at: {
    readonly revisionId: string;
    readonly width: number;
    readonly picture: Uint8Array;
    readonly observation?: Readonly<Record<string, unknown>>;
  },
): Promise<{ readonly operationId: string; readonly result: CommandResult }> =>
  await underLease(w, lease, {
    command: 'review.capture_land',
    revisionId: at.revisionId,
    width: at.width,
    picture: Buffer.from(at.picture).toString('base64'),
    observation: at.observation ?? observationOf(at.width),
  });

/** `review.picture`, as `member` reads it in `business`. */
export const readPicture = async (
  w: C35World,
  member: Member,
  pictureId: unknown,
  business: string = w.world.business,
): ReturnType<typeof executeRead> =>
  await executeRead(w.world.db.app, business, member.presented, {
    read: 'review.picture',
    pictureId,
  } as never);

/** Stored objects in `business`, counted as the administrator sees them. */
export const storedObjects = async (w: C35World, business: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from public.storage_objects where business_id = $1',
        [business],
      )
    )[0]?.n,
  );

/** A revision's captures as stored, widest first. */
export interface StoredCapture {
  readonly width: number;
  readonly state: string;
  readonly lease_id: string | null;
  readonly picture_id: string | null;
  readonly picture_digest: string | null;
}

/** A plain array, so `toStrictEqual` against a literal compares the rows, not the driver's result type. */
export const capturesOf = async (
  w: C35World,
  revisionId: string,
): Promise<readonly StoredCapture[]> => [
  ...(await w.world.db.admin.execute<StoredCapture>(
    `select width, state, lease_id, picture_id, picture_digest from public.review_captures
      where revision_id = $1 order by width desc`,
    [revisionId],
  )),
];
