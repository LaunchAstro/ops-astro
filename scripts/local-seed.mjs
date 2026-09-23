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
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connect, connectAsAdmin } from '../packages/core-records/src/tenancy/database.ts';
import { installTaskSpine } from '../packages/core-records/src/tasks/install.ts';
import {
  installBusinessSettings,
  readBusinessSettings,
} from '../packages/core-records/src/records/business-settings.ts';
import { issueGrant, revokeGrant } from '../packages/core-records/src/authority/grants.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const usersFile = `${root}.local/synthetic-users.json`;

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
  ],
  member: [
    ['task', 'read'],
    ['task', 'write'],
    ['task', 'assign'],
    ['person', 'read'],
  ],
  none: [],
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
  // authority boundary -- the same path a person revoking a grant uses -- and
  // touches no task, person or membership.
  const keep = new Set(wanted.map(([collection, action]) => `${collection}:${action}`));
  const live = await tx.query(
    `select id, collection, action from public.grants
      where subject_kind = 'person' and subject_id = $1 and revoked_at is null`,
    [person.personId],
  );
  let revoked = 0;
  for (const grant of live) {
    if (keep.has(`${grant.collection}:${grant.action}`)) continue;
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
