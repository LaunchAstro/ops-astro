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
// forgotten file still signs in. A reset GoTrue refuses fails the seed before
// any file is written.

import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from '../../packages/core-records/src/env-file.ts';
import { localServiceToken } from './signing-key.mjs';
import { PEOPLE } from './synthetic-logins.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCAL = join(ROOT, '.local');

/** Local-only, fixed so a reseed does not invalidate a handback. */
function passwordFor(email) {
  return `slice-local-${email.split('@')[0]}-2026`;
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
  const env = { ...readEnvFile(join(LOCAL, 'auth.env')), ...process.env };
  const gotrue = env.GOTRUE_URL ?? 'http://127.0.0.1:54391';
  // Signed with the local auth server's own key: there is no shared secret.
  const token = await localServiceToken(ROOT);
  if (token === undefined) {
    console.error('BLOCKER: no local signing key. Run scripts/local/auth-up.sh first.');
    process.exit(1);
  }
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
      const reset = await call(`${gotrue}/admin/users/${subject}`, token, 'PUT', {
        password,
        email_confirm: true,
      });
      if (reset.status < 200 || reset.status > 299) {
        console.error(
          `BLOCKER: ${person.email} exists, but its password could not be reset (${reset.status})`,
        );
        process.exit(1);
      }
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
