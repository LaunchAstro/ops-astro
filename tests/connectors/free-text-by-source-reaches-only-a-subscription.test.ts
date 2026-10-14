// SPDX-License-Identifier: AGPL-3.0-only
//
// Owner line 72, by source: free text the broker found to be the owner's own
// work (an owner-started task, no client, nothing a client typed) may take the
// owner's own subscription. It never takes an API key or a cloud credential,
// and free text without that finding keeps today's local-only handling.

import { expect, it } from 'vitest';
import {
  eligibleRoutes,
  type DataClass,
  type ModelRoute,
  type PromptField,
} from '../../packages/core-connectors/src/index.ts';

const LOCAL: ModelRoute = { key: 'on_premises', reach: 'local' };
const SEAT: ModelRoute = { key: 'chatgpt_plan', reach: 'cloud', credentialKind: 'subscription' };
const KEY: ModelRoute = { key: 'vendor_a', reach: 'cloud', credentialKind: 'api_key' };
const PROVIDER: ModelRoute = {
  key: 'vendor_b',
  reach: 'cloud',
  credentialKind: 'cloud_credential',
};
const UNSAID: ModelRoute = { key: 'replay', reach: 'cloud' };

const declared: Readonly<Record<string, DataClass>> = {
  instruction: 'free_text',
  tone: 'business_internal',
  scoped: 'client_scoped',
};

const owners: PromptField = { name: 'instruction', source: 'business_internal', ownerWork: true };
const staffs: PromptField = { name: 'instruction', source: 'business_internal' };
const tone: PromptField = { name: 'tone', source: 'business_internal' };

it("the owner's own free text takes a local route or the owner's subscription, and nothing else", () => {
  expect(eligibleRoutes(declared, [owners, tone], [LOCAL, SEAT, KEY, PROVIDER, UNSAID])).toEqual({
    ok: true,
    routes: [LOCAL, SEAT],
  });
});

it("the owner's own free text with no local route takes the subscription alone", () => {
  expect(eligibleRoutes(declared, [owners], [KEY, SEAT])).toEqual({ ok: true, routes: [SEAT] });
});

it.each([
  ['an API key', KEY],
  ['a cloud credential', PROVIDER],
  ['a route that names no credential', UNSAID],
])("the owner's own free text on %s alone waits on a local model", (_how, route) => {
  expect(eligibleRoutes(declared, [owners], [route])).toEqual({
    ok: false,
    code: 'LOCAL_MODEL_REQUIRED',
    fields: ['instruction'],
  });
});

it.each([
  ['staff-entered task text', staffs],
  ['the mark on an outside source', { ...owners, source: 'outside' as const }],
  ['the mark on a client row', { ...owners, source: 'client_row' as const }],
  ['the mark on a client person', { ...owners, source: 'client_person' as const }],
  ['the mark on a guest', { ...owners, source: 'guest' as const }],
  ['the mark on client-scoped content', { ...owners, name: 'scoped' }],
  ['the mark on a field the operation does not declare', { ...owners, name: 'other' }],
])('%s never takes the subscription', (_how, field) => {
  expect(eligibleRoutes(declared, [field], [SEAT])).toMatchObject({
    ok: false,
    code: 'LOCAL_MODEL_REQUIRED',
  });
  expect(eligibleRoutes(declared, [field], [LOCAL, SEAT])).toEqual({ ok: true, routes: [LOCAL] });
});

it("one field that is not the owner's own keeps the whole prompt local", () => {
  expect(eligibleRoutes(declared, [owners, staffs], [LOCAL, SEAT])).toEqual({
    ok: true,
    routes: [LOCAL],
  });
});

it('business-internal fields alone still take every route, as before', () => {
  expect(eligibleRoutes(declared, [tone], [LOCAL, SEAT, KEY])).toEqual({
    ok: true,
    routes: [LOCAL, SEAT, KEY],
  });
});
