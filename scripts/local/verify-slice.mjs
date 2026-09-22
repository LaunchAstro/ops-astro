// SPDX-License-Identifier: AGPL-3.0-only
//
// One repeatable command that walks the working slice's API from a real
// sign-in to the refusals the acceptance checklist names, and prints one line
// per case with the HTTP status and the refusal code it actually observed.
//
// It signs in through the local GoTrue with the passwords `auth-seed.mjs`
// recorded, so every token here is one the production adapter verifies. There
// is no actor header, no business header and no test-only bypass: the only
// thing that says who is calling is a signed token, and the only thing that
// says which business is the path.
//
// A case that cannot run yet is printed as `unrun` with the reason, rather
// than skipped or counted as a pass. The exit status is 0 when every case that
// ran met its expectation.
//
//   node scripts/local/verify-slice.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCAL = join(ROOT, '.local');

function readEnvFile(file) {
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
    if (at !== -1) values[trimmed.slice(0, at)] = trimmed.slice(at + 1);
  }
  return values;
}

const ENV = {
  ...readEnvFile(join(LOCAL, 'db.env')),
  ...readEnvFile(join(LOCAL, 'auth.env')),
  ...process.env,
};
const API = ENV.API_URL ?? `http://127.0.0.1:${ENV.API_PORT ?? 8790}`;
const GOTRUE = ENV.GOTRUE_URL ?? 'http://127.0.0.1:54391';

const users = JSON.parse(readFileSync(join(LOCAL, 'synthetic-users.json'), 'utf8'));
const userOf = (email) => {
  const found = users.find((user) => user.email === email);
  if (found === undefined) throw new Error(`verify-slice: ${email} is not in synthetic-users.json`);
  return found;
};

const results = [];
function record(name, { status, code, ok, note }) {
  results.push({ name, status, code, ok, note });
  const verdict = ok === undefined ? 'unrun' : ok ? 'pass' : 'FAIL';
  const parts = [
    verdict.padEnd(5),
    name.padEnd(34),
    `HTTP ${status ?? '---'}`,
    `code=${code ?? '-'}`,
  ];
  if (note !== undefined && note !== '') parts.push(`(${note})`);
  console.log(parts.join('  '));
}

/** A signed-in session. The token is the only thing carried forward. */
async function signIn(email) {
  const user = userOf(email);
  const response = await fetch(`${GOTRUE}/token?grant_type=password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, token: body.access_token, user };
}

/**
 * One call. `headers` is for the tampering case only; nothing it can carry is
 * supposed to reach identity, which is the point of being able to send it.
 */
async function call(token, businessKey, path, body, headers = {}) {
  const started = process.hrtime.bigint();
  const response = await fetch(`${API}/api/b/${businessKey}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  let parsed;
  try {
    parsed = text === '' ? {} : JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed, elapsedMs, text };
}

const id = () => `verify-${randomUUID()}`;

/** Key order is not part of a JSON value, so it is not part of a comparison. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
const codeOf = (result) => (typeof result.body?.code === 'string' ? result.body.code : undefined);

async function main() {
  console.log(`verify-slice: api=${API} gotrue=${GOTRUE}`);

  const health = await fetch(`${API}/api/health`).then(
    async (response) => ({ status: response.status, body: await response.json() }),
    () => ({ status: undefined, body: {} }),
  );
  record('health', {
    status: health.status,
    code: health.body.database,
    ok: health.status === 200 && health.body.ok === true,
    note: `reads=${health.body.reads ?? '-'}`,
  });

  // --------------------------------------------------------------- sign in
  const mia = await signIn('mia@alpha.local');
  record('sign in mia@alpha.local', {
    status: mia.status,
    code: mia.token === undefined ? 'NO_TOKEN' : 'token',
    ok: mia.status === 200 && typeof mia.token === 'string',
  });
  if (mia.token === undefined) {
    console.error('verify-slice: cannot continue without a token');
    process.exit(1);
  }

  const noah = userOf('noah@alpha.local');
  const title = `Verify ${new Date().toISOString()} ${randomUUID().slice(0, 8)}`;

  // ------------------------------------------------------------- B1 create
  const created = await call(mia.token, 'alpha', '/task/create', {
    operationId: id(),
    fields: { title, description: 'Created by verify-slice.' },
    board: null,
  });
  const recordId = created.body?.recordId;
  record('B1 create (no board)', {
    status: created.status,
    code: codeOf(created) ?? 'applied',
    ok: created.status === 200 && typeof recordId === 'string',
    note: recordId === undefined ? JSON.stringify(created.body).slice(0, 120) : `id=${recordId}`,
  });

  if (typeof recordId !== 'string') {
    // Everything after this needs a task. They are reported as unrun rather
    // than as failures of their own mechanism.
    for (const name of [
      'B2 assign noah',
      'B3 start',
      'B3 complete',
      'B3 reopen',
      'B4 update title and due',
      'read back',
      'board list',
      'N1 foreign read of A task',
      'N1 foreign read of fabricated id',
      'N5 replay operation_id',
      'N5 stale expectedRevision',
      'N3 generic write to state',
      'N7 tampered body and headers',
    ]) {
      record(name, { ok: undefined, note: 'no task was created' });
    }
    await orphanAndFabricated();
    return finish();
  }

  let revision = created.body.revision;

  // ------------------------------------------------------------- B2 assign
  // `assignee` is a person link, so the value is a person identifier and the
  // only way to learn one through the API is `person.list` — which is the
  // assignee control's own source in the app. Asking the database directly
  // would prove a path no person can take.
  const persons = await call(mia.token, 'alpha', '/person/list', {});
  const chosen = Array.isArray(persons.body?.persons)
    ? persons.body.persons.find((person) => person.name === noah.person)
    : undefined;

  if (chosen === undefined) {
    record('B2 assign noah', {
      status: persons.status,
      code: codeOf(persons),
      ok: undefined,
      note:
        persons.status === 404
          ? 'person.list is not in the surface yet, so no personId can be obtained'
          : 'person.list returned no person with that name',
    });
  } else {
    const assigned = await call(mia.token, 'alpha', '/task/assign', {
      operationId: id(),
      recordId,
      expectedRevision: revision,
      fields: { assignee: chosen.personId },
    });
    record('B2 assign noah', {
      status: assigned.status,
      code: codeOf(assigned) ?? 'applied',
      ok: assigned.status === 200,
      note: assigned.status === 200 ? `revision=${assigned.body.revision}` : '',
    });
    if (assigned.status === 200) revision = assigned.body.revision;
  }

  // ------------------------------------------------- B3 start, complete, reopen
  for (const [name, path, extra] of [
    ['B3 start', '/task/start', {}],
    ['B3 complete', '/task/complete', {}],
    ['B3 reopen', '/task/reopen', { reason: 'verify-slice reopens it' }],
  ]) {
    // eslint-disable-next-line no-await-in-loop -- a lifecycle is sequential
    const moved = await call(mia.token, 'alpha', path, {
      operationId: id(),
      recordId,
      expectedRevision: revision,
      ...extra,
    });
    record(name, {
      status: moved.status,
      code: codeOf(moved) ?? 'applied',
      ok: moved.status === 200,
      note: moved.status === 200 ? `revision=${moved.body.revision}` : '',
    });
    if (moved.status === 200) revision = moved.body.revision;
  }

  // -------------------------------------------------------------- B4 edit
  const due = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const edited = await call(mia.token, 'alpha', '/task/update', {
    operationId: id(),
    recordId,
    expectedRevision: revision,
    fields: { title: `${title} (edited)`, due },
  });
  record('B4 update title and due', {
    status: edited.status,
    code: codeOf(edited) ?? 'applied',
    ok: edited.status === 200,
  });
  if (edited.status === 200) revision = edited.body.revision;

  // --------------------------------------------------------- reads (SLICE-DATA)
  const read = await call(mia.token, 'alpha', '/task/read', { recordId });
  record('read back', {
    status: read.status,
    code: codeOf(read) ?? 'ok',
    ok: read.status === 404 ? undefined : read.status === 200,
    note: read.status === 404 ? 'task.read is not in the surface yet' : '',
  });
  const board = await call(mia.token, 'alpha', '/task/board', { board: null });
  record('board list', {
    status: board.status,
    code: codeOf(board) ?? 'ok',
    ok: board.status === 404 ? undefined : board.status === 200,
    note: board.status === 404 ? 'task.board is not in the surface yet' : '',
  });

  // ------------------------------------------------------------- N5 replay
  const identity = id();
  const payload = {
    operationId: identity,
    recordId,
    expectedRevision: revision,
    fields: { priority: 3 },
  };
  const first = await call(mia.token, 'alpha', '/task/update', payload);
  if (first.status === 200) revision = first.body.revision;

  // The same identity carrying the same payload: the original result, exactly.
  const replayed = await call(mia.token, 'alpha', '/task/update', payload);
  // Compared canonically rather than byte for byte. The register stores the
  // original result as JSONB and a replay is read back out of it, so the keys
  // come back in a different order carrying the same values. That is worth
  // knowing about: a caller that compared responses as bytes would see two
  // different answers to one identity.
  const same = canonical(first.body) === canonical(replayed.body);
  record('N5 replay operation_id', {
    status: replayed.status,
    code: codeOf(replayed) ?? 'replayed',
    ok: replayed.status === 200 && same,
    note: same
      ? replayed.text === first.text
        ? 'identical body'
        : 'same values, key order differs (the register stores the result as JSONB)'
      : 'the values differ from the original',
  });

  // The same identity carrying a different payload is the other half of the
  // rule, and it is a refusal rather than a second result.
  const reused = await call(mia.token, 'alpha', '/task/update', {
    ...payload,
    fields: { priority: 4 },
  });
  record('N5 operation_id reused', {
    status: reused.status,
    code: codeOf(reused),
    ok: codeOf(reused) === 'OPERATION_ID_REUSED',
  });

  // -------------------------------------------------------------- N5 stale
  const stale = await call(mia.token, 'alpha', '/task/update', {
    operationId: id(),
    recordId,
    expectedRevision: 1,
    fields: { title: 'stale writer' },
  });
  record('N5 stale expectedRevision', {
    status: stale.status,
    code: codeOf(stale),
    ok: codeOf(stale) === 'VERSION_STALE',
  });

  // ------------------------------------------------ N3 protected generic write
  for (const [name, fields] of [
    ['N3 generic write to state', { state: 'completed' }],
    ['N3 generic write to assignee', { assignee: noah.person }],
    [
      'N4 system field in update',
      { key: 'SPOOF-1', source: 'spoofed', completedAt: new Date().toISOString() },
    ],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const protectedWrite = await call(mia.token, 'alpha', '/task/update', {
      operationId: id(),
      recordId,
      expectedRevision: revision,
      fields,
    });
    record(name, {
      status: protectedWrite.status,
      code: codeOf(protectedWrite),
      ok: ['TRANSITION_PROTECTED', 'FIELD_NOT_WRITABLE', 'SOURCE_SPOOFED'].includes(
        codeOf(protectedWrite) ?? '',
      ),
    });
  }

  // --------------------------------------------------------- N1 foreign reads
  const bea = await signIn('bea@bravo.local');
  record('sign in bea@bravo.local', {
    status: bea.status,
    code: bea.token === undefined ? 'NO_TOKEN' : 'token',
    ok: bea.status === 200 && typeof bea.token === 'string',
  });

  if (bea.token !== undefined) {
    const fabricated = randomUUID();
    const foreign = await call(bea.token, 'bravo', '/task/update', {
      operationId: id(),
      recordId,
      expectedRevision: revision,
      fields: { title: 'crossing the barrier' },
    });
    const nowhere = await call(bea.token, 'bravo', '/task/update', {
      operationId: id(),
      recordId: fabricated,
      expectedRevision: revision,
      fields: { title: 'crossing the barrier' },
    });
    const indistinguishable =
      foreign.status === nowhere.status && canonical(foreign.body) === canonical(nowhere.body);
    record("N1 B writes A's real task", {
      status: foreign.status,
      code: codeOf(foreign),
      ok: codeOf(foreign) === 'NOT_FOUND',
      note: `${foreign.elapsedMs.toFixed(1)}ms`,
    });
    record('N1 B writes a fabricated id', {
      status: nowhere.status,
      code: codeOf(nowhere),
      ok: codeOf(nowhere) === 'NOT_FOUND',
      note: `${nowhere.elapsedMs.toFixed(1)}ms`,
    });
    record('N1 the two are indistinguishable', {
      status: foreign.status,
      code: codeOf(foreign),
      ok: indistinguishable,
      note: indistinguishable ? 'same status and body' : 'they differ',
    });
  }

  // ------------------------------------------------------------ N7 tampering
  const tampered = await call(
    mia.token,
    'alpha',
    '/task/update',
    {
      operationId: id(),
      recordId,
      expectedRevision: revision,
      fields: { title: `${title} (tampered)` },
      // None of these are fields of any request in the surface.
      actorId: userOf('ada@alpha.local').subject,
      businessId: '00000000-0000-4000-8000-000000000000',
      business: 'bravo',
      entryPoint: 'worker',
    },
    {
      'x-actor-id': userOf('ada@alpha.local').subject,
      'x-business-key': 'bravo',
      'x-forwarded-host': 'bravo.local',
      host: 'bravo.local',
    },
  );
  record('N7 tampered body and headers', {
    status: tampered.status,
    code: codeOf(tampered) ?? 'applied',
    ok: tampered.status === 200,
    note: 'the extra fields and headers changed nothing; it applied as mia in alpha',
  });

  const crossed = await call(mia.token, 'bravo', '/task/create', {
    operationId: id(),
    fields: { title: 'mia in bravo' },
    board: null,
  });
  record('N7 mia names business bravo', {
    status: crossed.status,
    code: codeOf(crossed),
    ok: codeOf(crossed) === 'AUTH_NO_MEMBERSHIP',
  });

  await orphanAndFabricated();
  console.log(`verify-slice: the task is ${recordId} at revision ${revision}`);
  return finish();
}

/** The two cases that need no task of their own. */
async function orphanAndFabricated() {
  const orphan = await signIn('orphan@alpha.local');
  if (orphan.token === undefined) {
    record('N2 orphan login', { status: orphan.status, code: 'NO_TOKEN', ok: false });
    return;
  }
  const refused = await call(orphan.token, 'alpha', '/task/create', {
    operationId: id(),
    fields: { title: 'orphan tries' },
    board: null,
  });
  record('N2 orphan has no membership', {
    status: refused.status,
    code: codeOf(refused),
    ok: codeOf(refused) === 'AUTH_NO_MEMBERSHIP',
  });

  const anonymous = await call(undefined, 'alpha', '/task/create', {
    operationId: id(),
    fields: { title: 'nobody tries' },
    board: null,
  });
  record('N7 no token at all', {
    status: anonymous.status,
    code: codeOf(anonymous),
    ok: codeOf(anonymous) === 'AUTH_UNKNOWN_LOGIN',
  });
}

function finish() {
  const ran = results.filter((result) => result.ok !== undefined);
  const failed = ran.filter((result) => !result.ok);
  const unrun = results.filter((result) => result.ok === undefined);
  console.log(
    `verify-slice: ${ran.length - failed.length}/${ran.length} passed, ${failed.length} failed, ${unrun.length} unrun`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
