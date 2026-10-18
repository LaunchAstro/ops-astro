-- SPDX-License-Identifier: AGPL-3.0-only
--
-- #1693: the door's Locate from the M5. A request names the page and the two
-- words only; the server resolves the page of the task's own site in the
-- insert, and the row is stored `locating`, with no base revision, pre-image,
-- version or digest (the pins). The site runner reads the file at the head
-- commit through custody and either pins the four together (`requested`) or
-- settles it `unlocated` with a fixed code. While `requested`, the runner
-- stamps `verified_at` each time it finds the default branch's file still
-- holds the pinned bytes, or moves it to `superseded` when it does not. No
-- caller supplies a pin, and a pin never changes once set.
--
-- Review and Launch require the stamp to be at most 60 s old, read in their
-- locked statement after the lock wait (`core-records/src/site/live-corrections.ts`);
-- the publish's own blob precondition is where the effect lands, so a page
-- edited inside the window is refused there, never overwritten.
--
-- The runner checks waiting corrections in turn: `next_check_at` (null is due
-- now) and `check_failures` schedule each one, and only move while it is
-- `locating` or `requested`, the time only forward.

alter table public.live_corrections
  alter column pre_image_digest drop not null,
  alter column base_revision drop not null,
  alter column version_id drop not null,
  alter column version_digest drop not null,
  alter column state set default 'locating',
  add column located_at timestamptz,
  add column verified_at timestamptz,
  add column locate_code text,
  add column next_check_at timestamptz,
  add column check_failures integer not null default 0;

-- Every row before this one was pinned at its request.
update public.live_corrections set located_at = created_at;

alter table public.live_corrections
  drop constraint live_corrections_state_known,
  add constraint live_corrections_state_known check (state in (
    'locating', 'unlocated', 'requested', 'superseded', 'approved', 'rejected', 'cancelled',
    'accepted', 'live', 'unknown', 'failed', 'reverted'
  )),
  drop constraint live_corrections_decided_before_effect,
  add constraint live_corrections_decided_before_effect check (
    state in ('locating', 'unlocated', 'requested', 'superseded', 'cancelled')
    or decided_by_person_id is not null
  ),
  add constraint live_corrections_pins_whole check (
    (pre_image_digest is null) = (base_revision is null)
    and (pre_image_digest is null) = (version_id is null)
    and (pre_image_digest is null) = (version_digest is null)
  ),
  add constraint live_corrections_unpinned_undecided check (
    pre_image_digest is not null
    or (state in ('locating', 'unlocated', 'cancelled') and decided_at is null)
  ),
  add constraint live_corrections_locating_unlocated check (
    state <> 'locating' or (located_at is null and verified_at is null)
  ),
  add constraint live_corrections_pinned_located check (
    pre_image_digest is null or located_at is not null
  ),
  add constraint live_corrections_unlocated_located check (
    state <> 'unlocated' or located_at is not null
  ),
  add constraint live_corrections_locate_code check (
    (locate_code is not null) = (state in ('unlocated', 'superseded'))
    and (state <> 'superseded' or locate_code = 'CONTENT_DRIFTED')
    and (locate_code is null or locate_code in (
      'NOT_FOUND', 'WORD_NOT_FOUND', 'CHANGE_ENVELOPE_EXCEEDED', 'SITE_UNREACHABLE',
      'SITE_CHANGED', 'SITE_NOT_CONFIGURED', 'PROVIDER_RESPONSE_MALFORMED', 'CONTENT_DRIFTED'
    ))
  ),
  add constraint live_corrections_base_revision_form
    check (base_revision ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  add constraint live_corrections_pre_image_digest_form
    check (pre_image_digest ~ '^sha256:[0-9a-f]{64}$'),
  add constraint live_corrections_version_digest_form
    check (version_digest ~ '^sha256:[0-9a-f]{64}$'),
  add constraint live_corrections_check_failures_counted check (check_failures >= 0);

-- The runner's due corrections, in turn.
create index live_corrections_due_idx on public.live_corrections
  (business_id, next_check_at nulls first, created_at, id)
  where state in ('locating', 'requested');

-- As 20261004154542, with the locate's moves. What a request named stays as
-- named; the pins move once, null to set, as `locating` becomes `requested`,
-- and never again. `located_at` is written once, by the pin or the unlocate;
-- `verified_at` by the pin, then only forward while `requested`; the locate
-- code once, by the unlocate or the supersede. The schedule moves only while
-- the row is `locating` or `requested`, its time only forward.
create or replace function public.live_corrections_pinned()
  returns trigger
  language plpgsql
  security invoker
  set search_path = pg_catalog, public
as $$
declare
  pinning boolean := old.state = 'locating' and new.state = 'requested';
  unlocating boolean := old.state = 'locating' and new.state = 'unlocated';
  superseding boolean := old.state = 'requested' and new.state = 'superseded';
  checking boolean := old.state in ('locating', 'requested')
                      and new.state in ('locating', 'requested');
begin
  if (new.business_id, new.id, new.party_id, new.task_id, new.requested_by_actor_id,
      new.requested_by_person_id, new.delegation_id, new.target_path, new.word,
      new.replacement, new.page_url, new.seam, new.created_at)
     is distinct from
     (old.business_id, old.id, old.party_id, old.task_id, old.requested_by_actor_id,
      old.requested_by_person_id, old.delegation_id, old.target_path, old.word,
      old.replacement, old.page_url, old.seam, old.created_at) then
    raise exception 'live_corrections_pinned: correction % keeps what it pinned', old.id;
  end if;
  if (new.pre_image_digest, new.base_revision, new.version_id, new.version_digest)
     is distinct from
     (old.pre_image_digest, old.base_revision, old.version_id, old.version_digest)
     and not (pinning and old.pre_image_digest is null) then
    raise exception 'live_corrections_pinned: correction % keeps what it pinned', old.id;
  end if;
  if new.located_at is distinct from old.located_at
     and not ((pinning or unlocating) and old.located_at is null) then
    raise exception 'live_corrections_pinned: correction % keeps where it was located', old.id;
  end if;
  if new.verified_at is distinct from old.verified_at
     and not (pinning
              or (old.state = 'requested' and new.state = 'requested'
                  and new.verified_at is not null
                  and (old.verified_at is null or new.verified_at > old.verified_at))) then
    raise exception 'live_corrections_pinned: correction % keeps when it was checked', old.id;
  end if;
  if new.locate_code is distinct from old.locate_code and not (unlocating or superseding) then
    raise exception 'live_corrections_pinned: correction % keeps its locate code', old.id;
  end if;
  if (new.next_check_at, new.check_failures) is distinct from (old.next_check_at, old.check_failures)
     and not (checking
              and (old.next_check_at is null
                   or (new.next_check_at is not null and new.next_check_at >= old.next_check_at))) then
    raise exception 'live_corrections_pinned: correction % checks forward only while waiting',
      old.id;
  end if;
  if old.decided_at is not null
     and (new.decided_by_actor_id, new.decided_by_person_id, new.decided_at,
          new.decided_version_digest)
     is distinct from
     (old.decided_by_actor_id, old.decided_by_person_id, old.decided_at,
      old.decided_version_digest) then
    raise exception 'live_corrections_pinned: correction % keeps its decision', old.id;
  end if;
  if new.state <> old.state and not (
       (old.state = 'locating' and new.state in ('requested', 'unlocated', 'cancelled'))
       or (old.state = 'requested' and new.state in ('approved', 'rejected', 'cancelled',
                                                     'superseded'))
       or (old.state = 'approved' and new.state = 'cancelled')
       or (old.state = 'cancelled' and new.state = 'unknown' and old.decided_at is not null)
       or (old.state in ('approved', 'accepted', 'unknown')
           and new.state in ('accepted', 'live', 'unknown', 'failed', 'reverted'))
       or (old.state = 'live' and new.state = 'reverted')) then
    raise exception 'live_corrections_pinned: correction % cannot move from % to %',
      old.id, old.state, new.state;
  end if;
  return new;
end;
$$;

-- As 20261018020000, with `locating` open: while the runner locates a
-- correction, its site's providers and its pages hold still, so the pin can
-- only name the binding the request resolved.
create or replace function public.party_site_under_correction(business uuid, party uuid)
  returns boolean
  language plpgsql
  security invoker
  set search_path = pg_catalog, public
as $$
declare
  open_one boolean := false;
  each_one record;
begin
  for each_one in
    select c.state, c.decided_at from public.live_corrections c
     where c.business_id = business and c.party_id is not distinct from party
     for share
  loop
    if each_one.state in ('locating', 'requested', 'approved', 'accepted', 'unknown', 'live')
       or (each_one.state = 'cancelled' and each_one.decided_at is not null) then
      open_one := true;
    end if;
  end loop;
  return open_one;
end;
$$;
