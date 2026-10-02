-- ============================================================
-- Capture columns added to the live DB after 001_initial_schema.
-- These were applied ad-hoc via the SQL editor as features shipped;
-- this migration makes a fresh rebuild match production.
-- Idempotent — safe to run on the existing DB. Run in Supabase → SQL Editor.
-- ============================================================

-- ── Resources: start / end date ──────────────────────────────
-- start_date defaults to the day the resource is added; end_date is
-- optional (blank = no planned leave date).
alter table public.resources add column if not exists start_date date;
alter table public.resources add column if not exists end_date   date;

-- ── Projects: client + project manager ───────────────────────
-- One client can have many projects; project_manager is a free-text name.
alter table public.projects add column if not exists client           text;
alter table public.projects add column if not exists project_manager  text;
