// SPDX-License-Identifier: AGPL-3.0-only
//
// The two businesses, their people, and who may do what.
//
// It seeds identity and authority and **never a task**. A seeded task would be
// a task nobody created, and every acceptance case that matters -- create,
// assign, start, complete, reload, restart -- is a case about a task a person
// made during the test. A "successful" row waiting in the database is the one
// thing that would make all of them pass without the product working.
//
// It is idempotent by lookup, not by truncation: every row is found by the key
// that identifies it and inserted only when it is absent. Running it twice
// changes nothing, and running it after a session has created tasks changes
// nothing about those tasks.
//
// Identity comes from `.local/synthetic-users.json`, which SLICE-API's auth
// seed writes: the GoTrue subjects are its to mint, because a `logins` row
// whose subject no auth provider knows is a login nobody can use. Until that
// file exists this script writes a placeholder with random subjects and says
// so, loudly, every time -- the rows are real and the subjects are not, so the
// API path cannot be demonstrated against them.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connect, connectAsAdmin } from '../packages/core-records/src/tenancy/database.ts';
import { installTaskSpine } from '../packages/core-records/src/tasks/install.ts';
import {
  installBusinessSettings,
  readBusinessSettings,
} from '../packages/core-records/src/records/business-settings.ts';
import { issueGrant, revokeGrant } from '../packages/core-records/src/authority/grants.ts';
import { shareRecord } from '../packages/core-records/src/authority/shares.ts';
import { ensureCredentialKeyFile } from '../packages/core-records/src/authority/credential-keys.ts';
import { declarationOf } from '../packages/core-records/src/commands/surface.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const usersFile = `${root}.local/synthetic-users.json`;
const agentsFile = `${root}.local/synthetic-agents.json`;
const gateFile = `${root}.local/gate.env`;

function fromEnvFile(name) {
  if (process.env[name]) return process.env[name];
  const file = `${root}.local/db.env`;
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = new RegExp(`^${name}=(.+)$`, 'u').exec(line.trim());
    if (match) return match[1];
  }
  return undefined;
}

/**
 * The cast the local slice contract fixes, with the grants each part needs.
 *
 * `noah` holds a membership and no grant on purpose: acceptance case N2 asks
 * for an authenticated member of A with no task collection scope, and that
 * person has to be a real member or the case tests the membership check
 * instead. `orphan` is a verified login with no membership at all, which is
 * the other half of N2 and is why it has no person here.
 */
const CAST = [
  { email: 'ada@alpha.local', business: 'A', person: 'Ada Alpha', role: 'admin' },
  { email: 'mia@alpha.local', business: 'A', person: 'Mia Alpha', role: 'member' },
  { email: 'noah@alpha.local', business: 'A', person: 'Noah Alpha', role: 'member', grants: [] },
  { email: 'orphan@alpha.local', business: 'A', person: 'Orphan Alpha', role: 'none' },
  { email: 'bea@bravo.local', business: 'B', person: 'Bea Bravo', role: 'member' },
];

const BUSINESS_KEYS = { A: 'alpha', B: 'bravo' };

/** What a role may do when the file names no grants of its own. */
const GRANTS_BY_ROLE = {
  admin: [
    ['task', 'read'],
    ['task', 'write'],
    ['task', 'assign'],
    ['task', 'comment'],
    ['task', 'share'],
    ['task', 'manage'],
    ['person', 'read'],
    // The two settings commands take `manage` on the `settings` collection
    // (`commands/surface.ts`), and the admin had six task actions and
    // `person:read`, so as seeded nobody could write either setting: WEB-COMMENTS
    // observed `POST /settings/set_four_eyes_threshold` as the admin answering
    // 403 SCOPE_NOT_GRANTED against the live stack. A setting that decides who
    // must agree before money moves is an authority change, and an
    // administrator is who the model means by whoever may make it.
    ['settings', 'manage'],
    // A decision draws on the business's budget cap and signs a link into the
    // append-only decision chain, which is the same class of act as the
    // `settings` grant above. `commands/surface.ts` declares `task.decide`
    // with the action `decide`, and `authority/grants.ts` matches the
    // collection and the action exactly -- there is no implication, so
    // `task:manage` never covered it. As seeded before this line no identity
    // held `task:decide` at all, so `task.decide` answered 403
    // SCOPE_NOT_GRANTED for every synthetic user and the runtime journey could
    // not be walked over HTTP: the same shape as the `settings:manage` gap.
    ['task', 'decide'],
    // Settings are business facts, and a reader is not a writer. The write
    // stays `manage` above; this is the half that lets a screen show the
    // four-eyes band instead of guessing at it.
    ['settings', 'read'],
  ],
  member: [
    ['task', 'read'],
    ['task', 'write'],
    ['task', 'assign'],
    ['person', 'read'],
    // Every member may see what the business decided about itself. A member
    // who cannot read the four-eyes band cannot tell a refusal from a bug when
    // their own work stops at a second approver. The write is the admin's:
    // `settings:manage` is not widened by this line.
    ['settings', 'read'],
  ],
  none: [],
  // The external party holds no business grant, and must not: a person with no
  // membership and a live business grant is refused at resolution as a former
  // member. What it may read is what `shareRecord` shares with it, below.
  external: [],
};

function placeholderUsers() {
  return CAST.map((member) => {
    const user = {
      email: member.email,
      password: `local-${randomUUID().slice(0, 12)}`,
      subject: randomUUID(),
      business: member.business,
      person: member.person,
      role: member.role,
    };
    if (member.grants !== undefined) user.grants = member.grants;
    return user;
  });
}

function readUsers() {
  if (existsSync(usersFile)) {
    return { users: JSON.parse(readFileSync(usersFile, 'utf8')), placeholder: false };
  }
  const users = placeholderUsers();
  writeFileSync(usersFile, `${JSON.stringify(users, undefined, 2)}\n`, { mode: 0o600 });
  return { users, placeholder: true };
}

/** One row, found by what identifies it, inserted only when it is not there. */
async function ensure(tx, find, insert) {
  const found = await find();
  if (found !== undefined) return found;
  return await insert();
}

/**
 * Whether this business already carries the task comment type.
 *
 * Read before `installTaskSpine`, because afterwards the answer is always yes
 * and the installer's `installed` flag is about the task type rather than this
 * one. One statement, no writes, and it is the seed's own question about what
 * its log should say.
 */
async function hasCommentType(tx) {
  const rows = await tx.query(
    `select 1 from public.record_types where business_id = $1 and key = 'task_comment' limit 1`,
    [tx.businessId],
  );
  return rows.length > 0;
}

async function businessIdFor(admin, key) {
  const rows = await admin.execute('select id from public.businesses where key = $1', [key]);
  if (rows[0]) return rows[0].id;
  const id = randomUUID();
  await admin.execute(
    'insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $3)',
    [id, key, key],
  );
  return id;
}

async function seedPerson(tx, member) {
  const personId = await ensure(
    tx,
    async () => {
      const rows = await tx.query('select id from public.people where display_name = $1', [
        member.person,
      ]);
      return rows[0]?.id;
    },
    async () => {
      const id = randomUUID();
      await tx.query(
        'insert into public.people (business_id, id, display_name) values ($1,$2,$3)',
        [tx.businessId, id, member.person],
      );
      return id;
    },
  );

  const actorId = await ensure(
    tx,
    async () => {
      const rows = await tx.query(
        `select id from public.actors where person_id = $1 and kind = 'person'`,
        [personId],
      );
      return rows[0]?.id;
    },
    async () => {
      const id = randomUUID();
      await tx.query(
        `insert into public.actors (business_id, id, kind, person_id, active)
         values ($1, $2, 'person', $3, true)`,
        [tx.businessId, id, personId],
      );
      return id;
    },
  );

  return { personId, actorId };
}

async function seedLogin(tx, member, person) {
  const loginId = await ensure(
    tx,
    async () => {
      const rows = await tx.query(
        `select id from public.logins where provider = 'supabase' and subject = $1`,
        [member.subject],
      );
      return rows[0]?.id;
    },
    async () => {
      const id = randomUUID();
      await tx.query(
        `insert into public.logins (business_id, id, provider, subject) values ($1,$2,'supabase',$3)`,
        [tx.businessId, id, member.subject],
      );
      return id;
    },
  );

  // A login with no membership keeps its login row and gets no mapping: that
  // is what AUTH_NO_MEMBERSHIP is a refusal about, and a mapping here would
  // make the case untestable.
  if (member.role === 'none') return { loginId, mapped: false };

  await ensure(
    tx,
    async () => {
      const rows = await tx.query(
        'select id from public.person_logins where login_id = $1 and person_id = $2',
        [loginId, person.personId],
      );
      return rows[0]?.id;
    },
    async () => {
      const id = randomUUID();
      await tx.query(
        `insert into public.person_logins
           (business_id, id, login_id, person_id, active, linked_by_actor_id)
         values ($1,$2,$3,$4,true,$5)`,
        [tx.businessId, id, loginId, person.personId, person.actorId],
      );
      return id;
    },
  );

  // R4 (minimum contract 8.1): mapped, acting, and not a member. Its login
  // resolves only while something is shared with it (`login-resolution.ts`).
  if (member.role === 'external') return { loginId, mapped: true };

  await ensure(
    tx,
    async () => {
      const rows = await tx.query('select id from public.memberships where person_id = $1', [
        person.personId,
      ]);
      return rows[0]?.id;
    },
    async () => {
      const id = randomUUID();
      await tx.query(
        `insert into public.memberships (business_id, id, person_id, role_key, active)
         values ($1,$2,$3,$4,true)`,
        [tx.businessId, id, person.personId, member.role],
      );
      return id;
    },
  );

  return { loginId, mapped: true };
}

/**
 * How many live leases rest on a grant as their work authority: the grant or a
 * grant beneath it is a `write` the lease's person or delegating person holds.
 * The same discovery `grant.revoke` makes (`authority-controls.ts`,
 * `dependents`), counted rather than classified.
 */
async function leasesResting(tx, grantId) {
  const rows = await tx.query(
    `with recursive revoked as (
       select g.id, g.subject_kind, g.subject_id, g.collection, g.action
         from public.grants g where g.business_id = $1 and g.id = $2
       union
       select c.id, c.subject_kind, c.subject_id, c.collection, c.action
         from public.grants c join revoked p on c.parent_grant_id = p.id
        where c.business_id = $1
     )
     select count(*)::int as leases from public.leases l
       left join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
       left join public.actors a
         on a.business_id = l.business_id and a.id = l.holder_actor_id and a.kind = 'person'
      where l.business_id = $1 and l.state = 'live'
        and ((l.delegation_id is not null and d.revoked_at is null and d.settled_at is null
              and exists (select 1 from revoked r
                           where r.subject_kind = 'person' and r.subject_id = l.authorised_by_person_id
                             and r.action = 'write' and r.collection = any(d.collections)))
          or (l.delegation_id is null
              and exists (select 1 from revoked r
                           where r.action = 'write' and r.collection = $3
                             and ((r.subject_kind = 'person' and r.subject_id = a.person_id)
                                  or (r.subject_kind = 'actor' and r.subject_id = l.holder_actor_id)))))`,
    [tx.businessId, grantId, declarationOf('task.pickup').collection],
  );
  return rows[0]?.leases ?? 0;
}

async function seedGrants(tx, member, person) {
  const wanted = member.grants ?? GRANTS_BY_ROLE[member.role] ?? [];
  for (const [collection, action] of wanted) {
    // One grant at a time, on one connection, inside one transaction. These
    // are sequential because they share it, not because anybody is waiting.
    // oxlint-disable-next-line no-await-in-loop
    const held = await tx.query(
      `select id from public.grants
        where subject_kind = 'person' and subject_id = $1 and collection = $2
          and action = $3 and scope_kind = 'business' and revoked_at is null`,
      [person.personId, collection, action],
    );
    if (held[0]) continue;
    // oxlint-disable-next-line no-await-in-loop
    const issued = await issueGrant(tx, [], {
      subject: { kind: 'person', id: person.personId },
      scope: { kind: 'business', id: null },
      collection,
      action,
      parentGrantId: null,
      grantedByActorId: person.actorId,
    });
    if (!issued.ok) throw new Error(`local-seed: grant refused ${issued.refusal.code}`);
  }

  // A grant the file does not name is taken back, not left behind.
  //
  // Adding only was enough while the file's grants only ever grew, and it is
  // not enough for the one identity the contract defines by what she has not
  // got: `noah@alpha.local` carries `"grants": []` so that N2 has a real
  // member of A with no task scope. A run that defaulted him from his role
  // before the ruling landed left those grants live, and a seed that could
  // only add could never say so. Revocation writes a timestamp through the
  // authority boundary's `revokeGrant` and touches no task, person or
  // membership.
  //
  // It is not the path `grant.revoke` takes. That command also releases a
  // lease the grant was the work authority for and classifies its hold
  // `authority_revoked` in the same transaction (`revokeGrantAsManager`);
  // `revokeGrant` only stamps `revoked_at`. So the seed refuses a revocation
  // that would strand a live lease, before it revokes anything, and says what
  // to do instead (final review R1 #60).
  const keep = new Set(wanted.map(([collection, action]) => `${collection}:${action}`));
  //
  // Business grants only. A record share is not the role's to take back: it is
  // `shareRecord`'s, and a seed rerun that revoked the external party's share
  // would undo the demo it was run to set up.
  //
  // Held before the leases are counted, in id order, as `grant.revoke` holds
  // its grant before it looks for dependents: a pickup in flight holds its
  // grants `for share`, so this waits for it and then counts its lease
  // (final review R1-AUTHORITY-60, round 3).
  const dropped = await tx.query(
    `select id, collection, action from public.grants
      where subject_kind = 'person' and subject_id = $1 and revoked_at is null
        and scope_kind = 'business' and not (collection || ':' || action = any($2::text[]))
      order by id
        for update`,
    [person.personId, [...keep]],
  );
  for (const grant of dropped) {
    // oxlint-disable-next-line no-await-in-loop
    const leases = await leasesResting(tx, grant.id);
    if (leases > 0) {
      throw new Error(
        `local-seed: ${member.email}'s ${grant.collection}:${grant.action} grant ${grant.id} ` +
          `is the work authority for ${leases} live lease(s). The seed revokes without ` +
          'releasing them, so it stops here: hand the work back, or revoke the grant with ' +
          'grant.revoke, which releases and classifies it, and then rerun the seed.',
      );
    }
  }
  let revoked = 0;
  for (const grant of dropped) {
    // Sequential for the reason the issue loop above is: one connection, one
    // transaction, and nobody waiting.
    // oxlint-disable-next-line no-await-in-loop
    await revokeGrant(tx, grant.id);
    revoked += 1;
  }
  return { granted: wanted.length, revoked };
}

const adminUrl = fromEnvFile('DATABASE_ADMIN_URL');
const appUrl = fromEnvFile('DATABASE_URL');
if (!adminUrl || !appUrl) {
  console.error('local-seed: no DATABASE_URL/DATABASE_ADMIN_URL. Run scripts/local/db-up.sh.');
  process.exit(1);
}

const { users, placeholder } = readUsers();
if (placeholder) {
  console.warn('local-seed: .local/synthetic-users.json was absent, so a PLACEHOLDER was written.');
  console.warn('local-seed: its subjects are random uuids that no GoTrue instance knows, so these');
  console.warn('local-seed: identities cannot sign in. SLICE-API replaces the file; rerun after.');
}

/**
 * The agent identity each business gets, and what it presents to authenticate.
 *
 * **The credential is a GoTrue password, exactly like a person's.** An agent
 * login and a person's login are two credentials and two resolution paths
 * (AUTHORITY.md), and that distinction is about *who the caller is*, not about
 * how they prove it. Both present a bearer token this deployment's GoTrue
 * signed; what differs is where the subject resolves — `person_logins` for a
 * person, `actor_logins` to an `agent` actor for an agent, and migration 0008
 * holds a login out of both at once from either side. So the agent signs in at
 * `/token?grant_type=password` with the email and password below and sends the
 * access token as its bearer, and `resolveAgentLogin` refuses it on the person
 * path and a person on this one.
 *
 * **The delegation credential is not this.** Signing in confers nothing at all;
 * the agent gets its authority from the credential `task.pickup` mints and
 * returns once, which is stored only as a digest and cannot be read back.
 *
 * The address is built rather than written out, so no synthetic address is a
 * literal in a tracked file, and the whole record lands in gitignored
 * `.local/synthetic-agents.json` and nowhere else.
 */
const AGENT_LOCAL_PART = 'agent';

function agentFor(businessKey) {
  return {
    business: businessKey,
    email: `${AGENT_LOCAL_PART}@${businessKey}.local`,
    password: `local-agent-${randomUUID().slice(0, 12)}`,
    subject: randomUUID(),
  };
}

function readAgents() {
  if (existsSync(agentsFile)) {
    return { agents: JSON.parse(readFileSync(agentsFile, 'utf8')), fresh: false };
  }
  const agents = Object.values(BUSINESS_KEYS).map((key) => agentFor(key));
  writeFileSync(agentsFile, `${JSON.stringify(agents, undefined, 2)}\n`, { mode: 0o600 });
  return { agents, fresh: true };
}

/**
 * The key the decision chain is signed with, generated once and read back.
 *
 * Read back rather than regenerated, for the reason `db-up.sh` reads its
 * password back: a second seed that minted a new secret would leave every
 * decision already on the chain signed by a key this deployment no longer
 * holds, and `gate_decisions.signing_key_id` would then name a key nobody can
 * verify against. It is written to a gitignored file of its own and never to a
 * table the application role can read.
 */
function ensureGateKey() {
  if (existsSync(gateFile)) {
    const text = readFileSync(gateFile, 'utf8');
    const id = /^GATE_SIGNING_KEY_ID=(.+)$/mu.exec(text)?.[1];
    const secret = /^GATE_SIGNING_SECRET=(.+)$/mu.exec(text)?.[1];
    if (id && secret) return { id, secret, fresh: false };
  }
  const id = 'local/gate-decisions@1';
  const secret = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  writeFileSync(
    gateFile,
    `# Written by scripts/local-seed.mjs. Local only, gitignored, not a secret store.\n` +
      `GATE_SIGNING_KEY_ID=${id}\nGATE_SIGNING_SECRET=${secret}\n`,
    { mode: 0o600 },
  );
  return { id, secret, fresh: true };
}

/** One agent actor, its login and the mapping, all idempotent by lookup. */
async function seedAgent(tx, agent) {
  const actorId = await ensure(
    tx,
    async () => {
      const rows = await tx.query(
        `select a.id from public.actors a
           join public.actor_logins al
             on al.business_id = a.business_id and al.actor_id = a.id
           join public.logins l on l.id = al.login_id
          where a.business_id = $1 and a.kind = 'agent' and l.subject = $2`,
        [tx.businessId, agent.subject],
      );
      return rows[0]?.id;
    },
    async () => {
      const id = randomUUID();
      await tx.query(
        `insert into public.actors (business_id, id, kind, active) values ($1, $2, 'agent', true)`,
        [tx.businessId, id],
      );
      return id;
    },
  );
  const loginId = await ensure(
    tx,
    async () => {
      const rows = await tx.query(
        `select id from public.logins where provider = 'supabase' and subject = $1`,
        [agent.subject],
      );
      return rows[0]?.id;
    },
    async () => {
      const id = randomUUID();
      await tx.query(
        `insert into public.logins (business_id, id, provider, subject) values ($1,$2,'supabase',$3)`,
        [tx.businessId, id, agent.subject],
      );
      return id;
    },
  );
  const rows = await tx.query(
    `select id from public.actor_logins where business_id = $1 and login_id = $2`,
    [tx.businessId, loginId],
  );
  if (rows[0] === undefined) {
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $4)`,
      [tx.businessId, randomUUID(), loginId, actorId],
    );
  }
  return { actorId, loginId };
}

/**
 * The business's budget cap.
 *
 * `task.decide` reads it rather than creating it, because a command that
 * created the ceiling it then spent against could never be refused
 * `BUDGET_EXHAUSTED`, and the cap's refusal being the cap's is W05. So the
 * installation is here, once, and a second run leaves the limit alone: a
 * business that has since raised its own ceiling does not want the seed's
 * number back.
 */
const CAP_LIMIT_MINOR = 500_000;

async function seedCap(tx) {
  const rows = await tx.query(
    `select id, limit_minor::text as limit_minor from public.budget_caps
      where business_id = $1 and key = 'local'`,
    [tx.businessId],
  );
  if (rows[0] !== undefined) return { id: rows[0].id, limit: rows[0].limit_minor, created: false };
  const id = randomUUID();
  await tx.query(
    `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
     values ($1, $2, 'local', $3, 'AUD')`,
    [tx.businessId, id, CAP_LIMIT_MINOR],
  );
  return { id, limit: String(CAP_LIMIT_MINOR), created: true };
}

/**
 * The agent's GoTrue user, so its bearer comes from the same provider a
 * person's does.
 *
 * It is created here rather than in `scripts/local/auth-seed.mjs` because that
 * script seeds the five synthetic *people* and the agent is not one of them —
 * and because the subject GoTrue assigns has to be the subject this script
 * writes into `public.logins`, so the two writes belong in one place.
 *
 * A deployment with no GoTrue yet is not an error: the login mapping is in the
 * database either way, and the note says what is missing. Nothing here fails a
 * seed over an auth service that has not been started.
 */
async function seedAgentUser(auth, agent) {
  if (auth === undefined) return { subject: agent.subject, reachable: false };
  const headers = {
    authorization: `Bearer ${auth.token}`,
    apikey: auth.token,
    'content-type': 'application/json',
  };
  const created = await fetch(`${auth.url}/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: agent.email, password: agent.password, email_confirm: true }),
  });
  const body = await created.json().catch(() => undefined);
  if (typeof body?.id === 'string') return { subject: body.id, reachable: true };
  // Already there: find it, and keep the subject GoTrue already issued.
  const listed = await fetch(`${auth.url}/admin/users?page=1&per_page=200`, { headers });
  const listedUsers = (await listed.json().catch(() => ({})))?.users ?? [];
  const found = Array.isArray(listedUsers)
    ? listedUsers.find((user) => user.email === agent.email)
    : undefined;
  return { subject: found?.id ?? agent.subject, reachable: found !== undefined };
}

/** A short-lived service token for the GoTrue admin API, as auth-seed mints one. */
const base64url = (input) =>
  Buffer.from(input)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

function authAdmin() {
  const secret = fromEnvFile('SUPABASE_JWT_SECRET') ?? readAuthEnv('SUPABASE_JWT_SECRET');
  if (secret === undefined || secret === '') return undefined;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      role: 'service_role',
      aud: 'authenticated',
      iss: 'ops-astro-local-seed',
      iat: now,
      exp: now + 300,
    }),
  );
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return {
    url: readAuthEnv('GOTRUE_URL') ?? 'http://127.0.0.1:54391',
    token: `${header}.${payload}.${signature}`,
  };
}

function readAuthEnv(name) {
  if (process.env[name]) return process.env[name];
  const file = `${root}.local/auth.env`;
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = new RegExp(`^${name}=(.+)$`, 'u').exec(line.trim());
    if (match) return match[1];
  }
  return undefined;
}

/**
 * R4, the external party, as a login a person can actually sign in with.
 *
 * Its address is built rather than written, for the reason the agent's is.
 * The entry lives in `.local/synthetic-users.json` beside the cast with
 * `role: 'external'`, and is added back when `scripts/local/auth-seed.mjs`
 * rewrites the file without it. GoTrue's user is created on the agent's path,
 * and on a fresh entry its password is then set to the file's: a no-op for a
 * user just created with it, and the fix for one that already existed under a
 * password the rewritten file lost. It touches this one user and nobody else.
 */
const EXTERNAL_LOCAL_PART = 'ext';

function ensureExternalEntry(list) {
  const found = list.find((user) => user.role === 'external');
  if (found !== undefined) return { entry: found, fresh: false };
  const entry = {
    email: `${EXTERNAL_LOCAL_PART}@${BUSINESS_KEYS.A}.local`,
    password: `local-ext-${randomUUID().slice(0, 12)}`,
    subject: randomUUID(),
    business: 'A',
    person: 'Ext Alpha',
    role: 'external',
  };
  list.push(entry);
  return { entry, fresh: true };
}

async function seedExternalUser(auth, entry, fresh) {
  const user = await seedAgentUser(auth, entry);
  if (!user.reachable || !fresh) return user;
  const reset = await fetch(`${auth.url}/admin/users/${user.subject}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${auth.token}`,
      apikey: auth.token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ password: entry.password }),
  });
  return { subject: user.subject, reachable: reset.ok };
}

/**
 * Share one task with the external party, when the run is asked to.
 *
 * The seed makes no task, so it cannot share one on its own: the demo creates
 * a task as the admin and then reruns the seed with `LOCAL_SEED_SHARE_TASK`
 * naming it by key (`T-1`) or identifier. The share is `shareRecord`'s,
 * issued by the admin under her own `task:share`, which is the same path any
 * sharer takes; the seed writes no grant row of its own for it.
 */
async function shareWithExternal(tx, taskName, adminEmail, externalEmail, people) {
  const sharer = people.get(adminEmail);
  const external = people.get(externalEmail);
  if (sharer === undefined || external === undefined) {
    throw new Error('local-seed: the admin and the external party must be seeded to share');
  }
  const rows = await tx.query(
    `select r.id from public.records r
       join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
      where t.key = 'task' and r.deleted_at is null and (r.txt_1 = $1 or r.id::text = $1)`,
    [taskName],
  );
  if (rows[0] === undefined) throw new Error(`local-seed: no live task ${taskName} to share`);
  const shared = await shareRecord(tx, sharer, {
    collection: 'task',
    recordId: rows[0].id,
    personId: external.personId,
  });
  if (!shared.ok) throw new Error(`local-seed: share refused ${shared.refusal.code}`);
  return { recordId: rows[0].id, grantId: shared.value };
}

const admin = connectAsAdmin(adminUrl, { source: 'seed' });
const database = connect(appUrl, { source: 'seed' });
try {
  const businessIds = {};
  for (const [tag, key] of Object.entries(BUSINESS_KEYS)) {
    // oxlint-disable-next-line no-await-in-loop
    businessIds[tag] = await businessIdFor(admin, key);
    console.log(`local-seed: business ${key} ${businessIds[tag]}`);
  }

  for (const tag of Object.keys(BUSINESS_KEYS)) {
    // oxlint-disable-next-line no-await-in-loop
    await database.withBusiness(businessIds[tag], async (tx) => {
      // Three outcomes, not two. `installed` means "this call installed the
      // task type", so a business that already had `task` and `task_state` and
      // has just acquired `task_comment` reports `false` and used to be logged
      // as "already there" -- a line that says nothing happened about the one
      // run that changed the business's model. The installer is not the place
      // to fix that: `installed` answers exactly the question its name asks and
      // two callers read it that way. What the seed can do is look first, which
      // is the only place the difference is visible.
      const hadComments = await hasCommentType(tx);
      const spine = await installTaskSpine(tx);
      const what = spine.installed
        ? 'installed'
        : hadComments
          ? 'already there'
          : 'upgraded with the comment type';
      console.log(`local-seed: ${BUSINESS_KEYS[tag]} task spine ${what}`);
      // After the spine, because both are record-model installs for the same
      // business and reading a seed that installs them in one order and
      // reports them in another is how a reader stops trusting the log.
      //
      // Idempotent by the producer's own rule rather than by a check here:
      // `installBusinessSettings` inserts `on conflict do nothing`, so a second
      // run adds whatever a later release named and resets no value a business
      // has since changed. The count is printed because "four settings" after
      // the second run is the observation that says so.
      await installBusinessSettings(tx);
      const settings = await readBusinessSettings(tx);
      console.log(
        `local-seed: ${BUSINESS_KEYS[tag]} business settings ${settings.length}` +
          ` (${settings.map((setting) => setting.key).join(', ')})`,
      );
    });
  }

  const gateKey = ensureGateKey();
  console.log(
    `local-seed: gate signing key ${gateKey.id} ` +
      `${gateKey.fresh ? 'generated into' : 'read back from'} .local/gate.env`,
  );

  // The delegation credential keyring, provisioned once and then only read, by
  // the same function the API uses. It is its own key, never the gate key
  // above, and an existing file is never rewritten: every live delegation's
  // pickup replay depends on the key it was minted under (`credential-keys.ts`).
  const credentialFile = `${root}.local/delegation.env`;
  const credentialExisted = existsSync(credentialFile);
  const credentialKeys = ensureCredentialKeyFile(credentialFile);
  if (!credentialKeys.ok) throw new Error(`local-seed: ${credentialKeys.problem}`);
  console.log(
    `local-seed: delegation credential key ${credentialKeys.keys.activeKeyId} ` +
      `${credentialExisted ? 'read back from' : 'generated into'} .local/delegation.env`,
  );

  const { agents, fresh: agentsFresh } = readAgents();
  const auth = authAdmin();
  let authReachable = 0;
  for (const agent of agents) {
    // oxlint-disable-next-line no-await-in-loop
    const user = await seedAgentUser(auth, agent);
    if (user.reachable) authReachable += 1;
    agent.subject = user.subject;
    const tag = Object.keys(BUSINESS_KEYS).find((key) => BUSINESS_KEYS[key] === agent.business);
    const businessId = businessIds[tag];
    if (businessId === undefined) throw new Error(`local-seed: unknown business ${agent.business}`);
    // oxlint-disable-next-line no-await-in-loop
    await database.withBusiness(businessId, async (tx) => {
      const seededAgent = await seedAgent(tx, agent);
      const cap = await seedCap(tx);
      console.log(
        `local-seed: ${agent.business} agent actor ${seededAgent.actorId} ` +
          `login ${seededAgent.loginId}; budget cap ${cap.id} ` +
          `${cap.created ? 'installed' : 'already there'} at ${cap.limit} minor`,
      );
    });
  }
  writeFileSync(agentsFile, `${JSON.stringify(agents, undefined, 2)}\n`, { mode: 0o600 });
  console.log(
    `local-seed: ${agents.length} agent credential(s) ` +
      `${agentsFresh ? 'written to' : 'refreshed in'} .local/synthetic-agents.json ` +
      `(gitignored; ${authReachable} of them confirmed in GoTrue). ` +
      'The password is what the agent signs in with; the delegation credential ' +
      'is what task.pickup returns once and stores only as a digest.',
  );

  const external = ensureExternalEntry(users);
  const externalUser = await seedExternalUser(auth, external.entry, external.fresh);
  external.entry.subject = externalUser.subject;
  writeFileSync(usersFile, `${JSON.stringify(users, undefined, 2)}\n`, { mode: 0o600 });
  console.log(
    `local-seed: external party ${external.entry.email} ` +
      `${external.fresh ? 'added to' : 'read back from'} .local/synthetic-users.json ` +
      `(${externalUser.reachable ? 'confirmed in GoTrue' : 'GoTrue not reached'})`,
  );

  const people = new Map();
  for (const member of users) {
    const businessId = businessIds[member.business];
    if (businessId === undefined)
      throw new Error(`local-seed: unknown business ${member.business}`);
    // The whole seed runs on one connection and one business at a time, so
    // these are sequential by construction rather than by choice.
    // oxlint-disable-next-line no-await-in-loop
    await database.withBusiness(businessId, async (tx) => {
      const person =
        member.role === 'none' ? { personId: null, actorId: null } : await seedPerson(tx, member);
      const login = await seedLogin(tx, member, person);
      if (person.personId !== null) people.set(member.email, person);
      const grants =
        person.personId === null
          ? { granted: 0, revoked: 0 }
          : await seedGrants(tx, member, person);
      console.log(
        `local-seed: ${member.email} login ${login.loginId} ` +
          `${login.mapped ? `person ${person.personId} role ${member.role}` : 'no membership'} ` +
          `grants ${grants.granted} revoked ${grants.revoked}`,
      );
    });
  }

  const shareTask = process.env['LOCAL_SEED_SHARE_TASK'];
  if (shareTask) {
    const adminEmail = users.find((user) => user.business === 'A' && user.role === 'admin')?.email;
    const shared = await database.withBusiness(businessIds.A, (tx) =>
      shareWithExternal(tx, shareTask, adminEmail, external.entry.email, people),
    );
    console.log(
      `local-seed: shared task ${shared.recordId} with ${external.entry.email} ` +
        `through shareRecord (grant ${shared.grantId}, record scope, read)`,
    );
  }

  const counted = await admin.execute(
    `select (select count(*) from public.records r
               join public.record_types t on t.id = r.record_type_id
              where t.key = 'task')::text as tasks`,
  );
  console.log(`local-seed: tasks in the database: ${counted[0].tasks} (this script seeds none)`);
} finally {
  await database.close();
  await admin.close();
}
