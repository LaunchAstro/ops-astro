// SPDX-License-Identifier: AGPL-3.0-only
//
// The presses that move Settings ▸ Access's client privacy card from one
// client to another with a written request half typed: model use on and the
// request filled for the first client, then the second chosen and its model
// use turned on. The screen case and the command case both drive these.

import type { AccessReadResult } from '../../packages/core-wire/src/index.ts';
import { ClientPrivacy } from '../../apps/web/src/screens/access/privacy.tsx';
import { mount, settle, type Mounted } from './mount.tsx';
import { choose } from './access-screen-world.tsx';

/** The first client's written request, made up, each field a canary. */
export const FIRST_REQUEST = {
  requestedBy: 'CANARY-requester-a71f, first client',
  requestedOn: '2026-09-30',
  requestLink: 'https://files.example.test/CANARY-link-a71f.pdf',
} as const;

export type Body = Readonly<Record<string, unknown>>;

/** The card over `result`, each save handed to `onSet`. */
export async function privacyCard(
  result: AccessReadResult,
  onSet: (body: Body) => void,
): Promise<Mounted> {
  return await mount(
    <ClientPrivacy result={result} busy={false} onSet={(body) => onSet(body)} />,
  );
}

const modelUse = '[data-privacy-setting="model"] button[role="switch"]';

/** The first client's request typed, the second client chosen, its model use on, then saved. */
export async function switchClientsMidRequest(
  page: Mounted,
  first: string,
  second: string,
): Promise<void> {
  await choose(page, 'privacy-client', first);
  await page.click(modelUse);
  for (const [key, value] of Object.entries(FIRST_REQUEST)) {
    // eslint-disable-next-line no-await-in-loop -- one keystroke run at a time
    await page.type(`[data-field="${key}"] input`, value);
  }
  await choose(page, 'privacy-client', second);
  await page.click(modelUse);
  await settle();
}

/** The request fields as the card now shows them. */
export const shownRequest = (page: Mounted): readonly string[] =>
  Object.keys(FIRST_REQUEST).map(
    (key) => (page.find(`[data-field="${key}"] input`) as HTMLInputElement | null)?.value ?? '',
  );

export async function save(page: Mounted): Promise<void> {
  await page.click('button[type="submit"]');
  await settle();
}
