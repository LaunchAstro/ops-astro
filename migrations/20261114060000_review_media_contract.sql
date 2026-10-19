-- SPDX-License-Identifier: AGPL-3.0-only
--
-- U89's upload contract (#2039, C73): what a completed media asset is
-- admitted as. A completed asset is either refused by the contract (its bytes
-- are not its declared type, or its probe disagrees with its declared codec
-- or cannot be read) or quarantined until a scanner's answer lands, passed or
-- failed. Nothing can sign a read of an asset that has not passed. An MP4's
-- probe (codec, frame rate as a rational, start timecode, duration in its
-- timescale) is written once at completion; the scan's engine and time land
-- with its answer.

alter table public.review_media_assets
  add column refusal         text,
  add column scan_state      text,
  add column scan_engine     text,
  add column scanned_at      timestamptz,
  add column probe_codec     text,
  add column probe_fps_num   integer,
  add column probe_fps_den   integer,
  add column probe_timecode  text,
  add column probe_duration  bigint,
  add column probe_timescale integer,
  add constraint review_media_assets_refusal_known
    check (refusal in ('TYPE_MISMATCH', 'PROBE_DISAGREES', 'PROBE_UNREADABLE')),
  add constraint review_media_assets_scan_state_known
    check (scan_state in ('quarantined', 'passed', 'failed')),
  add constraint review_media_assets_completed_is_admitted_once
    check ((state = 'completed') = (num_nonnulls(refusal, scan_state) = 1)),
  add constraint review_media_assets_scan_answer_named
    check (((scan_state in ('passed', 'failed')) is true) = (scan_engine is not null)
       and (scan_engine is null) = (scanned_at is null)),
  add constraint review_media_assets_probe_whole
    check (num_nulls(probe_codec, probe_fps_num, probe_fps_den, probe_timecode, probe_duration,
                     probe_timescale) in (0, 6)),
  add constraint review_media_assets_probe_positive
    check (probe_fps_num > 0 and probe_fps_den > 0 and probe_duration >= 0 and probe_timescale > 0);

create index review_media_assets_quarantined_idx
  on public.review_media_assets (business_id, id) where scan_state = 'quarantined';

grant update (refusal, scan_state, scan_engine, scanned_at, probe_codec, probe_fps_num,
              probe_fps_den, probe_timecode, probe_duration, probe_timescale)
  on public.review_media_assets to ops_astro_app;
