import { createServerSupabaseClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import PlannerClient from '@/components/PlannerClient';

export default async function HomePage() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const [
    { data: resources },
    { data: projects },
    { data: allocations },
    { data: scenarios },
    { data: v2Scenarios },
    { data: v2Projects },
    { data: v2Allocations },
  ] = await Promise.all([
    supabase.from('resources').select('*').order('name'),
    supabase.from('projects').select('*').order('name'),
    supabase.from('allocations').select('*'),
    supabase.from('scenarios').select('*').order('created_at'),
    supabase.from('v2_scenarios').select('*').order('created_at'),
    supabase.from('v2_scenario_projects').select('*'),
    supabase.from('v2_allocations').select('*'),
  ]);

  const projectsWithScenarios = (projects || []).map(p => ({
    id: p.id,
    name: p.name,
    type: p.type,
    division: p.division,
    status: p.status,
    client: p.client || undefined,
    pm: p.project_manager || undefined,
    scenarios: (scenarios || [])
      .filter(s => s.project_id === p.id)
      .map(s => ({ id: s.id, name: s.name, active: s.active })),
  }));

  const initialData = {
    resources: (resources || []).map(r => ({
      id: r.id,
      name: r.name,
      skillGroup: r.skill_group,
      division: r.division,
      status: r.status,
      dailyHours: r.daily_hours,
      startDate: r.start_date || undefined,
      endDate: r.end_date || undefined,
    })),
    projects: projectsWithScenarios,
    allocations: (allocations || []).map(a => ({
      id: a.id,
      resourceId: a.resource_id,
      projectId: a.project_id,
      scenarioId: a.scenario_id,
      allocationPct: a.allocation_pct,
      startDate: a.start_date,
      endDate: a.end_date,
    })),
    v2Scenarios: (v2Scenarios || []).map(s => ({ id: s.id, name: s.name })),
    v2Projects: (v2Projects || []).map(p => ({ id: p.id, v2ScenarioId: p.v2_scenario_id, projectId: p.project_id })),
    v2Allocations: (v2Allocations || []).map(a => ({
      id: a.id,
      v2ScenarioId: a.v2_scenario_id,
      projectId: a.project_id,
      resourceId: a.resource_id,
      allocationPct: a.allocation_pct,
      startDate: a.start_date,
      endDate: a.end_date,
    })),
  };

  return <PlannerClient user={user} initialData={initialData} />;
}
