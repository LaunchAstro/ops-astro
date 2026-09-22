// SPDX-License-Identifier: AGPL-3.0-only
//
// The five synthetic logins the working slice is tested with, created through
// GoTrue's own admin API and written to `.local/synthetic-users.json`.
//
// They are created through the admin API rather than inserted into `auth` by
// hand for the reason the acceptance checklist gives: local test credentials
// have to come through the production identity adapter's normal entry, not
// through a bypass that only exists in tests. A subject that GoTrue minted is
// a subject GoTrue will sign a token for.
//
// This script owns no business, person or membership. It produces subjects;
// SLICE-DATA's seed maps them to `logins`, persons and memberships. The two
// meet only at the file, whose shape the local slice contract fixes.
//
// Idempotent: an email that already exists is read back rather than recreated,
// and its password is reset to the one recorded here so a reseed after a
// forgotten file still signs in.

import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCAL = join(ROOT, '.local');

/**
 * The contract's five. `business` is the contract's A/B label; `businessKey`
 * is the same business as the path prefix spells it, so the consumer does not
 * have to carry the mapping in its head.
 *
 * `grants` is the coordinator's ruling of 22:57Z. An entry that omits it takes
 * the seed's ordinary grants for its role; `noah@alpha.local` carries an empty
 * list because he is checklist case N2's other half — an authenticated member
 * of business A holding no task-collection scope, who must be refused
 * `SCOPE_NOT_GRANTED` rather than shown an empty list. He is still the person
 * `task.assign` assigns to, which is deliberate: being assignable and being
 * able to read are different questions, and N2 is only a real case if the
 * person in it is otherwise ordinary.
 */
const PEOPLE = [
  {
    email: 'ada@alpha.local',
    business: 'A',
    businessKey: 'alpha',
    person: 'Ada Lovelace',
    role: 'admin',
  },
  {
    email: 'mia@alpha.local',
    business: 'A',
    businessKey: 'alpha',
    person: 'Mia Chen',
    role: 'member',
  },
  {
    email: 'noah@alpha.local',
    business: 'A',
    businessKey: 'alpha',
    person: 'Noah Patel',
    role: 'member',
    grants: [],
  },
  {
    email: 'orphan@alpha.local',
    business: 'A',
    businessKey: 'alpha',
    person: 'Orphan Login',
    role: 'none',
  },
  {
    email: 'bea@bravo.local',
    business: 'B',
    businessKey: 'bravo',
    person: 'Bea Rivera',
    role: 'member',
  },
];

/** Local-only, fixed so a reseed does not invalidate a handback. */
function passwordFor(email) {
  return `slice-local-${email.split('@')[0]}-2026`;
}

function readEnv(file) {
  const values = {};
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return values;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at === -1) continue;
    values[trimmed.slice(0, at)] = trimmed.slice(at + 1);
  }
  return values;
}

const base64url = (input) =>
  Buffer.from(input)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

/**
 * A service-role token for the admin API, signed with the same secret the API
 * verifies user tokens with. It lives for five minutes and never leaves this
 * process.
 */
function serviceToken(secret) {
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
  return `${header}.${payload}.${signature}`;
}

async function call(url, token, method, body) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      apikey: token,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}

async function findByEmail(gotrue, token, email) {
  const found = await call(`${gotrue}/admin/users?page=1&per_page=200`, token, 'GET');
  if (found.status !== 200) return undefined;
  const users = Array.isArray(found.body?.users) ? found.body.users : [];
  return users.find((user) => user.email === email);
}

async function main() {
  const env = { ...readEnv(join(LOCAL, 'auth.env')), ...process.env };
  const gotrue = env.GOTRUE_URL ?? 'http://127.0.0.1:54391';
  const secret = env.SUPABASE_JWT_SECRET;
  if (secret === undefined || secret === '') {
    console.error('BLOCKER: SUPABASE_JWT_SECRET is not set. Run scripts/local/auth-up.sh first.');
    process.exit(1);
  }

  const token = serviceToken(secret);
  const seeded = [];

  for (const person of PEOPLE) {
    const password = passwordFor(person.email);
    // eslint-disable-next-line no-await-in-loop -- five users, in order, so the log reads as a list
    let created = await call(`${gotrue}/admin/users`, token, 'POST', {
      email: person.email,
      password,
      email_confirm: true,
    });

    let subject = created.body?.id;
    if (subject === undefined) {
      // Already there: read it back and reset the password to the recorded one.
      // eslint-disable-next-line no-await-in-loop
      const existing = await findByEmail(gotrue, token, person.email);
      if (existing === undefined) {
        console.error(
          `BLOCKER: ${person.email} could not be created (${created.status})`,
          created.body,
        );
        process.exit(1);
      }
      subject = existing.id;
      // eslint-disable-next-line no-await-in-loop
      await call(`${gotrue}/admin/users/${subject}`, token, 'PUT', {
        password,
        email_confirm: true,
      });
      created = { status: 200, body: existing };
    }

    seeded.push({ ...person, password, subject, provider: 'supabase' });
    console.log(
      `auth-seed: ${person.email} ${created.status === 200 ? 'exists' : 'created'} subject=${subject}`,
    );
  }

  mkdirSync(LOCAL, { recursive: true });
  const file = join(LOCAL, 'synthetic-users.json');
  writeFileSync(file, `${JSON.stringify(seeded, undefined, 2)}\n`, { mode: 0o600 });
  console.log(
    `auth-seed: wrote ${file} (${seeded.length} logins, run ${randomUUID().slice(0, 8)})`,
  );
}

await main();
