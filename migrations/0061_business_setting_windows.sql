-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0061 the conversation and retention windows, owned by a command each
-- (MP-2-11, U07).
--
-- Both rows have been installed since 0009 as `generic`, and nothing could
-- write either. `settings.set_conversation_window` and
-- `settings.set_retention_window` now own them, as the other three settings
-- are owned, because the conversation window's ceiling is the retention
-- window (C122-1) and only a command that locks both rows holds that rule.
-- An install adds missing rows and resets none, so the rows a business
-- already holds are reclassified here; their values and revisions stay.

update public.business_settings
   set write_mode = 'operation',
       owning_operation = array['settings.set_conversation_window']
 where key = 'conversation_window_days';

update public.business_settings
   set write_mode = 'operation',
       owning_operation = array['settings.set_retention_window']
 where key = 'retention_window_days';
