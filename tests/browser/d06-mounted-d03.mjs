// SPDX-License-Identifier: AGPL-3.0-only
//
// D03's browser column, run by `d06-mounted.mjs` on the page it signed in.
//
// Its own module for the per-file review cap, not because it shares anything
// else: the grid in `d06-mounted.mjs` is the page's client, and this is the
// page's screen. Each of the 11 protected task fields is added on the wire to
// the task screen's own Save, and the existing renderer must draw the server's
// refusal, with the owning operation for an operation-owned field.

import { randomUUID } from 'node:crypto';
import { PROTECTED_TASK_FIELDS, TASK_SPINE } from '../../packages/core-records/src/tasks/spine.ts';
import { WEB, inOrder, shot } from './harness.mjs';

/** What the server answers for a protected field sent to `task.update`, derived from the spine. */
function d03Expected(key) {
  const field = TASK_SPINE.find((one) => one.key === key);
  if (key === 'source') return { field, code: 'SOURCE_SPOOFED', names: ['source'] };
  if (field.writeMode === 'system') return { field, code: 'FIELD_NOT_WRITABLE', names: [key] };
  return {
    field,
    code: 'TRANSITION_PROTECTED',
    names: [`${key}=${field.owningOperations.join(' ')}`],
  };
}

/** A value of the field's own type (`protected-fields.test.ts` `probeValue`). */
function d03Probe(field) {
  if (field.valueType === 'uuid') return randomUUID();
  if (field.valueType === 'timestamptz') return new Date(0).toISOString();
  if (field.valueType === 'boolean') return true;
  if (field.valueType === 'numeric') return 99;
  return `probe-${field.key}`;
}

/**
 * Each protected field, added on the wire to the task screen's own Save.
 *
 * The screen's form submits a title edit through `submitEdit`; the route
 * handler adds one protected field to that request's `fields` and lets it go.
 * The server's answer comes back to the screen's own code, and the existing
 * renderer draws it. Asserted: the exact code, the exact names (the owning
 * operations for an operation-owned field), the record's row unchanged as the
 * admin reads it, and the drawn text carrying the code and the names.
 */
export async function d03Column(page, inPage, adminDb, alpha) {
  const results = [];
  await inOrder([...PROTECTED_TASK_FIELDS], async (key) => {
    const { field, code, names } = d03Expected(key);
    const value = d03Probe(field);
    const created = await inPage('task.create', { fields: { title: `D03 ${key}` } });
    const recordId = String(created.body.recordId);
    const task = await inPage('task.read', { recordId });
    const rowOf = async () =>
      JSON.stringify(
        await adminDb.execute(`select * from public.records where business_id = $1 and id = $2`, [
          alpha,
          recordId,
        ]),
      );
    await page.goto(`${WEB}/task/${encodeURIComponent(String(task.body.task.key))}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('#task-title');
    const before = await rowOf();
    const pattern = '**/api/b/alpha/task/update';
    await page.route(pattern, async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}');
      await route.continue({
        postData: JSON.stringify({ ...body, fields: { ...body.fields, [key]: value } }),
      });
    });
    const answered = page.waitForResponse((response) => response.url().endsWith('/task/update'));
    await page.fill('#task-title', `D03 ${key} (edited)`);
    await page.click('form.taskform button[type="submit"]');
    const response = await answered;
    const wire = await response.json().catch(() => ({}));
    await page.unroute(pattern);
    const drawn = await page
      .locator('p.field__error[role="alert"]')
      .first()
      .innerText({ timeout: 10_000 })
      .catch(() => '');
    const after = await rowOf();
    const one = {
      field: key,
      expected: code,
      code: wire.code,
      names: wire.names,
      status: response.status(),
      drawn,
      unchanged: before === after,
      echoed: typeof value === 'string' && JSON.stringify(wire).includes(value),
      shot: await shot(page, `D03-${key}`),
    };
    one.pass =
      one.code === code &&
      JSON.stringify(one.names) === JSON.stringify(names) &&
      one.unchanged &&
      !one.echoed &&
      drawn.startsWith(code) &&
      names.every((name) => drawn.includes(name));
    results.push(one);
    console.log(
      `${one.pass ? 'PASS' : 'FAIL'}   D03 ${key}: HTTP ${String(one.status)} ${String(one.code)} ` +
        `${JSON.stringify(one.names)}; row unchanged ${String(one.unchanged)}; drawn "${drawn}"`,
    );
  });
  return results;
}
