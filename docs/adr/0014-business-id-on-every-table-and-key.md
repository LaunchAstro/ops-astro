# Business isolation and enduring identity

Accepted 6 September 2026; amended by C02 to C04, C10, and C11 on 7 September.

Every operational application table and derived cache, queue, storage, and
vector key carries its business identity. Parent-child relationships include
that identity in composite keys. A relationship must not connect a row in one
business to a hidden parent in another.

The planned database policy forces row security and uses the product's trusted
business context. Resource and action grants refine access within that
business. Test the real API, database roles, privileged functions, and pooled
connections; a filtered UI is not isolation proof.

A person has one enduring identity within a business, independent of login.
Relationships and histories remain linked across changing roles. Removing a
login preserves the person's business records. Name or email matching alone
must not silently merge confidential histories. The earlier organisation-only
Party glossary was incomplete; Person is an explicit domain term.

Supabase Auth is the first login provider behind the product's thin permissions
contract, superseding Better Auth as the initial choice. Other modules ask the
product who the caller is and what they may do. An exit test must move from
Supabase Auth to a named alternative and state the preserved accounts,
sessions, roles, and scopes. The alternative and mechanics remain to be
specified before implementing that proof.

Groups and individuals receive explicit resource/action grants. Administrators
may appoint collection managers with bounded authority. Team membership,
assignment, clearance, and recovery powers do not create general access.
An assignment that grants new external visibility must wait for the required
access-change decision.

Attachments check current access on preview, download, and API retrieval.
Copies in prompts, outputs, logs, checkpoints, and traces need separate
controls. A protected source link does not protect an uncontrolled copy.
All schema and enforcement work is pending.
