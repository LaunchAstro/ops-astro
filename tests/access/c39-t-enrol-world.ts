// SPDX-License-Identifier: AGPL-3.0-only
//
// The enrolment cases' world (C39-T, piece P3), over the invitation world:
// custody again, holding the mail key and the login provider's made-up
// service key for the `auth` destination, the stand-in admin users route on
// loopback (`c39-t-users-fake.ts`), taking no POST but the listed create and
// the one PUT update route, as C40's destination does, and a broker that catalogues `auth.create_user` and
// `auth.update_user` beside `email.send`, as a deployment with the login
// provider configured has. The route is mounted the way the hooks are, on
// its own app, over the deployment's businesses alpha and bravo.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll } from 'vitest';
import { mountEnrolment } from '../../apps/api/enrolment.ts';
import { ENROL_PATH } from '../../packages/core-wire/src/index.ts';
import {
  AUTH_CREATE_USER,
  AUTH_UPDATE_USER,
  authUserAdapter,
  authUserUpdateAdapter,
  catalogue,
  emailAdapter,
} from '../../packages/core-connectors/src/index.ts';
import { startCustody } from '../../packages/core-custody/src/index.ts';
import { TEST_EMAIL_SEND } from '../broker/email-world.ts';
import { mailTo } from './c39-t-hook-world.ts';
import { startFakeUsers, type FakeUsers } from './c39-t-users-fake.ts';
import type { Member } from '../commands/fixture.ts';
import { invite, linkIn, send, useInvitationWorld, w } from './c39-t-world.ts';

/** A short timeout, so a slow provider ends quickly. */
const TEST_CREATE_USER = { ...AUTH_CREATE_USER, timeoutMs: 600 };
const TEST_UPDATE_USER = { ...AUTH_UPDATE_USER, timeoutMs: 600 };

export const e = {} as { users: FakeUsers; key: string; folder: string; app: Hono };

const route = (key: string, provider: string, credentialRef: string): object => ({
  key,
  reach: 'cloud',
  provider,
  credentialRef,
  credentialKind: 'api_key',
  installation: 'here',
  ceiling: 4,
});

/** Custody again, holding both keys, the broker over it, and the route over the world. */
async function withUsers(): Promise<void> {
  e.users = await startFakeUsers();
  e.folder = mkdtempSync(join(tmpdir(), 'c39t-enrol-'));
  e.key = `servicekey-${randomBytes(18).toString('hex')}`;
  const credentialsFile = join(e.folder, 'credentials.json');
  const held = { kind: 'api_key', header: 'authorization' };
  const credentials = [
    { ref: 'email_key', destination: 'email', account: 'mail-1', value: w.key, ...held },
    { ref: 'auth_key', destination: 'auth', account: 'auth-1', value: e.key, ...held },
  ];
  writeFileSync(credentialsFile, JSON.stringify(credentials), { mode: 0o600 });
  await w.custody.stop();
  w.custody = await startCustody({
    credentialsFile,
    destinations: [
      { key: 'email', origin: w.provider.origin },
      {
        key: 'auth',
        origin: e.users.origin,
        post: false,
        routes: [
          { method: 'POST', path: '/auth/v1/admin/users' },
          { method: 'PUT', path: '/auth/v1/admin/users/*' },
        ],
      },
    ],
  });
  w.broker = {
    ...w.broker,
    custody: w.custody,
    operations: catalogue([TEST_EMAIL_SEND, TEST_CREATE_USER, TEST_UPDATE_USER]),
    providers: new Map([
      ['resend', { build: emailAdapter, price: () => 0 }],
      ['supabase_auth', { build: authUserAdapter, price: () => 0 }],
      ['supabase_auth_update', { build: authUserUpdateAdapter, price: () => 0 }],
    ]),
    routes: [
      route('email', 'resend', 'email_key'),
      route('auth', 'supabase_auth', 'auth_key'),
      route('auth_update', 'supabase_auth_update', 'auth_key'),
    ] as typeof w.broker.routes,
  };
  e.app = mountOver([w.alpha, w.bravo]);
}

/** The route on its own app, over the businesses named. */
export function mountOver(businesses: readonly string[]): Hono {
  const app = new Hono();
  mountEnrolment(app, w.db.app, {
    businesses: async () => await Promise.resolve(businesses),
    broker: w.broker,
  });
  return app;
}

/** The invitation world, then the login provider's users route and the enrolment route. */
export function useEnrolWorld(): void {
  useInvitationWorld();
  beforeAll(withUsers, 120_000);
  afterAll(async () => {
    await e.users?.close();
    if (e.folder !== undefined) rmSync(e.folder, { recursive: true, force: true });
  });
}

/** A password of the length the page asks for, unique to the case. */
export const passwordFor = (): string => `pw-${randomBytes(12).toString('hex')}`;

export interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly cookie: string | null;
}

/** POST the token and password to the route, as the enrolment page does. */
export async function enrolVia(
  token: string,
  password: string = passwordFor(),
  app: Hono = e.app,
): Promise<Answer> {
  const response = await app.fetch(
    new Request(`http://api.test${ENROL_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password }),
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    cookie: response.headers.get('set-cookie'),
  };
}

/** The token the last email to an address carries. */
export function tokenTo(address: string): string {
  const sent = mailTo(address);
  return linkIn(sent.at(-1)).token;
}

/** Invite as `who`, send, and the invitation's id and its link's token. */
export async function invited(
  who: Member,
  address: string,
  business: string = w.alpha,
): Promise<{ id: string; token: string }> {
  w.provider.mode('accept');
  const id = await invite(who, address);
  const sent = await send(id, business);
  if (!sent.ok) throw new Error(`send refused ${sent.code}`);
  return { id, token: tokenTo(address) };
}

/** How many rows a table holds in one business, read as the owner. */
export async function rowsIn(table: string, business: string): Promise<number> {
  const [row] = await w.db.admin.execute<{ n: string }>(
    `select count(*)::text as n from public.${table} where business_id = $1`,
    [business],
  );
  return Number(row?.n);
}

/** The invitation's state and how many of its tokens are spent. */
export async function spentOf(
  invitationId: string,
): Promise<{ state: string; spent: number; tokens: number }> {
  const [row] = await w.db.admin.execute<{ state: string; spent: string; tokens: string }>(
    `select i.state, count(t.spent_at)::text as spent, count(t.id)::text as tokens
       from public.invitations i
       left join public.enrolment_tokens t on t.invitation_id = i.id
      where i.id = $1 group by i.state`,
    [invitationId],
  );
  return { state: String(row?.state), spent: Number(row?.spent), tokens: Number(row?.tokens) };
}
