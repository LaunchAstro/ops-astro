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

// The agent logins the seed mints. They are read the same way and signed in
// the same way; what differs is who the token resolves to, which is the whole
// of the difference between the two entry points.
const agents = JSON.parse(readFileSync(join(LOCAL, 'synthetic-agents.json'), 'utf8'));
const agentOf = (businessKey) => {
  const found = agents.find((agent) => agent.business === businessKey);
  if (found === undefined) {
    throw new Error(`verify-slice: no agent for ${businessKey} in synthetic-agents.json`);
  }
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

/**
 * The same call on the agent's own entry point. The delegation credential
 * travels in a header rather than in the body, so nothing that is logged with
 * the payload or digested into the register row carries it.
 */
async function callAgent(token, businessKey, path, body, delegation) {
  const response = await fetch(`${API}/api/a/b/${businessKey}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(delegation === undefined ? {} : { 'x-agent-delegation': delegation }),
    },
    // The agent envelope is the command envelope: every call carries an
    // operation identity, reads included, because a replayed read is still a
    // register row.
    body: JSON.stringify({ operationId: id(), ...body }),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text === '' ? {} : JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed, text };
}

/** An agent login signs in through the same GoTrue a person does. */
async function signInAgent(businessKey) {
  const agent = agentOf(businessKey);
  const response = await fetch(`${GOTRUE}/token?grant_type=password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: agent.email, password: agent.password }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, token: body.access_token, agent };
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
/** What the command reports doing. `recordId` and `revision` sit beside it. */
const detailOf = (result) => result.body?.detail ?? result.body ?? {};
const codeOf = (result) => (typeof result.body?.code === 'string' ? result.body.code : undefined);

async function main() {
  // The addresses come from the same environment as the passwords, so they are
  // named rather than printed; the defaults are 127.0.0.1:8790 and :54391.
  console.log('verify-slice: against API_URL (or API_PORT) and GOTRUE_URL');

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
      'B1 a created task has a state',
      'B1 task.read takes the key the address carries',
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

  // A created task carries a state. `state` is protected, the application
  // sends no `stateKey`, and until the server placed one every task the app
  // made arrived stateless -- which the read contract says cannot happen.
  record('B1 a created task has a state', {
    status: read.status,
    code: read.body?.task?.state?.key ?? 'null',
    ok: read.status === 200 && read.body?.task?.state?.machineCategory === 'unstarted',
    note: 'created without a stateKey; the server places the first unstarted state',
  });

  // The address a person reads out is the key, so the read takes one.
  const taskKey = read.body?.task?.key;
  const byKey =
    typeof taskKey === 'string'
      ? await call(mia.token, 'alpha', '/task/read', { recordId: taskKey })
      : { status: 0, body: {} };
  record('B1 task.read takes the key the address carries', {
    status: byKey.status,
    code: codeOf(byKey) ?? 'ok',
    ok: byKey.status === 200 && byKey.body?.task?.id === recordId,
    note: typeof taskKey === 'string' ? `key=${taskKey}` : 'no key came back',
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
    // The same pair as a read, which is the shape the checklist names: a
    // permitted person in B asking for A's real task and for one that never
    // existed has to get one answer, not two.
    const foreignRead = await call(bea.token, 'bravo', '/task/read', { recordId });
    const nowhereRead = await call(bea.token, 'bravo', '/task/read', { recordId: fabricated });
    const readsAlike =
      foreignRead.status === nowhereRead.status &&
      canonical(foreignRead.body) === canonical(nowhereRead.body);
    record("N1 B reads A's real task", {
      status: foreignRead.status,
      code: codeOf(foreignRead),
      ok: codeOf(foreignRead) === 'NOT_FOUND',
      note: `${foreignRead.elapsedMs.toFixed(1)}ms`,
    });
    record('N1 B reads a fabricated id', {
      status: nowhereRead.status,
      code: codeOf(nowhereRead),
      ok: codeOf(nowhereRead) === 'NOT_FOUND',
      note: `${nowhereRead.elapsedMs.toFixed(1)}ms`,
    });
    record('N1 the two reads are indistinguishable', {
      status: foreignRead.status,
      code: codeOf(foreignRead),
      ok: readsAlike,
      note: readsAlike ? 'same status and body' : 'they differ',
    });

    record('N1 the two are indistinguishable', {
      status: foreign.status,
      code: codeOf(foreign),
      ok: indistinguishable,
      note: indistinguishable ? 'same status and body' : 'they differ',
    });
  }

  // ------------------------------------------------------------ N7 tampering
  // Three halves, and the row passes only if all three hold. Before D06
  // (`81f9697`) the injected body keys were silently dropped and the write
  // applied, and this row accepted that as the proof. It no longer does: a
  // successful ordinary change after quietly discarding an identity field
  // tells an attacker nothing was wrong with what they sent.
  const spoofActor = userOf('ada@alpha.local').subject;
  const forgedHeaders = {
    'x-actor-id': spoofActor,
    'x-business-key': 'bravo',
    'x-forwarded-host': 'bravo.local',
    host: 'bravo.local',
  };

  // The task as it stands, and who its writes are recorded under. Both are
  // read through the API, because the API is the only thing this script may
  // use -- and every write on this task so far was mia's, so the history
  // carries exactly one actor and it is hers.
  const beforeTamper = await call(mia.token, 'alpha', '/task/read', { recordId });
  const historyBefore = beforeTamper.body?.task?.history ?? [];
  const actorsBefore = new Set(historyBefore.map((entry) => entry.actorId));

  // 1. Body injection: the typed refusal, the offending keys by name, and a
  //    task nobody moved.
  const tampered = await call(
    mia.token,
    'alpha',
    '/task/update',
    {
      operationId: id(),
      recordId,
      expectedRevision: revision,
      fields: { title: `${title} (tampered)` },
      // None of these is a field of any request in the surface. Every one of
      // them is a fact the server derives for itself.
      actorId: spoofActor,
      businessId: '00000000-0000-4000-8000-000000000000',
      entryPoint: 'worker',
    },
    forgedHeaders,
  );
  const named = Array.isArray(tampered.body?.names) ? [...tampered.body.names].toSorted() : [];
  const namesRight = canonical(named) === canonical(['actorId', 'businessId', 'entryPoint']);
  const afterTamper = await call(mia.token, 'alpha', '/task/read', { recordId });
  const dataHeld =
    beforeTamper.status === 200 &&
    afterTamper.status === 200 &&
    afterTamper.body?.task?.revision === beforeTamper.body?.task?.revision &&
    canonical(afterTamper.body?.task) === canonical(beforeTamper.body?.task);
  const bodyHalf =
    tampered.status === 422 && codeOf(tampered) === 'FIELD_NOT_WRITABLE' && namesRight && dataHeld;

  // 2. Header-only tampering: the same session, a clean payload, the same
  //    forged headers. It has to *succeed*, and the actor it is recorded
  //    under has to be the session's. HTTP 200 on its own proves nothing
  //    here -- a server that believed `x-actor-id` would also answer 200.
  const headerOnly = await call(
    mia.token,
    'alpha',
    '/task/update',
    {
      operationId: id(),
      recordId,
      expectedRevision: revision,
      fields: { title: `${title} (headers only)` },
    },
    forgedHeaders,
  );
  if (headerOnly.status === 200) revision = headerOnly.body.revision;
  const afterHeaders = await call(mia.token, 'alpha', '/task/read', { recordId });
  const historyAfter = afterHeaders.body?.task?.history ?? [];
  const actorsAfter = new Set(historyAfter.map((entry) => entry.actorId));
  const wroteAs = [...actorsAfter][0];
  const headerHalf =
    headerOnly.status === 200 &&
    historyAfter.length === historyBefore.length + 1 &&
    // One actor before and one after: the forged header added no second one.
    actorsBefore.size === 1 &&
    actorsAfter.size === 1 &&
    wroteAs === [...actorsBefore][0] &&
    wroteAs !== spoofActor &&
    // And the business is the path's, not the header's: the write landed on
    // alpha's task. `N1 B reads A's real task` is the other side of that coin.
    afterHeaders.body?.task?.id === recordId;

  // 3. The positive control: the permitted request, no tampering at all.
  const control = await call(mia.token, 'alpha', '/task/update', {
    operationId: id(),
    recordId,
    expectedRevision: revision,
    fields: { title: `${title} (edited)` },
  });
  if (control.status === 200) revision = control.body.revision;

  record('N7 tampered body and headers', {
    status: tampered.status,
    code: codeOf(tampered) ?? 'applied',
    ok: bodyHalf && headerHalf && control.status === 200,
    note: [
      bodyHalf ? `body refused names=[${named.join(',')}], data unchanged` : 'BODY HALF FAILED',
      headerHalf ? 'headers-only applied as the session actor' : 'HEADER HALF FAILED',
      control.status === 200 ? 'control applied' : `CONTROL HTTP ${control.status}`,
    ].join('; '),
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

  await noahHasNoScope(recordId);
  await orphanAndFabricated();
  // Rows 33 onward. Everything above is the record slice; this is the runtime
  // journey, and it is appended rather than interleaved so rows 1-32 keep
  // their order and their numbers.
  await theJourney();
  console.log(`verify-slice: the task is ${recordId} at revision ${revision}`);
  return finish();
}

/**
 * N2's in-business half: a real member of A who holds no task collection scope.
 *
 * He is a member, so the membership check passes and the refusal has to come
 * from authority rather than from identity -- which is the whole point of the
 * case, and why `.local/synthetic-users.json` gives him `"grants": []` and the
 * seed revokes anything an earlier run left him.
 */
async function noahHasNoScope(recordId) {
  const noah = await signIn('noah@alpha.local');
  if (noah.token === undefined) {
    record('N2 noah login', { status: noah.status, code: 'NO_TOKEN', ok: false });
    return;
  }
  const cases = [
    ['N2 noah reads the board', '/task/board', { board: null }],
    ['N2 noah reads the task', '/task/read', { recordId }],
    ['N2 noah lists people', '/person/list', {}],
  ];
  // Three independent refusals against a token with no scope; nothing one of
  // them does changes what another sees, so they go out together and are
  // recorded in the order they are written.
  const refusals = await Promise.all(
    cases.map(async ([, path, body]) => await call(noah.token, 'alpha', path, body)),
  );
  for (const [index, [name]] of cases.entries()) {
    record(name, {
      status: refusals[index].status,
      code: codeOf(refusals[index]),
      ok: codeOf(refusals[index]) === 'SCOPE_NOT_GRANTED',
    });
  }
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

/**
 * Rows 33 onward: the runtime journey, walked over HTTP by a person and an
 * agent rather than in process.
 *
 * What it can prove today and what it cannot are both recorded. `task.decide`
 * is declared with the action `decide` (`commands/surface.ts`) and
 * `authority/grants.ts` matches `(collection, action)` exactly -- there is no
 * implication from `manage` -- so until a seeded identity holds `task:decide`
 * every decision here is `SCOPE_NOT_GRANTED` and everything downstream of it
 * is printed `unrun` with that reason rather than skipped or called a pass.
 * The grant goes into `scripts/local-seed.mjs`; a stack seeded before it was
 * added stays refused until it is reseeded.
 */
async function theJourney() {
  const ada = await signIn('ada@alpha.local');
  record('J1 sign in ada@alpha.local', {
    status: ada.status,
    code: ada.token === undefined ? 'NO_TOKEN' : 'token',
    ok: ada.status === 200 && typeof ada.token === 'string',
    note: 'the admin, who is who a decision belongs to',
  });
  if (ada.token === undefined) return;

  const made = await call(ada.token, 'alpha', '/task/create', {
    operationId: id(),
    fields: { title: `Journey ${new Date().toISOString()}`, description: 'Proposed against.' },
    board: null,
  });
  const subject = made.body?.recordId;
  record('J2 a task to propose against', {
    status: made.status,
    code: codeOf(made) ?? 'applied',
    ok: made.status === 200 && typeof subject === 'string',
    note: typeof subject === 'string' ? `id=${subject}` : '',
  });
  if (typeof subject !== 'string') return;

  // A sibling task the same person may write perfectly well. It is what makes
  // the agent's one-task ceiling a ceiling rather than a coincidence.
  const siblingMade = await call(ada.token, 'alpha', '/task/create', {
    operationId: id(),
    fields: { title: 'A sibling the agent may not reach' },
    board: null,
  });
  const sibling = siblingMade.body?.recordId;

  const proposed = await call(ada.token, 'alpha', '/task/propose', {
    operationId: id(),
    recordId: subject,
    expectedRevision: made.body.revision,
    purpose: 'draft_the_reply',
    maximumMinor: 2_500,
    currency: 'AUD',
    payload: { instruction: 'draft a reply to the client' },
    step: { kind: 'compose', payload: { tone: 'plain' } },
  });
  const versionId = detailOf(proposed).versionId;
  const gateId = detailOf(proposed).gateId;
  record('J3 propose on the task as a person', {
    status: proposed.status,
    code: codeOf(proposed) ?? 'applied',
    ok: proposed.status === 200 && typeof versionId === 'string' && typeof gateId === 'string',
    note: proposed.status === 200 ? `version=${detailOf(proposed).version}` : '',
  });

  // The version, the digest and the evidence come back on `task.read`, not
  // from a second read, because the decision control carries the `versionId`
  // the page displayed the evidence for.
  const projected = await call(ada.token, 'alpha', '/task/read', { recordId: subject });
  const lineage = (projected.body?.task?.proposals ?? [])[0];
  const head = lineage?.versions?.[0];
  record('J4 the projection carries the version, digest and evidence', {
    status: projected.status,
    code: codeOf(projected) ?? 'ok',
    ok:
      projected.status === 200 &&
      head?.versionId === versionId &&
      typeof head?.payloadDigest === 'string' &&
      head.payloadDigest.length === 64 &&
      head?.evidence?.renderer === 'core-runtime/evidence@1' &&
      head?.gate?.id === gateId,
    note:
      head === undefined
        ? 'no proposal came back on the detail'
        : `renderer=${head.evidence?.renderer ?? '-'} gate=${head.gate?.state ?? '-'}`,
  });

  const queueBefore = await call(ada.token, 'alpha', '/task/queue', {});
  record('J5 task.queue is readable and holds no reservation yet', {
    status: queueBefore.status,
    code: codeOf(queueBefore) ?? 'ok',
    ok:
      queueBefore.status === 200 &&
      Array.isArray(queueBefore.body?.queue) &&
      !queueBefore.body.queue.some((entry) => entry.taskId === subject),
    note: `entries=${queueBefore.body?.queue?.length ?? '-'}`,
  });

  // ------------------------------------------------------------- the agent
  const agent = await signInAgent('alpha');
  record('J6 sign in the alpha agent', {
    status: agent.status,
    code: agent.token === undefined ? 'NO_TOKEN' : 'token',
    ok: agent.status === 200 && typeof agent.token === 'string',
    note: 'the same GoTrue a person signs in through; what differs is who it resolves to',
  });

  if (agent.token !== undefined) {
    const agentQueue = await callAgent(agent.token, 'alpha', '/task/queue', {});
    record('J7 the agent reads the queue before any pickup', {
      status: agentQueue.status,
      code: codeOf(agentQueue) ?? 'ok',
      ok: agentQueue.status === 200 && Array.isArray(detailOf(agentQueue).queue),
      note: 'reading the queue claims nothing',
    });

    // An agent login confers nothing at all. A bare call, with no credential,
    // outside the queue and a pickup is excluded by name (root ruling 6 at
    // dd30aa8; `agent-envelope.ts`, the no-credential branch). A credential
    // that is presented and not live is another matter: it stays one answer,
    // DELEGATION_NOT_LIVE, because telling an unknown credential apart from a
    // revoked one tells a thief which it is holding.
    const closed = await callAgent(agent.token, 'alpha', '/task/read', { recordId: subject });
    record('J8 a bare call outside queue and pickup is DELEGATION_EXCLUDES_OPERATION', {
      status: closed.status,
      code: codeOf(closed),
      ok: codeOf(closed) === 'DELEGATION_EXCLUDES_OPERATION',
    });

    const personThere = await callAgent(ada.token, 'alpha', '/task/queue', {});
    record('J9 a person on the agent prefix is AUTH_NO_AGENT_IDENTITY', {
      status: personThere.status,
      code: codeOf(personThere),
      ok: codeOf(personThere) === 'AUTH_NO_AGENT_IDENTITY',
    });

    const agentHere = await call(agent.token, 'alpha', '/task/queue', {});
    record('J10 an agent on the person prefix is AUTH_NO_MEMBERSHIP', {
      status: agentHere.status,
      code: codeOf(agentHere),
      ok: codeOf(agentHere) === 'AUTH_NO_MEMBERSHIP',
    });
  }

  // ------------------------------------------------------------ the decision
  const decided = await call(ada.token, 'alpha', '/task/decide', {
    operationId: id(),
    gateId,
    versionId,
    decision: 'approve',
    note: 'verify-slice approves the exact version it read',
  });
  const ungranted = codeOf(decided) === 'SCOPE_NOT_GRANTED';
  const blocked = ungranted
    ? 'no seeded identity holds task:decide; scripts/local-seed.mjs grants it, this stack predates the reseed'
    : undefined;
  record('J11 decide the exact version as a person', {
    status: decided.status,
    code: codeOf(decided) ?? 'applied',
    ok: ungranted ? undefined : decided.status === 200,
    note: blocked ?? `reservation=${detailOf(decided).reservationId ?? '-'}`,
  });

  // Everything past the decision depends on a reservation only a decision can
  // make, so each is printed with the reason rather than skipped.
  const downstream = [
    'J12 the reservation is held and task.queue shows it',
    'J13 the agent picks it up on the agent prefix',
    'J14 a sibling read is DELEGATION_OUT_OF_PURPOSE',
    'J15 the agent hands back and the queue no longer shows it',
    'J16 a stale-version decision is VERSION_SUPERSEDED with unchanged state',
  ];
  if (decided.status !== 200) {
    for (const name of downstream) {
      record(name, { ok: undefined, note: blocked ?? `the decision answered ${codeOf(decided)}` });
    }
    return;
  }

  const reservationId = detailOf(decided).reservationId;
  const queueAfter = await call(ada.token, 'alpha', '/task/queue', {});
  const onQueue = (queueAfter.body?.queue ?? []).find(
    (entry) => entry.reservationId === reservationId,
  );
  record(downstream[0], {
    status: queueAfter.status,
    code: codeOf(queueAfter) ?? 'ok',
    ok: queueAfter.status === 200 && onQueue !== undefined,
    note:
      onQueue === undefined ? 'the reservation is not on the queue' : `purpose=${onQueue.purpose}`,
  });

  if (agent.token === undefined) {
    for (const name of downstream.slice(1)) {
      record(name, { ok: undefined, note: 'the agent could not sign in' });
    }
    return;
  }

  const picked = await callAgent(agent.token, 'alpha', '/task/pickup', {
    operationId: id(),
    reservationId,
  });
  const credential = detailOf(picked).credential;
  record(downstream[1], {
    status: picked.status,
    code: codeOf(picked) ?? 'applied',
    ok: picked.status === 200 && typeof credential === 'string',
    note:
      picked.status === 200
        ? `scope=${detailOf(picked).purposeScope?.id ?? '-'} fence=${detailOf(picked).fence}`
        : '',
  });
  if (typeof credential !== 'string') {
    for (const name of downstream.slice(2)) {
      record(name, { ok: undefined, note: 'the pickup handed back no credential' });
    }
    return;
  }

  // The ceiling, with its own control: the agent may reach the one task it was
  // minted for and not the sibling, and the person read of that sibling in the
  // same breath proves the sibling is there to be reached.
  const own = await callAgent(
    agent.token,
    'alpha',
    '/task/read',
    { recordId: subject },
    credential,
  );
  const other = await callAgent(
    agent.token,
    'alpha',
    '/task/read',
    { recordId: sibling },
    credential,
  );
  const personSees = await call(ada.token, 'alpha', '/task/read', { recordId: sibling });
  record(downstream[2], {
    status: other.status,
    code: codeOf(other),
    ok:
      own.status === 200 &&
      codeOf(other) === 'DELEGATION_OUT_OF_PURPOSE' &&
      personSees.status === 200,
    note: 'not NOT_FOUND: the sibling is there and the agent may not reach it',
  });

  const handedBack = await callAgent(
    agent.token,
    'alpha',
    '/task/handback',
    {
      operationId: id(),
      leaseId: detailOf(picked).leaseId,
      fence: detailOf(picked).fence,
      outcome: 'completed',
      report: { note: 'verify-slice walked the journey' },
    },
    credential,
  );
  const queueSettled = await call(ada.token, 'alpha', '/task/queue', {});
  const stillThere = (queueSettled.body?.queue ?? []).some(
    (entry) => entry.reservationId === reservationId,
  );
  record(downstream[3], {
    status: handedBack.status,
    code: codeOf(handedBack) ?? 'applied',
    ok: handedBack.status === 200 && !stillThere,
    note: stillThere ? 'the reservation is still on the queue' : 'the queue no longer shows it',
  });

  // A decision made from a page that went stale. The live gate is the one the
  // second proposal raised; naming it with the version the decider read before
  // that proposal landed is what `VERSION_SUPERSEDED` is for.
  const first = await call(ada.token, 'alpha', '/task/propose', {
    operationId: id(),
    recordId: sibling,
    expectedRevision: siblingMade.body.revision,
    purpose: 'draft_the_reply',
    maximumMinor: 2_500,
    currency: 'AUD',
    payload: { instruction: 'the version the decider read' },
    step: { kind: 'compose', payload: {} },
  });
  const second = await call(ada.token, 'alpha', '/task/propose', {
    operationId: id(),
    recordId: sibling,
    expectedRevision: siblingMade.body.revision,
    purpose: 'draft_the_reply',
    maximumMinor: 2_500,
    currency: 'AUD',
    payload: { instruction: 'the version that landed while they read' },
    step: { kind: 'compose', payload: {} },
    lineageId: detailOf(first).lineageId,
  });
  const before = await call(ada.token, 'alpha', '/task/read', { recordId: sibling });
  const stale = await call(ada.token, 'alpha', '/task/decide', {
    operationId: id(),
    gateId: detailOf(second).gateId,
    versionId: detailOf(first).versionId,
    decision: 'approve',
    note: 'decided from a page that went stale',
  });
  const after = await call(ada.token, 'alpha', '/task/read', { recordId: sibling });
  const held = canonical(before.body?.task?.proposals) === canonical(after.body?.task?.proposals);
  record(downstream[4], {
    status: stale.status,
    code: codeOf(stale),
    ok: codeOf(stale) === 'VERSION_SUPERSEDED' && held,
    note: held ? 'nothing on the lineage moved' : 'THE LINEAGE MOVED',
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
