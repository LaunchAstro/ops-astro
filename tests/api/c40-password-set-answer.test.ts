// SPDX-License-Identifier: AGPL-3.0-only
//
// C40, the login provider's answer to the password update (PR #382 round 3):
// it is judged as JSON, so a password in it however written is a fault that
// audits nothing, and the id asked for is never taken for an echo of it.

import { expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { json, type Reply } from './c58-sessions-world.ts';
import {
  answerWith,
  auditOf,
  freshMember,
  mintToken,
  setPassword,
  usePasswordWorld,
  world,
} from './c40-password-set-world.ts';

usePasswordWorld();
const C40 = it.skipIf(serverUrl === undefined);
const CHANGED = 'account.password_changed';

/** A 200 whose body is `text` as written. */
const raw =
  (text: string): Reply =>
  (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(text);
  };

// Round 3, criterion 1.
C40('a provider answer containing an escaped password is refused', async () => {
  const member = await freshMember('sol-escaped-password');
  const password = 'a valid "quoted" password';
  answerWith(json(200, { id: member.presented.subject, password }));
  const answer = await setPassword(await mintToken(member.presented.subject), password);
  const audit = (await auditOf(world.alpha, 'account.password_changed')).filter(
    (row) => row.actor_id === member.actorId,
  );
  expect({ status: answer.status, body: answer.body, audits: audit.length }).toEqual({
    status: 503,
    body: { code: 'RESET_UNAVAILABLE' },
    audits: 0,
  });
});

// Custody writes an answer back as JSON.stringify does (custody-main `plain`),
// so a repeated key is gone before the broker reads it.
C40('C40 echo: a password anywhere in the answer, however written, is a fault', async () => {
  const cy = await freshMember('cy');
  const id = cy.presented.subject;
  const word = 'an echoed pass\\word 9d1e';
  const escaped = [...word]
    .map((char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`)
    .join('');
  const answers: Record<string, [string, Reply]> = {
    'every character escaped': [word, raw(`{"id":"${id}","p":"${escaped}"}`)],
    'as a key': [word, json(200, { id, [word]: true })],
    'inside a nested value': [word, json(200, { id, deep: [{ note: `was ${word}!` }] })],
    'as a number': ['123456789012', raw(`{"id":"${id}","n":123456789012}`)],
  };
  const answered: Record<string, unknown> = {};
  for (const [name, [password, reply]] of Object.entries(answers)) {
    answerWith(reply);
    // oxlint-disable-next-line no-await-in-loop -- one token per answer, one after another
    const set = await setPassword(await mintToken(id), password);
    answered[name] = set.body['code'] ?? set.status;
  }
  expect(answered).toEqual(
    Object.fromEntries(Object.keys(answers).map((name) => [name, 'RESET_UNAVAILABLE'])),
  );
  const audited = await auditOf(world.alpha, CHANGED);
  expect(audited.filter((row) => row.actor_id === cy.actorId)).toEqual([]);
});

// Round 3, correctness: the id asked for is no echo.
C40(
  'an id-only provider answer accepts a valid password equal to part of the user id',
  async () => {
    const member = await freshMember('sol-id-password');
    const password = member.presented.subject.slice(0, 12);
    expect(Buffer.byteLength(password)).toBe(12);
    answerWith(json(200, { id: member.presented.subject }));
    const answer = await setPassword(await mintToken(member.presented.subject), password);
    expect({ status: answer.status, body: answer.body }).toEqual({
      status: 200,
      body: { passwordSet: true },
    });
  },
);
