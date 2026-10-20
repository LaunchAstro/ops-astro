// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2105): the Review workspace drawn from a seeded review. Each width shows the revision
// before beside the one under review, each landed picture drawn with its pins numbered as the
// pin list numbers them, and what changed; a first revision shows no before. A click on a
// capture under review marks a spot, and the pin is sent once on that spot, its attempt id
// kept for a retry after a lost answer.

import { afterEach, expect, it } from 'vitest';
import { ReviewWorkspaceScreen } from '../../apps/web/src/screens/review/ReviewWorkspace.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { FIRST_REVIEW, REVIEW, REVIEW_ID, pictureOf } from '../visual/made-up-review.ts';
import { tick } from './task-page-stub.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

interface Sent {
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

function seeded(review: unknown, pin: (count: number) => Response = () => json({}, 503)) {
  const sent: Sent[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const path = String(url);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Readonly<
      Record<string, unknown>
    >;
    sent.push({ path, body });
    if (path.endsWith('/review/read')) return Promise.resolve(json(review));
    if (path.endsWith('/review/picture')) {
      return Promise.resolve(json(pictureOf(body['pictureId'])));
    }
    if (path.endsWith('/review/pin_comment')) {
      return Promise.resolve(pin(sent.filter((each) => each.path === path).length));
    }
    throw new Error(`unrouted ${path}`);
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, sent };
}

const drawn = async (review: unknown, pin?: (count: number) => Response) => {
  const { client, sent } = seeded(review, pin);
  const view = await mount(
    <ReviewWorkspaceScreen
      client={client}
      grantKey="alpha:member"
      reviewId={REVIEW_ID}
      navigate={() => {}}
    />,
  );
  await tick();
  await tick();
  return { view, sent };
};

it('draws a seeded review: before beside after at both widths, pins and what changed', async () => {
  const { view } = await drawn(REVIEW);
  expect(view.all('[data-capture-picture="1480"]')).toHaveLength(2);
  expect(view.all('[data-capture-picture="390"]')).toHaveLength(2);
  expect(view.text()).toContain('Before, revision 1');
  expect(view.text()).toContain('Under review, revision 2');
  expect(
    view
      .all('[data-pin-spot]')
      .map((spot) => (spot as HTMLElement | SVGElement).dataset['pinSpot']),
  ).toEqual(['1', '2']);
  const laptopPin = view.find('[data-capture-picture="1480"] [data-pin-spot="1"] rect');
  expect(laptopPin?.getAttribute('x')).toBe('120');
  expect(laptopPin?.getAttribute('width')).toBe('520');
  expect(view.text()).toContain('Say e-bikes in the headline too');
  expect(view.text()).toContain('Client sees it');
  expect(view.find('[data-difference="1480"] ins')?.textContent).toBe('e-');
  expect(view.find('[data-difference="390"]')?.textContent).toContain('The text did not change.');
});

it('shows no before for a first revision', async () => {
  const { view } = await drawn(FIRST_REVIEW);
  expect(view.all('[data-capture-picture]')).toHaveLength(2);
  expect(view.text()).not.toContain('Before, revision');
  expect(view.text()).toContain('is the first: there is nothing before it');
  expect(view.text()).toContain('A first revision has nothing before it.');
  expect(view.text()).toContain('No pins yet');
});

it('pins on the marked spot once, the retry after a lost answer under the same attempt', async () => {
  const { view, sent } = await drawn(REVIEW, (count) =>
    count === 1 ? json({}, 503) : json({ recordId: 'c1', revision: 1 }),
  );
  const picture = view.find('[data-capture-picture="1480"][aria-label^="Under review"]');
  if (picture === null) throw new Error('no capture under review');
  picture.getBoundingClientRect = () => new DOMRect(0, 0, 740, 450);
  picture.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 370, clientY: 100 }));
  await tick();
  expect(view.find('[data-capture-picture="1480"] [data-pin-marked]')).not.toBeNull();
  await view.type('form textarea', 'Tighten this line');
  await view.click('form button[type="submit"]');
  await tick();
  await view.click('form button[type="submit"]');
  await tick();
  const pins = sent.filter((each) => each.path.endsWith('/review/pin_comment'));
  expect(pins).toHaveLength(2);
  expect(pins[1]?.body['operationId']).toBe(pins[0]?.body['operationId']);
  expect(pins[0]?.body).toMatchObject({
    revisionId: REVIEW.review.after?.revisionId,
    width: 1480,
    audience: 'internal',
    body: 'Tighten this line',
    selector: [{ type: 'FragmentSelector', value: 'xywh=666,176,148,48' }],
  });
  expect(view.find('[data-pin-marked]')).toBeNull();
});
