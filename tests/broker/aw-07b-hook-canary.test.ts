// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b canary on the hook path: a planted recipient address and item link
// ride in the provider's event bodies, and the made-up hook secret signs
// them. Through every answer the route gives, a fault included, none of the
// three reaches a log, an answer, a stored row or custody's trace.

import { Hono } from 'hono';
import { expect, it as vitestIt, vi } from 'vitest';
import { verifyEmailHook } from '../../packages/core-connectors/src/index.ts';
import { MAIL_HOOK_PATH, mountMailHook } from '../../apps/api/mail-hook.ts';
import { MAIL, noDatabase, useEmailWorld, w } from './email-world.ts';
import {
  eventBody,
  hook,
  HOOK_SECRET,
  mountHook,
  post,
  sentItem,
  sign,
} from './email-hook-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();

/** Every answer's text, for the haystack: each case below adds its own. */
const answers: string[] = [];

async function each(raw: string, signed = sign(raw)): Promise<void> {
  answers.push((await post(raw, signed)).text);
}

/** The route over a deployment list the database refuses: the fault path. */
async function faulted(raw: string): Promise<void> {
  const app = new Hono();
  mountMailHook(app, w.db.app, {
    secret: HOOK_SECRET,
    businesses: async () => await Promise.resolve(['not-a-business-id']),
    now: () => hook.clock * 1000,
  });
  const signed = sign(raw);
  const headers = new Headers({
    'svix-id': signed.id,
    'svix-timestamp': signed.timestamp,
    'svix-signature': signed.signature,
  });
  const response = await app.fetch(
    new Request(`http://api.test${MAIL_HOOK_PATH}`, { method: 'POST', headers, body: raw }),
  );
  answers.push(`${String(response.status)} ${await response.text()}`);
}

// eslint-disable-next-line max-lines-per-function -- one capture around every path the canary could leak by
it('AW-07b canary: a planted address, item link and hook secret never reach logs, errors, traces or answers', async () => {
  mountHook();
  const written: string[] = [];
  const capture = (chunk: unknown): boolean => {
    written.push(String(chunk));
    return true;
  };
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation(capture),
    vi.spyOn(process.stderr, 'write').mockImplementation(capture),
    ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(' '));
      }),
    ),
  ];
  const links: string[] = [];
  try {
    const { item, messageId } = await sentItem();
    const link = `${MAIL.appOrigin}/inbox/${item}`;
    links.push(link);
    const planted = { text: `Open it here: ${link}`, reply_to: w.canary, secret: HOOK_SECRET };
    const body = eventBody('email.delivered', messageId, planted);
    await each(body);
    // The same body again under another id: unchanged.
    await each(body, sign(body, hook.clock - 1));
    const replay = sign(body);
    await each(body, replay);
    await each(body, replay);
    await each(body, sign(body, hook.clock - 3600));
    await each(`${body} `, sign(body));
    await each(body, { ...sign(body), signature: `v1,${HOOK_SECRET.slice(6)}` });
    const malformed = JSON.stringify({
      type: 'email.delivered',
      data: { email_id: w.canary, link },
    });
    await each(malformed);
    await each(eventBody('email.delivered', `x${messageId}`, planted));
    await faulted(body);
    // The verifier's own answers, for a secret in the wrong form among them.
    answers.push(
      JSON.stringify(verifyEmailHook(Buffer.from(body), () => w.canary, HOOK_SECRET, hook.clock)),
      JSON.stringify(verifyEmailHook(Buffer.from(body), () => null, w.canary, hook.clock)),
    );
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  // The positive controls: the route answered every kind of case.
  const codes = answers.join('\n');
  // Booleans, as below: a failing control must not print the answers it searched.
  for (const code of [
    'DELIVERED',
    'UNCHANGED',
    'REPLAYED',
    'HOOK_STALE',
    'HOOK_SIGNATURE',
    'HOOK_MALFORMED',
    'UNKNOWN_MESSAGE',
    '503 {"code":"HOOK_FAULT"}',
  ]) {
    expect(codes.includes(code), code).toBe(true);
  }
  const stored = await w.db.admin.execute(
    `select (select coalesce(json_agg(d), '[]') from public.inbox_delivery_attempts d)::text as a,
            (select coalesce(json_agg(e), '[]') from public.audit_events e)::text as e`,
  );
  const haystack = [...written, w.custody.stderr(), codes, JSON.stringify(stored)].join('\n');
  // Booleans, so a failure here does not print what it found.
  expect(haystack.includes(w.canary), 'the planted address leaked').toBe(false);
  expect(haystack.includes(w.canary.split('@')[0] ?? w.canary), 'its local part leaked').toBe(
    false,
  );
  expect(
    links.some((link) => haystack.includes(link)),
    'an item link leaked',
  ).toBe(false);
  expect(haystack.includes(HOOK_SECRET.slice(6)), 'the hook secret leaked').toBe(false);
});
