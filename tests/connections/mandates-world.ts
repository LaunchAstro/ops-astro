// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- the world, built in one place */
//
// MP-14-10a's command world: two businesses, each with a real client, a
// graduation row and a live mandate of its own (non-null links, so every
// isolation case is a real crossing), and the members the refusal cases need.
// Graduation rows are written by the agent loops (AW-01, not built), so they
// are seeded as the database owner, as `mp-14-10a-graduation-read.test.ts`
// does; mandates a case files go through the commands.

import { randomUUID } from 'node:crypto';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { authorised, ISSUER, post, tokenFor, type Answer } from '../api/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import { signBearer } from '../support/sign-in.ts';
import { createClient } from '../../packages/core-records/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { pausingAfter } from './fixture.ts';

export const RECORD_CANARY: string = `record-canary-${randomUUID()}`;
export const BRAVO_CANARY: string = `bravo-canary-${randomUUID()}`;

/** C59's step-up is asked of a money key; this is the statement it reads its clock with. */
export const STEP_UP_CLOCK = 'floor(extract(epoch from now()))';

export const path = (business: string, name: string): string =>
  `/api/b/${business}/${name.replace('.', '/')}`;

export const inDays = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString();

export const AUD = (amountMinor: number): { amountMinor: number; currency: string } => ({
  amountMinor,
  currency: 'AUD',
});

export const detail = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] ?? {}) as Record<string, unknown>;

/** How a member signs in: a fresh second factor (the default), none, or one past the window. */
export type SignIn = 'fresh' | 'no-factor' | 'stale-factor';

async function bearer(who: Member, signIn: SignIn): Promise<string> {
  if (signIn === 'fresh') return await tokenFor(who.presented.subject, { secondFactor: true });
  if (signIn === 'no-factor') return await tokenFor(who.presented.subject);
  const now = Math.floor(Date.now() / 1000);
  const past = now - 2 * 60 * 60;
  return await signBearer({
    sub: who.presented.subject,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    exp: now + 600,
    aal: 'aal2',
    amr: [
      { method: 'password', timestamp: past },
      { method: 'totp', timestamp: past },
    ],
  });
}

export interface MandatesWorld {
  readonly controls: Controls;
  readonly alpha: string;
  readonly bravo: string;
  readonly clientA: string;
  readonly clientB: string;
  readonly bravoClient: string;
  /** mandate:manage and connection:read, business-wide. */
  readonly admin: Member;
  /** connection:read only. */
  readonly connReader: Member;
  /** mandate:write business-wide, not mandate:manage. */
  readonly writer: Member;
  /** mandate:manage on client A only. */
  readonly clientManager: Member;
  /** mandate:manage business-wide on a grant of its own, for the revocation race. */
  readonly racer: Member;
  readonly racerGrant: string;
  readonly bravoAdmin: Member;
  readonly cls: Readonly<Record<string, string>>;
  /** Live mandates seeded in each business, one per client. */
  readonly seeded: Readonly<Record<'alphaB' | 'bravo', string>>;
  as(
    who: Member,
    name: string,
    body: Readonly<Record<string, unknown>>,
    business?: string,
    signIn?: SignIn,
  ): Promise<Answer>;
  file(who: Member, body: Readonly<Record<string, unknown>>, business?: string): Promise<Answer>;
  /** The boundary on a pool of its own, `max` wide, each transaction paused after `statement`. */
  pausedApi(
    max: number,
    paused: () => Promise<void>,
    statement?: string,
  ): {
    readonly as: (
      who: Member,
      name: string,
      body: Readonly<Record<string, unknown>>,
    ) => Promise<Answer>;
    readonly close: () => Promise<void>;
  };
  /** Every mandate and graduation row of both businesses, as the owner reads them. */
  snapshot(): Promise<string>;
  mandateRows(): Promise<number>;
  drop(): Promise<void>;
}

export async function buildMandatesWorld(part: string): Promise<MandatesWorld> {
  const controls = await createControls(part);
  const { db, business: alpha } = controls.fixture;
  const admin = controls.manager;
  const connReader = await enrol(db.app, alpha, 'connreader');
  const writer = await enrol(db.app, alpha, 'writer');
  const clientManager = await enrol(db.app, alpha, 'clientmanager');
  const racer = await enrol(db.app, alpha, 'racer');

  const madeClient = async (business: string, name: string, by: Member): Promise<string> =>
    await db.app.withBusiness(business, async (tx) => {
      const made = await createClient(tx, name, by.actorId);
      if (!made.ok) throw new Error('mp-14-10a: the client was not made');
      return made.value;
    });
  const clientA = await madeClient(alpha, 'Client A', admin);
  const clientB = await madeClient(alpha, `Client B ${RECORD_CANARY}`, admin);

  const whole = { kind: 'business', id: null } as const;
  let racerGrant = '';
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, admin, 'manage', whole, false, 'mandate');
    await grantTo(tx, admin, 'read', whole, false, 'connection');
    await grantTo(tx, connReader, 'read', whole, false, 'connection');
    await grantTo(tx, writer, 'write', whole, false, 'mandate');
    await grantTo(tx, writer, 'read', whole, false, 'connection');
    await grantTo(tx, clientManager, 'manage', { kind: 'party', id: clientA }, false, 'mandate');
    await grantTo(tx, clientManager, 'read', { kind: 'party', id: clientA }, false, 'connection');
    racerGrant = await grantTo(tx, racer, 'manage', whole, false, 'mandate');
  });

  const seedClass = async (
    business: string,
    client: string,
    actionClass: string,
    earned: string,
    neverWhy: string | null = null,
  ): Promise<string> => {
    const id = randomUUID();
    await db.admin.execute(
      `insert into public.graduation_classes
         (business_id, id, client_id, action_class, class_label, clearance, earned,
          never_why, approved, edited, rejected, since, note)
       values ($1, $2, $3, $4, $5, 'Draft', $6, $7, 30, 1, 0, '2026-08-01', '')`,
      [business, id, client, actionClass, `Class ${actionClass}`, earned, neverWhy],
    );
    return id;
  };
  const seedMandate = async (business: string, client: string, author: Member, label: string) => {
    const id = randomUUID();
    await db.admin.execute(
      `insert into public.standing_mandates
         (business_id, id, client_id, classes, refuses, ceiling_minor, currency, expires_at,
          label, authored_by_actor_id)
       values ($1, $2, $3, array['social.post'], false, 10000, 'AUD', now() + interval '30 days',
               $4, $5)`,
      [business, id, client, label, author.actorId],
    );
    return id;
  };

  const cls: Record<string, string> = {
    aPost: await seedClass(alpha, clientA, 'social.post', 'ready'),
    aReply: await seedClass(alpha, clientA, 'social.reply', 'ready'),
    aLike: await seedClass(alpha, clientA, 'social.like', 'ready'),
    aShare: await seedClass(alpha, clientA, 'social.share', 'ready'),
    aBudget: await seedClass(alpha, clientA, 'ads.budget', 'never', 'ceiling'),
    aReport: await seedClass(alpha, clientA, 'report.send', 'short'),
    aEmail: await seedClass(alpha, clientA, 'email.send', 'mixed'),
    aInvoice: await seedClass(alpha, clientA, 'billing.invoice', 'none'),
    bPost: await seedClass(alpha, clientB, 'social.post', 'ready'),
  };

  const bravo = await insertBusiness(db.app, 'bravo');
  await installSpine(db.app, bravo);
  const bravoAdmin = await enrol(db.app, bravo, 'bravoadmin');
  await db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bravoAdmin, 'manage', whole, false, 'mandate');
    await grantTo(tx, bravoAdmin, 'read', whole, false, 'connection');
  });
  const bravoClient = await madeClient(bravo, `Bravo ${BRAVO_CANARY}`, bravoAdmin);
  cls['bravoPost'] = await seedClass(bravo, bravoClient, 'social.post', 'ready');
  const seeded = {
    alphaB: await seedMandate(alpha, clientB, admin, `B standing ${RECORD_CANARY}`),
    bravo: await seedMandate(bravo, bravoClient, bravoAdmin, `Bravo standing ${BRAVO_CANARY}`),
  };

  const asVia = async (
    api: Controls['api'],
    who: Member,
    name: string,
    body: Readonly<Record<string, unknown>>,
    business: string,
    signIn: SignIn,
  ): Promise<Answer> =>
    await post(
      api,
      path(business, name),
      { operationId: randomUUID(), ...body },
      authorised(await bearer(who, signIn)),
    );

  const as: MandatesWorld['as'] = async (who, name, body, business = 'alpha', signIn = 'fresh') =>
    await asVia(controls.api, who, name, body, business, signIn);

  return {
    controls,
    alpha,
    bravo,
    clientA,
    clientB,
    bravoClient,
    admin,
    connReader,
    writer,
    clientManager,
    racer,
    racerGrant,
    bravoAdmin,
    cls,
    seeded,
    as,
    async file(who, body, business = 'alpha') {
      return await as(
        who,
        'mandate.file',
        {
          clientId: clientA,
          classes: ['social.post'],
          ceiling: AUD(50_000),
          expiresAt: inDays(30),
          label: 'Posts for A under five hundred dollars are fine',
          ...body,
        },
        business,
      );
    },
    pausedApi(max, paused, statement = STEP_UP_CLOCK) {
      const pool = connect(controls.fixture.db.appUrl, { source: 'runtime', max });
      const api = controls.fixture.compose(
        undefined,
        undefined,
        pausingAfter(pool, statement, paused),
      );
      return {
        as: async (who, name, body) => await asVia(api, who, name, body, 'alpha', 'fresh'),
        close: async () => await pool.close(),
      };
    },
    async snapshot() {
      const mandates = await db.admin.execute(
        `select id, business_id, client_id, revision, revoked_at is not null as revoked
           from public.standing_mandates order by id`,
      );
      const classes = await db.admin.execute(
        'select id, business_id, revision from public.graduation_classes order by id',
      );
      return JSON.stringify({ mandates, classes });
    },
    async mandateRows() {
      return await controls.count('select count(*) as n from public.standing_mandates', []);
    },
    async drop() {
      await controls.drop();
    },
  };
}

/** A promise and the function that settles it, with a ceiling on the wait. */
export function gate(ms = 3000): { readonly wait: () => Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const wait = async (): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      opened,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    clearTimeout(timer);
  };
  return { wait, open };
}
