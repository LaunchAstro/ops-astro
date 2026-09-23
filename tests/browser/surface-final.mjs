// SPDX-License-Identifier: AGPL-3.0-only
//
// Mounted-browser rows for the field, planner and external-party boundaries,
// every call made by the web's own `operations/client.ts` inside the page.
//
// `throughClient` imports the client module Vite serves to the browser and
// calls it with the session the person signed in with through the real form,
// so each row crosses the whole mounted boundary: the page, the Vite proxy,
// the running API and Postgres. The in-process web assertions
// (`tests/acceptance/protected-fields.test.ts`, `tests/records/preset-plan.test.ts`)
// prove the rule; these prove the browser reaches it, and that a refusal left
// the stored record as it was.
//
// Rows:
//   D03 client, client_visible, delegate: `task.update` naming each field is
//       refused `TRANSITION_PROTECTED` naming `key=<owning operations>`, derived
//       from `TASK_SPINE`, and the stored `data`, slot and revision are unchanged.
//   D05 preset.plan: a classified plan answers ok and adds no `field_defs` row;
//       a plan with an unclassified field is refused `PRESET_FIELD_UNCLASSIFIED`
//       naming only that key, again with no `field_defs` row added.
//   R4X the external party, signed in through GoTrue by the form: the shared
//       task reads as `sharedTask`, the sibling task and the board are refused,
//       and after `grant.revoke` the shared task is refused too.
//
// Run: WEB_URL=... API_URL=... SHOT_DIR=... node tests/browser/surface-final.mjs

import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { TASK_SPINE } from '../../packages/core-records/src/tasks/spine.ts';
import { connect, connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import {
  VIEWPORT,
  closeQuietly,
  fromEnvFile,
  inOrder,
  record,
  shot,
  signIn,
  standaloneStatus,
  throughClient,
  users,
} from './harness.mjs';
import { callApi, sharedTask, tokenOf } from './i10-open-page.mjs';

const D03_FIELDS = ['client', 'client_visible', 'delegate'];

/** A value of the field's own type, so the refusal is the protection and not the type. */
const ATTEMPT = {
  client: randomUUID(),
  client_visible: true,
  delegate: randomUUID(),
};

const step = (what) => {
  process.stderr.write(`surface-final: ${what}\n`);
};

/** The stored row a refusal must leave alone: data, every slot, revision. */
async function storedTask(admin, alpha, recordId) {
  const rows = await admin.execute(
    'select to_jsonb(r) - $3 as row from public.records r where business_id = $1 and id = $2',
    [alpha, recordId, 'updated_at'],
  );
  return JSON.stringify(rows[0]?.row);
}

async function fieldDefCount(admin, alpha) {
  const rows = await admin.execute(
    'select count(*)::int as n from public.field_defs where business_id = $1',
    [alpha],
  );
  return rows[0]?.n;
}

const refusalOf = (result) =>
  'refused' in result ? `${result.code} [${result.names.join(', ')}]` : JSON.stringify(result);

async function casesD03(run, recordId) {
  const { page, admin, alpha } = run;
  // One cell after another: each reads the revision the last one left, so a
  // cell that wrongly wrote cannot turn the next one stale.
  await inOrder(D03_FIELDS, async (key) => {
    const revision = Number(
      (await admin.execute('select revision from public.records where id = $1', [recordId]))[0]
        ?.revision,
    );
    const field = TASK_SPINE.find((entry) => entry.key === key);
    const expected = `TRANSITION_PROTECTED [${key}=${field.owningOperations.join(' ')}]`;
    const before = await storedTask(admin, alpha, recordId);
    const { result } = await throughClient(page, {
      name: 'task.update',
      body: { recordId, fields: { [key]: ATTEMPT[key] } },
      options: { expectedRevision: revision },
    });
    const after = await storedTask(admin, alpha, recordId);
    const observed = refusalOf(result);
    record({
      case: `D03 browser ${key}`,
      action: `task.update {${key}} through operations/client.ts in the page`,
      observed: `${observed}; stored row ${before === after ? 'unchanged' : 'CHANGED'}`,
      ok: observed === expected && before === after,
    });
  });
}

async function casesD05(run) {
  const { page, admin, alpha } = run;
  const plan = async (fields) =>
    (
      await throughClient(page, {
        read: true,
        name: 'preset.plan',
        body: { recordTypeKey: 'task', presetKey: 'agency', fields },
      })
    ).result;

  const before = await fieldDefCount(admin, alpha);
  const accepted = await plan([
    {
      key: `sf_classified_${String(Date.now())}`,
      label: 'Classified',
      valueType: 'text',
      writeMode: 'generic',
      visibilityClass: 'internal',
    },
  ]);
  const afterAccepted = await fieldDefCount(admin, alpha);
  const actions = accepted.ok === true ? accepted.value.plan.actions.length : undefined;
  record({
    case: 'D05 browser plan classified',
    action: 'preset.plan through operations/client.ts in the page',
    observed: `${accepted.ok === true ? `ok, ${String(actions)} planned action(s)` : refusalOf(accepted)}; field_defs ${String(before)} -> ${String(afterAccepted)}`,
    ok: accepted.ok === true && actions > 0 && afterAccepted === before,
  });

  const refused = await plan([
    {
      key: 'sf_valid_beside_it',
      label: 'Valid',
      valueType: 'text',
      writeMode: 'generic',
      visibilityClass: 'internal',
    },
    { key: 'unclassified_note', label: 'Note', valueType: 'text' },
  ]);
  const afterRefused = await fieldDefCount(admin, alpha);
  const observed = refusalOf(refused);
  record({
    case: 'D05 browser plan unclassified',
    action: 'preset.plan with one unclassified field, in the page',
    observed: `${observed}; field_defs ${String(before)} -> ${String(afterRefused)}`,
    ok: observed === 'PRESET_FIELD_UNCLASSIFIED [unclassified_note]' && afterRefused === before,
  });
}

async function casesR4X(run, browser) {
  const { database, admin, alpha, stamp } = run;
  // The seed builds the external address rather than writing it; so does this.
  const external = users.find((user) => user.role === 'external')?.email;
  if (external === undefined) throw new Error('no role: external entry in synthetic-users.json');
  const adaToken = await tokenOf('ada@alpha.local');
  const shared = await sharedTask(
    { database, admin, alpha, adaToken },
    external,
    `SF shared ${stamp}`,
  );
  const sibling = await callApi(adaToken, 'task.create', {
    operationId: randomUUID(),
    fields: { title: `SF sibling ${stamp}` },
  });
  const siblingId = String(sibling.body.recordId);

  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    step('ext signs in through the form (GoTrue password grant)');
    await signIn(page, external, 'alpha');
    const read = async (name, body) =>
      (await throughClient(page, { read: true, name, body })).result;

    const open = await read('task.read', { recordId: shared.recordId });
    const keys = open.ok === true ? Object.keys(open.value).toSorted().join(',') : refusalOf(open);
    record({
      case: 'R4X shared task reads shared view',
      action: 'task.read of the shared task, in the page, as ext',
      observed: `keys ${keys}`,
      ok: open.ok === true && keys === 'ok,sharedTask',
    });

    const siblingRead = await read('task.read', { recordId: siblingId });
    const board = await read('task.board', { board: null });
    await shot(page, 'R4X-sibling-board');
    record({
      case: 'R4X sibling task refused',
      action: 'task.read of an unshared task in the same business, as ext',
      observed: refusalOf(siblingRead),
      ok: 'refused' in siblingRead && !JSON.stringify(siblingRead).includes('SF sibling'),
    });
    record({
      case: 'R4X board refused',
      action: 'task.board, as ext',
      observed: refusalOf(board),
      ok: 'refused' in board && !JSON.stringify(board).includes('SF shared'),
    });

    const grantState = async () =>
      (
        await admin.execute(
          'select revoked_at is not null as revoked from public.grants where id = $1',
          [shared.grantId],
        )
      )[0]?.revoked;
    const revoked = await callApi(adaToken, 'grant.revoke', {
      operationId: randomUUID(),
      grantId: shared.grantId,
    });
    const after = await read('task.read', { recordId: shared.recordId });
    await shot(page, 'R4X-after-revoke');
    record({
      case: 'R4X revoked share refused next read',
      action: 'grant.revoke over HTTP, then task.read in the page',
      observed: `grant.revoke ${String(revoked.status)}; grant revoked in db ${String(await grantState())}; next read ${refusalOf(after)}`,
      ok:
        revoked.status === 200 &&
        (await grantState()) === true &&
        'refused' in after &&
        !JSON.stringify(after).includes('sharedTask'),
    });
  } finally {
    await context.close();
  }
}

/**
 * The checklist runner's entry. `run` carries its browser, pools and business;
 * the group opens contexts of its own, so the runner's page keeps its session.
 */
export async function casesSurfaceFinal(run) {
  const { browser, stamp } = run;
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    step('ada signs in and creates the D03 task through the page');
    await signIn(page, 'ada@alpha.local', 'alpha');
    const made = await throughClient(page, {
      name: 'task.create',
      body: { fields: { title: `SF D03 ${stamp}` } },
    });
    if (made.result.ok !== true) throw new Error(`task.create ${refusalOf(made.result)}`);
    await casesD03({ ...run, page }, made.result.value.recordId);
    await casesD05({ ...run, page });
    await shot(page, 'SF-D03-D05');
  } finally {
    await context.close();
  }
  await casesR4X(run, browser);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.launch();
  const database = connect(fromEnvFile('DATABASE_URL'), { source: 'surface-final' });
  const admin = connectAsAdmin(fromEnvFile('DATABASE_ADMIN_URL'), { source: 'surface-final' });
  let status = 1;
  try {
    const alpha = (
      await admin.execute('select id from public.businesses where key = $1', ['alpha'])
    )[0]?.id;
    try {
      await casesSurfaceFinal({
        browser,
        database,
        admin,
        alpha,
        stamp: new Date().toISOString(),
      });
    } catch (error) {
      record({
        case: 'SF run',
        action: 'the group',
        observed: String(error).slice(0, 300),
        ok: false,
      });
    }
    status = standaloneStatus('Surface final', [
      'D03 browser client',
      'D03 browser client_visible',
      'D03 browser delegate',
      'D05 browser plan classified',
      'D05 browser plan unclassified',
      'R4X shared task reads shared view',
      'R4X sibling task refused',
      'R4X board refused',
      'R4X revoked share refused next read',
    ]);
  } finally {
    await browser.close();
    await closeQuietly(database);
    await closeQuietly(admin);
  }
  process.exit(status);
}
