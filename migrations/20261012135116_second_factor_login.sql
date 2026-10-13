-- SPDX-License-Identifier: AGPL-3.0-only
--
-- A business's factor row belongs to one sign-in login (C59). The provider
-- holds one set of factors per login, so two logins mapped to one person hold
-- two factors, and each is its own login's to enrol, complete and remove.
-- `subject_digest` names the login (the SHA-256 of its subject, as 0064 keeps
-- it); every live row has one, and the one live factor is per login of the
-- person, not per person. Removed rows keep none.
--
-- Rows written before this name only the person. A live row takes a login on
-- evidence, in order: (a) exactly one subject the login record holds the
-- factor verified for, which only the provider proving a code under that
-- login's own token writes; otherwise (b), with no verified subject at all,
-- the person's one login in the business (any mapping, live or not). A
-- removed tuple is never evidence: a second login replacing the first's
-- unfinished enrolment wrote one under its own subject. A live row neither
-- attributes is ended, and held removed for each login it could be, so the
-- login that really holds it at the provider removes it there on its next
-- proven code; for every other login the provider lists no such factor.
-- The person enrols again, now per login. No function is added; the table's
-- grant already covers the new column.

alter table public.second_factors
  add column subject_digest text
    constraint second_factors_subject_digest_shape check (subject_digest ~ '^[0-9a-f]{64}$');

-- (a) the one subject that verified the factor.
update public.second_factors f
   set subject_digest = v.subject_digest
  from (select factor_digest, min(subject_digest) as subject_digest
          from ops.second_factor_subjects
         where state = 'verified'
         group by factor_digest
        having count(distinct subject_digest) = 1) v
 where f.status <> 'removed'
   and v.factor_digest = encode(sha256(convert_to(f.provider_factor_id, 'UTF8')), 'hex');

-- (b) no verified subject at all: the person's one login in the business.
update public.second_factors f
   set subject_digest = o.subject_digest
  from (select pl.business_id, pl.person_id,
               min(encode(sha256(convert_to(l.subject, 'UTF8')), 'hex')) as subject_digest
          from public.person_logins pl
          join public.logins l on l.business_id = pl.business_id and l.id = pl.login_id
         group by pl.business_id, pl.person_id
        having count(distinct l.subject) = 1) o
 where f.status <> 'removed' and f.subject_digest is null
   and o.business_id = f.business_id and o.person_id = f.person_id
   and not exists (
     select 1 from ops.second_factor_subjects s
      where s.state = 'verified'
        and s.factor_digest = encode(sha256(convert_to(f.provider_factor_id, 'UTF8')), 'hex'));

-- Neither: held removed for every candidate login, then ended.
insert into ops.second_factor_subjects (subject_digest, factor_digest, state)
select distinct c.subject_digest, encode(sha256(convert_to(f.provider_factor_id, 'UTF8')), 'hex'),
       'removed'
  from public.second_factors f
  join lateral (
    select encode(sha256(convert_to(l.subject, 'UTF8')), 'hex') as subject_digest
      from public.person_logins pl
      join public.logins l on l.business_id = pl.business_id and l.id = pl.login_id
     where pl.business_id = f.business_id and pl.person_id = f.person_id
    union
    select s.subject_digest from ops.second_factor_subjects s
     where s.state = 'verified'
       and s.factor_digest = encode(sha256(convert_to(f.provider_factor_id, 'UTF8')), 'hex')
  ) c on true
 where f.status <> 'removed' and f.subject_digest is null
   and not exists (
     select 1 from ops.second_factor_subjects r
      where r.state = 'removed' and r.subject_digest = c.subject_digest
        and r.factor_digest = encode(sha256(convert_to(f.provider_factor_id, 'UTF8')), 'hex'));

update public.second_factors
   set status = 'removed', removed_at = now()
 where status <> 'removed' and subject_digest is null;

-- The person row's mirror, for a verified row just ended.
update public.people p
   set second_factor_verified = false
 where p.second_factor_verified
   and not exists (
     select 1 from public.second_factors f
      where f.business_id = p.business_id and f.person_id = p.id and f.status = 'verified');

alter table public.second_factors
  add constraint second_factors_live_has_login check (status = 'removed' or subject_digest is not null);

drop index public.second_factors_one_live;
create unique index second_factors_one_live
  on public.second_factors (business_id, person_id, subject_digest)
  where status <> 'removed';
