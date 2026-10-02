-- ============================================================
-- Resource Capacity Planner — Supabase schema
-- Run this in Supabase → SQL Editor
-- ============================================================

-- Enable UUID generation
create extension if not exists "pgcrypto";

-- ── Resources ────────────────────────────────────────────────
create table public.resources (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  skill_group   text not null,
  division      text not null,
  status        text not null default 'Active' check (status in ('Active','Inactive')),
  daily_hours   integer not null default 8,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ── Projects ─────────────────────────────────────────────────
create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  type        text not null,
  division    text not null,
  status      text not null default 'In Progress',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ── Scenarios ────────────────────────────────────────────────
create table public.scenarios (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  name        text not null,
  active      boolean not null default false,
  created_at  timestamptz default now()
);

-- Ensure only one active scenario per project
create unique index one_active_scenario_per_project
  on public.scenarios (project_id)
  where active = true;

-- ── Allocations ──────────────────────────────────────────────
create table public.allocations (
  id              uuid primary key default gen_random_uuid(),
  resource_id     uuid not null references public.resources(id) on delete cascade,
  project_id      uuid not null references public.projects(id) on delete cascade,
  scenario_id     uuid references public.scenarios(id) on delete cascade,
  allocation_pct  integer not null check (allocation_pct > 0 and allocation_pct <= 200),
  start_date      date not null,
  end_date        date not null,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  check (end_date >= start_date)
);

-- ── Row Level Security ───────────────────────────────────────
-- All authenticated users in your org can read/write everything.
-- Tighten these policies if you need per-user restrictions later.

alter table public.resources  enable row level security;
alter table public.projects   enable row level security;
alter table public.scenarios  enable row level security;
alter table public.allocations enable row level security;

-- Resources
create policy "Authenticated users can read resources"
  on public.resources for select using (auth.role() = 'authenticated');
create policy "Authenticated users can insert resources"
  on public.resources for insert with check (auth.role() = 'authenticated');
create policy "Authenticated users can update resources"
  on public.resources for update using (auth.role() = 'authenticated');
create policy "Authenticated users can delete resources"
  on public.resources for delete using (auth.role() = 'authenticated');

-- Projects
create policy "Authenticated users can read projects"
  on public.projects for select using (auth.role() = 'authenticated');
create policy "Authenticated users can insert projects"
  on public.projects for insert with check (auth.role() = 'authenticated');
create policy "Authenticated users can update projects"
  on public.projects for update using (auth.role() = 'authenticated');
create policy "Authenticated users can delete projects"
  on public.projects for delete using (auth.role() = 'authenticated');

-- Scenarios
create policy "Authenticated users can read scenarios"
  on public.scenarios for select using (auth.role() = 'authenticated');
create policy "Authenticated users can insert scenarios"
  on public.scenarios for insert with check (auth.role() = 'authenticated');
create policy "Authenticated users can update scenarios"
  on public.scenarios for update using (auth.role() = 'authenticated');
create policy "Authenticated users can delete scenarios"
  on public.scenarios for delete using (auth.role() = 'authenticated');

-- Allocations
create policy "Authenticated users can read allocations"
  on public.allocations for select using (auth.role() = 'authenticated');
create policy "Authenticated users can insert allocations"
  on public.allocations for insert with check (auth.role() = 'authenticated');
create policy "Authenticated users can update allocations"
  on public.allocations for update using (auth.role() = 'authenticated');
create policy "Authenticated users can delete allocations"
  on public.allocations for delete using (auth.role() = 'authenticated');

-- ── Updated_at trigger ───────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_resources_updated_at  before update on public.resources  for each row execute function public.set_updated_at();
create trigger set_projects_updated_at   before update on public.projects   for each row execute function public.set_updated_at();
create trigger set_allocations_updated_at before update on public.allocations for each row execute function public.set_updated_at();
