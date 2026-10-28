// SPDX-License-Identifier: AGPL-3.0-only
//
// The synthetic logins `auth:seed` creates, in one place: auth-seed.mjs makes
// them, and db-admit.mjs lets the made-up guard admit exactly these sign-ins
// until `db:seed` has judged the database.

/**
 * The contract's five, and bravo's administrator. `business` is the
 * contract's A/B label; `businessKey` is the same business as the path prefix
 * spells it, so the consumer does not have to carry the mapping in its head.
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
  {
    // Bravo's administrator (#2308), so a trial crossing from alpha meets a
    // bravo holder with the admin role's keys, not a refusal at the grant layer.
    email: 'ben@bravo.local',
    business: 'B',
    businessKey: 'bravo',
    person: 'Ben Okafor',
    role: 'admin',
  },
];
