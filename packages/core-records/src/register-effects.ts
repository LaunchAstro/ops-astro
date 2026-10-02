// SPDX-License-Identifier: AGPL-3.0-only
//
// The refusal register's effect rows, split out of `register.ts` to keep it
// under the product file limit: the dispatch recheck and effect observation
// codes (T2c1, T2c2, T3d1) and the broker's model-call codes (AW-01).
// `register.ts` spreads them last, so the register's order, types and wire
// answers are unchanged.

export const EFFECT_ROWS = [
  // T2c1, the dispatch transaction's recheck of the effect-time facts
  // (`core-runtime/src/dispatch.ts`). Each is 409: the call was well formed,
  // and state moved under it, so nothing was dispatched.
  {
    code: 'AUTHORITY_LOST',
    status: 409,
    meaning: 'The authority behind the work was lost before its effect was dispatched',
    source: 'T2 T2c1',
    runtime: true,
  },
  {
    code: 'DECISION_STALE',
    status: 409,
    meaning: 'The approval behind the work is no longer current, so its effect is not dispatched',
    source: 'T2 T2c1',
    runtime: true,
  },
  {
    code: 'EFFECT_NOT_RECONCILABLE',
    status: 409,
    meaning: 'The effect can be neither replayed nor reconciled, and no gate accepts a duplicate',
    source: 'T2 T2c1',
    runtime: true,
  },
  // T2c2: an effect is applied only after its dispatch mark, and observed only
  // once the operation register holds it (`core-runtime/src/observe.ts`).
  {
    code: 'EFFECT_NOT_DISPATCHED',
    status: 409,
    meaning: 'The attempt this effect names is not dispatched to this caller, so nothing applied',
    source: 'T2 T2c2',
  },
  {
    code: 'EFFECT_NOT_OBSERVED',
    status: 409,
    meaning:
      'The operation register holds no applied effect for this attempt, so nothing is observed',
    source: 'T2 T2c2',
    runtime: true,
  },
  {
    code: 'LIABILITY_NOT_UNKNOWN',
    status: 409,
    meaning: 'The attempt is not held as an unknown liability, so there is no outcome to record',
    source: 'T3 T3d1',
    runtime: true,
  },
  // The broker's model call (AW-01, `core-custody/src/broker.ts`). The six
  // facts are verified against rows under lock; everything after them is
  // recorded as a step of the run. AUTHORITY_LOST, DECISION_STALE and
  // EFFECT_NOT_RECONCILABLE are the core's (T2c1, above), and the broker
  // answers with them.
  {
    code: 'OPERATION_NOT_CATALOGUED',
    status: 403,
    meaning: 'The operation is not in the reviewed catalogue, whatever the grant',
    source: 'AW-01',
  },
  // Owner line 72: the product has no local-model route yet, so the call waits
  // on one. 501, because what it rests on is not built.
  {
    code: 'LOCAL_MODEL_REQUIRED',
    status: 501,
    meaning: 'Personal information stays out of cloud AI until a local model exists',
    source: 'AW-01, owner line 72',
  },
  // C60 (LF-5): a client's model use is off by default and, while no local
  // model exists, cannot be switched on, so a call on its task reaches no route.
  {
    code: 'CLIENT_MODEL_USE_OFF',
    status: 403,
    meaning: "Model use is off for the task's client, so no route is chosen",
    source: 'C60, LF-5, owner line 72',
  },
  // S3: a bound field's row is another business's, made up, trashed, or holds
  // no text at the key. The same words whoever's row it was.
  {
    code: 'SOURCE_UNREADABLE',
    status: 422,
    meaning: "A bound field's row could not be read, so the call is not made",
    source: 'AW-01 S3, owner line 72',
  },
  {
    code: 'SUBSCRIPTION_UNATTENDED',
    status: 403,
    meaning: "A subscription carries only a person's own attended work",
    source: 'AW-01, LF-5',
  },
  {
    code: 'SUBSCRIPTION_OTHER_TENANT',
    status: 403,
    meaning: "A subscription never carries another installation's tenant",
    source: 'AW-01, LF-5',
  },
  {
    code: 'SUBSCRIPTION_NOT_OWN_WORK',
    status: 403,
    meaning: "A subscription never carries another person's work",
    source: 'AW-01, LF-5',
  },
  {
    code: 'RATE_LIMITED',
    status: 409,
    meaning: "The operation's ceiling on calls in flight is reached; wait and ask again",
    source: 'AW-01',
  },
  {
    code: 'COPY_NOT_REGISTERED',
    status: 409,
    meaning: 'A copy of business content was not registered before it was made',
    source: 'AW-01',
  },
  {
    code: 'LIABILITY_UNKNOWN',
    status: 409,
    meaning: 'The provider may have acted; the maximum is held until a person records an outcome',
    source: 'AW-01, O6, O9',
  },
] as const;
