-- ============================================================
-- Scenarios v2 — cross-project scenarios
-- A v2 scenario spans multiple projects and holds its own people
-- allocations. Run this in Supabase → SQL Editor.
-- ============================================================

create table if not exists public.v2_scenarios (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz default now()
);

create table if not exists public.v2_scenario_projects (
  id             uuid primary key default gen_random_uuid(),
  v2_scenario_id uuid not null references public.v2_scenarios(id) on delete cascade,
  project_id     uuid not null references public.projects(id) on delete cascade,
  unique (v2_scenario_id, project_id)
);

create table if not exists public.v2_allocations (
  id             uuid primary key default gen_random_uuid(),
  v2_scenario_id uuid not null references public.v2_scenarios(id) on delete cascade,
  project_id     uuid not null references public.projects(id) on delete cascade,
  resource_id    uuid not null references public.resources(id) on delete cascade,
  allocation_pct integer not null check (allocation_pct > 0 and allocation_pct <= 200),
  start_date     date not null,
  end_date       date not null,
  created_at     timestamptz default now(),
  check (end_date >= start_date)
);

-- ── Row Level Security (authenticated users have full access) ──
alter table public.v2_scenarios         enable row level security;
alter table public.v2_scenario_projects enable row level security;
alter table public.v2_allocations       enable row level security;

create policy "auth all v2_scenarios"         on public.v2_scenarios         for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "auth all v2_scenario_projects" on public.v2_scenario_projects for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "auth all v2_allocations"       on public.v2_allocations       for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
