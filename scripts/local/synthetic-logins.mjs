// SPDX-License-Identifier: AGPL-3.0-only
//
// The local slice's synthetic sign-ins, in one place: the five auth-seed.mjs
// makes, and the agents and external party local-seed.mjs makes. db-admit.mjs
// lets the made-up guard admit exactly these sign-ins.

/**
 * The contract's five. `business` is the contract's A/B label; `businessKey`
 * is the same business as the path prefix spells it, so the consumer does not
 * have to carry the mapping in its head.
 *
 * `grants` is the coordinator's ruling of 22:57Z. An entry that omits it takes
 * the seed's ordinary grants for its role; `noah@alpha.local` carries an empty
 * list because he is checklist case N2's other half — an authenticated member
 * of business A holding no task-collection scope, who must be refused
 * `SCOPE_NOT_GRANTED` rather than shown an empty list. He is still the person
 * `task.assign` assigns to, which is deliberate: being assignable and being
 * able to read are different questions, and N2 is only a real case if the
 * person in it is otherwise ordinary.
 */
export const PEOPLE = [
  {
    email: 'ada@alpha.local',
    business: 'A',
    businessKey: 'alpha',
    person: 'Ada Alpha',
    role: 'admin',
  },
  {
    email: 'mia@alpha.local',
    business: 'A',
    businessKey: 'alpha',
    person: 'Mia Chen',
    role: 'member',
  },
  {
    email: 'noah@alpha.local',
    business: 'A',
    businessKey: 'alpha',
    person: 'Noah Patel',
    role: 'member',
    grants: [],
  },
  {
    email: 'orphan@alpha.local',
    business: 'A',
    businessKey: 'alpha',
    person: 'Orphan Login',
    role: 'none',
  },
  {
    email: 'bea@bravo.local',
    business: 'B',
    businessKey: 'bravo',
    person: 'Bea Rivera',
    role: 'member',
  },
];

/**
 * The local parts of the sign-ins `db:seed` makes itself: each business's agent
 * and business A's external party, as local-seed.mjs builds them, so no
 * synthetic address is a literal in a tracked file. If the two drift, the
 * documented-order proofs fail: the seed's own sign-ins would be refused.
 */
const AGENT_LOCAL_PART = 'agent';
const EXTERNAL_LOCAL_PART = 'ext';

const businessKeys = [...new Set(PEOPLE.map((person) => person.businessKey))];

/** Every sign-in address the local slice writes, `auth:seed`'s and `db:seed`'s. */
export const SIGN_IN_ADDRESSES = [
  ...PEOPLE.map((person) => person.email),
  ...businessKeys.map((key) => `${AGENT_LOCAL_PART}@${key}.local`),
  `${EXTERNAL_LOCAL_PART}@${businessKeys[0]}.local`,
];
