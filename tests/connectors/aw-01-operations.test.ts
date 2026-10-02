// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01's rules that hold before any row is read: an operation registers only
// with all twelve declarations; personal information reaches only a local
// model (owner line 72); a subscription carries only its person's own attended
// work (LF-5). The broker applies each of them on every call
// (`tests/broker/`), through these same functions.

import { expect, it } from 'vitest';
import {
  catalogue,
  DECLARATIONS,
  eligibleRoutes,
  registerModelOperation,
  REPLAY_COMPOSE,
  REPLAY_MODEL_WINDOW,
  type DataClass,
  type FieldSource,
  type ModelRoute,
} from '../../packages/core-connectors/src/index.ts';
import { mayCarry, parseCredentials } from '../../packages/core-custody/src/index.ts';

it('the replay operation registers with all twelve', () => {
  expect(DECLARATIONS).toHaveLength(12);
  const registration = registerModelOperation(REPLAY_COMPOSE);
  expect(registration.ok).toBe(true);
});

it.each(DECLARATIONS)('without %s it does not register, and says which is missing', (name) => {
  const eleven: Record<string, unknown> = { ...REPLAY_COMPOSE };
  delete eleven[name];
  expect(registerModelOperation(eleven)).toEqual({ ok: false, faults: [name] });
  expect(() => catalogue([eleven as never])).toThrow(name);
});

const malformed: Readonly<Record<(typeof DECLARATIONS)[number], unknown>> = {
  key: 'Replay Compose',
  provider: 'https://vendor.example',
  destination: 'https://vendor.example',
  fields: { instruction: 'secret' },
  answer: 'always ok',
  timeoutMs: 0,
  maxResponseBytes: 2 ** 40,
  maximumMinor: -1,
  settlesAt: 'finished',
  nothingHappened: [''],
  billed: 'yes',
  concurrency: 1.5,
};

it.each(DECLARATIONS)('a malformed %s does not register', (name) => {
  expect(registerModelOperation({ ...REPLAY_COMPOSE, [name]: malformed[name] })).toEqual({
    ok: false,
    faults: [name],
  });
});

it('an inherited declaration is not a declaration, and no key registers twice', () => {
  const inherited = Object.create(REPLAY_COMPOSE) as object;
  expect(registerModelOperation(inherited).ok).toBe(false);
  expect(registerModelOperation(null).ok).toBe(false);
  expect(() => catalogue([REPLAY_COMPOSE, REPLAY_COMPOSE])).toThrow('registered twice');
});

it("the replay provider's model window is declared for AW-12", () => {
  expect(REPLAY_MODEL_WINDOW).toEqual({ model: 'replay-1', contextUnits: 32_000 });
});

const cloud: readonly ModelRoute[] = [
  { key: 'replay', reach: 'cloud' },
  { key: 'vendor_a', reach: 'cloud' },
];
const withLocal: readonly ModelRoute[] = [...cloud, { key: 'on_premises', reach: 'local' }];

// What was planted, and the field it sits in on a client's task.
const planted = [
  'a name',
  'an email address',
  "an enquiry's text",
  'a face in an image',
  'a speech clip',
];
const places: readonly { place: string; class: DataClass; source: FieldSource }[] = [
  { place: 'client-scoped content', class: 'client_scoped', source: 'client_row' },
  { place: 'task text', class: 'free_text', source: 'business_internal' },
  { place: 'a brief', class: 'free_text', source: 'business_internal' },
  { place: "code of a client's task", class: 'free_text', source: 'client_row' },
];
const cases = planted.flatMap((what) => places.map((where) => Object.assign({ what }, where)));

it.each(cases)('$what in $place is refused for every cloud route', ({ class: kind, source }) => {
  const choice = eligibleRoutes(
    { carried: kind, tone: 'business_internal' },
    [
      { name: 'carried', source },
      { name: 'tone', source: 'business_internal' },
    ],
    cloud,
  );
  expect(choice).toEqual({ ok: false, code: 'LOCAL_MODEL_REQUIRED', fields: ['carried'] });
});

it.each(cases)(
  '$what in $place, once a local route exists, reaches only it',
  ({ class: kind, source }) => {
    const choice = eligibleRoutes({ carried: kind }, [{ name: 'carried', source }], withLocal);
    expect(choice).toEqual({ ok: true, routes: [{ key: 'on_premises', reach: 'local' }] });
  },
);

it('a field whose class is removed, unknown, or business-internal from a client source is personal', () => {
  for (const routes of [cloud, withLocal]) {
    const refusedOrLocal = (
      declared: Readonly<Record<string, DataClass>>,
      source: FieldSource,
    ): readonly string[] => {
      const choice = eligibleRoutes(declared, [{ name: 'field', source }], routes);
      return choice.ok ? choice.routes.map((route) => route.reach) : [choice.code];
    };
    const expected = routes === cloud ? ['LOCAL_MODEL_REQUIRED'] : ['local'];
    expect(refusedOrLocal({}, 'business_internal')).toEqual(expected);
    expect(refusedOrLocal({ field: 'secret' as DataClass }, 'business_internal')).toEqual(expected);
    expect(
      refusedOrLocal({ field: 'BUSINESS_INTERNAL' as DataClass }, 'business_internal'),
    ).toEqual(expected);
    for (const source of ['client_row', 'client_person', 'guest', 'outside'] as const) {
      expect(refusedOrLocal({ field: 'business_internal' }, source)).toEqual(expected);
    }
  }
});

it('a prototype name is not a declared class', () => {
  const choice = eligibleRoutes({}, [{ name: 'toString', source: 'business_internal' }], cloud);
  expect(choice.ok).toBe(false);
});

it('business-internal work with no personal information still takes the cloud route', () => {
  const choice = eligibleRoutes(
    { tone: 'business_internal' },
    [{ name: 'tone', source: 'business_internal' }],
    withLocal,
  );
  expect(choice).toEqual({ ok: true, routes: withLocal });
});

const attended = {
  unattended: false,
  sessionPersonId: 'p1',
  workForPersonId: 'p1',
  tenantInstallation: 'here',
  credentialInstallation: 'here',
};

it("a subscription carries its own person's attended work", () => {
  expect(mayCarry('subscription', attended)).toEqual({ ok: true });
});

it('an unattended run is refused by name', () => {
  expect(mayCarry('subscription', { ...attended, unattended: true })).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_UNATTENDED',
  });
  expect(mayCarry('subscription', { ...attended, sessionPersonId: null })).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_UNATTENDED',
  });
});

it("another installation's tenant is refused by name", () => {
  expect(mayCarry('subscription', { ...attended, tenantInstallation: 'there' })).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_OTHER_TENANT',
  });
});

it("another person's work is refused by name", () => {
  expect(mayCarry('subscription', { ...attended, workForPersonId: 'p2' })).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_NOT_OWN_WORK',
  });
});

it('an API key or a cloud provider credential carries unattended work', () => {
  const unattended = {
    ...attended,
    unattended: true,
    sessionPersonId: null,
    tenantInstallation: 'there',
  };
  expect(mayCarry('api_key', unattended)).toEqual({ ok: true });
  expect(mayCarry('cloud_credential', unattended)).toEqual({ ok: true });
});

it('the product never stores a subscription or a session token', () => {
  const entry = {
    ref: 'k',
    kind: 'api_key',
    account: 'acct',
    destination: 'replay',
    header: 'authorization',
    value: 'a-long-enough-value',
  };
  expect(parseCredentials([entry]).ok).toBe(true);
  expect(parseCredentials([{ ...entry, kind: 'subscription' }])).toEqual({
    ok: false,
    code: 'CREDENTIAL_NOT_STORABLE',
    at: 0,
  });
  for (const value of [
    'sk-ant-sid01-abcdefgh',
    'SESS-abcdefghij',
    'x__Secure-next-auth.session-token=y',
  ]) {
    expect(parseCredentials([{ ...entry, value }])).toEqual({
      ok: false,
      code: 'SESSION_TOKEN_REFUSED',
      at: 0,
    });
  }
  expect(parseCredentials([{ ...entry, kind: 'replay' }]).ok).toBe(false);
  expect(parseCredentials([{ ...entry, kind: 'replay', account: null }]).ok).toBe(true);
  expect(parseCredentials([entry, entry]).ok).toBe(false);
});
