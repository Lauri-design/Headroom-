'use client';
import { useState, useMemo, useEffect, useRef, Fragment } from 'react';
import { createClient } from '@/lib/supabase';
import { useRouter } from 'next/navigation';

// ─── Supabase sign-out wrapper ────────────────────────────────────────────────
// PlannerClient receives the authenticated user and initial data from the
// Next.js server component (src/app/page.js). It handles sign-out via
// Supabase and renders the App component.
//
// To wire up persistence, replace the setData(...) calls in the save/delete
// functions with Supabase writes followed by router.refresh().
// See README.md Step 4 for examples.
// ─────────────────────────────────────────────────────────────────────────────

const OB = {
  green: '#BCD727', greenDark: '#8fa31b', greenLight: '#e8f5a3', greenPale: '#f5fbd6',
  grey: '#999999', greyDark: '#6E7878', greyDeep: '#373c3c', greyLight: '#AAAAAA', greyPale: '#f0f0f0',
  white: '#ffffff', onHold: '#BA7517', cancelled: '#c0392b', opportunity: '#4D90A8',
};
const FONT = "'Proxima Nova', 'Nunito Sans', Arial, sans-serif";
const globalStyle = `
  @import url('https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@300;400;600;700&display=swap');
  * { box-sizing: border-box; }
  input, select, textarea, button { font-family: ${FONT}; }
  html { overflow-y: scroll; } /* always reserve the scrollbar gutter so pages don't shift horizontally */
  body { zoom: 1.15; } /* scale the whole UI up so fixed-px text isn't tiny on standard/high-DPI displays */
`;


const SKILL_GROUPS = ["Business Analyst","Consultant","Data Architect","Developer","Director","Graduate Analyst","Project Manager","Quality Assurer","Technical Business Analyst","Technical Support Analyst"];
const PROJECT_TYPES = ["Project","Opportunity"];
const PROJECT_STATUSES = ["In Progress","On Hold","Completed","Cancelled"];
const OPPORTUNITY_STATUSES = ["Open <50%","Open >50%","Deal Won","Closed"];
const statusesFor = type => type==='Opportunity' ? OPPORTUNITY_STATUSES : PROJECT_STATUSES;
const DIVISIONS = ["Enterprise Solutions","Custom Solutions","Data and Analytics","Salesforce","Products","Administration","Other"];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Parse the YYYY-MM directly (not via Date) so month bucketing is timezone-safe.
function monthsInRange(startDate, endDate) {
  const months = [];
  const [sy,sm] = startDate.slice(0,7).split('-').map(Number);
  const [ey,em] = endDate.slice(0,7).split('-').map(Number);
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2,'0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return months;
}

function addMonths(dateStr, n) {
  const [y,m,d] = dateStr.split('-').map(Number);
  const dt = new Date(y, (m-1)+n, d||1); // local-time construction avoids UTC drift
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

function fmtMonth(ym) {
  if (!ym) return '';
  const [y,m] = ym.split('-');
  return `${MONTHS[parseInt(m)-1]} ${y}`;
}

// Last calendar day of a 'YYYY-MM' month, as 'YYYY-MM-DD'.
function monthEnd(ym) {
  const [y,m] = ym.split('-').map(Number);
  const d = new Date(y, m, 0);
  return `${y}-${String(m).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ── Period model: a display bucket that is either a calendar month or an ISO (Mon-start) week ──
function ymdOf(dt){ return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`; }
function parseYMD(s){ const [y,m,d]=s.slice(0,10).split('-').map(Number); return new Date(Date.UTC(y,m-1,d||1)); }
function addDaysStr(s,n){ const dt=parseYMD(s); dt.setUTCDate(dt.getUTCDate()+n); return ymdOf(dt); }
function mondayOf(s){ const dt=parseYMD(s); const dow=(dt.getUTCDay()+6)%7; dt.setUTCDate(dt.getUTCDate()-dow); return ymdOf(dt); }

// Build the visible period columns spanning a From/To month range.
// granularity: 'month' | 'week'. Each period = {key,start,end,label,sub}. Month keys stay 'YYYY-MM'.
function buildPeriods(from, to, granularity){
  // from/to may be month-level ('YYYY-MM') or day-level ('YYYY-MM-DD').
  const fromMonth=from.slice(0,7), toMonth=to.slice(0,7);
  const [fy,fm]=fromMonth.split('-').map(Number); const [ty,tm]=toMonth.split('-').map(Number);
  const rangeStartDay = from.length>7 ? from : `${fromMonth}-01`;
  const rangeEnd = to.length>7 ? to : ymdOf(new Date(Date.UTC(ty,tm,0))); // day, or last day of toMonth
  const out=[];
  if(granularity==='week'){
    let ws=mondayOf(rangeStartDay);
    while(ws<=rangeEnd){ const we=addDaysStr(ws,6); const [wy,wm,wd]=ws.split('-'); out.push({key:ws,start:ws,end:we,label:`${MONTHS[parseInt(wm)-1]} ${parseInt(wd)}`,sub:`'${wy.slice(2)}`}); ws=addDaysStr(ws,7); }
    return out;
  }
  let y=fy,m=fm;
  while(y<ty||(y===ty&&m<=tm)){ const mm=String(m).padStart(2,'0'); out.push({key:`${y}-${mm}`,start:`${y}-${mm}-01`,end:ymdOf(new Date(Date.UTC(y,m,0))),label:MONTHS[m-1],sub:`'${String(y).slice(2)}`}); m++; if(m>12){m=1;y++;} }
  return out;
}

// Sum allocation % per resource per visible period (period overlaps the allocation's date range).
function bucketByPeriod(allocs, periods){
  const map={};
  allocs.forEach(a=>{ for(const p of periods){ if(p.start<=a.endDate && p.end>=a.startDate){ (map[a.resourceId]=map[a.resourceId]||{}); map[a.resourceId][p.key]=(map[a.resourceId][p.key]||0)+(a.allocationPct||0); } } });
  return map;
}

// ── Supabase allocation persistence helpers ──────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Map an in-app allocation (camelCase) to a Supabase row (snake_case).
const allocToRow = a => ({
  resource_id: a.resourceId, project_id: a.projectId, scenario_id: a.scenarioId || null,
  allocation_pct: a.allocationPct, start_date: a.startDate, end_date: a.endDate,
});
// Map a Supabase row back to the in-app allocation shape.
const rowToAlloc = r => ({
  id: r.id, resourceId: r.resource_id, projectId: r.project_id, scenarioId: r.scenario_id || undefined,
  allocationPct: r.allocation_pct, startDate: r.start_date, endDate: r.end_date,
});
const resToRow = r => ({ name: r.name, skill_group: r.skillGroup, division: r.division, status: r.status, daily_hours: r.dailyHours, start_date: r.startDate || null, end_date: r.endDate || null });
const rowToRes = r => ({ id: r.id, name: r.name, skillGroup: r.skill_group, division: r.division, status: r.status, dailyHours: r.daily_hours, startDate: r.start_date || undefined, endDate: r.end_date || undefined });
const projToRow = p => ({ name: p.name, type: p.type, division: p.division, status: p.status, client: p.client || null, project_manager: p.pm || null });
// v2 cross-project scenarios
const v2AllocToRow = a => ({ v2_scenario_id: a.v2ScenarioId, project_id: a.projectId, resource_id: a.resourceId, allocation_pct: a.allocationPct, start_date: a.startDate, end_date: a.endDate });
const rowToV2Alloc = r => ({ id: r.id, v2ScenarioId: r.v2_scenario_id, projectId: r.project_id, resourceId: r.resource_id, allocationPct: r.allocation_pct, startDate: r.start_date, endDate: r.end_date });

function activeAllocations(data) {
  const activeScenarios = new Set();
  data.projects.forEach(p => {
    const active = (p.scenarios||[]).find(s => s.active);
    if (active) activeScenarios.add(active.id);
  });
  return data.allocations.filter(a => !a.scenarioId || activeScenarios.has(a.scenarioId));
}

// Completed/Cancelled projects are hidden from the Allocations and Scenarios views
// (they still appear on the Admin > Projects page).
const DONE_STATUSES = new Set(['Completed','Cancelled','Closed']);
const isPlannable = p => p && !DONE_STATUSES.has(p.status);
function plannableProjectIds(data) { return new Set(data.projects.filter(isPlannable).map(p=>p.id)); }

function buildAllocationMap(allocations, resources) {
  const map = {};
  resources.forEach(r => { map[r.id] = {}; });
  allocations.forEach(a => {
    monthsInRange(a.startDate, a.endDate).forEach(m => {
      if (!map[a.resourceId]) map[a.resourceId] = {};
      map[a.resourceId][m] = (map[a.resourceId][m]||0) + (a.allocationPct||0);
    });
  });
  return map;
}

// Which projects make up a resource's allocation in a given period.
// `period` may be a 'YYYY-MM' month string or a {start,end} period object.
function allocBreakdown(allocs, projects, resourceId, period) {
  const pr = typeof period==='string' ? {start:`${period}-01`, end:monthEnd(period)} : period;
  const byProj = {};
  allocs.forEach(a => {
    if (a.resourceId===resourceId && a.startDate<=pr.end && a.endDate>=pr.start)
      byProj[a.projectId] = (byProj[a.projectId]||0) + (a.allocationPct||0);
  });
  const rows = Object.entries(byProj)
    .map(([pid,pct]) => ({ pid, name:(projects.find(p=>p.id===pid)?.name)||'Unknown', pct }))
    .sort((x,y)=>y.pct-x.pct);
  return { rows, total: rows.reduce((s,r)=>s+r.pct,0) };
}

// Cursor-following tooltip with a short show-delay. Returns handlers + the node to render.
function useHoverTip(delay=220) {
  const [tip,setTip] = useState(null); // {x,y,content}
  const timer = useRef(null);
  useEffect(()=>()=>clearTimeout(timer.current), []);
  const tipProps = content => ({
    onMouseEnter: e => { const x=e.clientX, y=e.clientY; clearTimeout(timer.current); timer.current=setTimeout(()=>setTip({x,y,content}), delay); },
    onMouseMove: e => setTip(t => t ? {...t, x:e.clientX, y:e.clientY} : t),
    onMouseLeave: () => { clearTimeout(timer.current); setTip(null); },
  });
  const tipNode = tip ? (
    <div style={{position:'fixed',left:tip.x+14,top:tip.y+16,zIndex:1000,background:OB.greyDeep,color:OB.white,padding:'7px 10px',borderRadius:4,fontSize:11,lineHeight:1.5,pointerEvents:'none',boxShadow:'0 3px 12px rgba(0,0,0,0.28)',maxWidth:280}}>{tip.content}</div>
  ) : null;
  return { tipProps, tipNode };
}

function initData() {
  return {
    resources: [
      {id:'r1', name:'Person 1',  skillGroup:'Project Manager',             division:'Enterprise Solutions', status:'Active', dailyHours:8},
      {id:'r2', name:'Person 2',  skillGroup:'Consultant',                  division:'Enterprise Solutions', status:'Active', dailyHours:8},
      {id:'r3', name:'Person 3',  skillGroup:'Developer',                   division:'Enterprise Solutions', status:'Active', dailyHours:8},
      {id:'r4', name:'Person 4',  skillGroup:'Technical Support Analyst',   division:'Enterprise Solutions', status:'Active', dailyHours:8},
      {id:'r5', name:'Person 5',  skillGroup:'Technical Support Analyst',   division:'Enterprise Solutions', status:'Active', dailyHours:8},
      {id:'r6', name:'Person 6',  skillGroup:'Developer',                   division:'Custom Solutions',     status:'Active', dailyHours:8},
      {id:'r7', name:'Person 7',  skillGroup:'Business Analyst',            division:'Custom Solutions',     status:'Active', dailyHours:8},
      {id:'r8', name:'Person 8',  skillGroup:'Technical Business Analyst',  division:'Data and Analytics',   status:'Active', dailyHours:8},
      {id:'r9', name:'Person 9',  skillGroup:'Data Architect',              division:'Data and Analytics',   status:'Active', dailyHours:8},
      {id:'r10',name:'Person 10', skillGroup:'Quality Assurer',             division:'Enterprise Solutions', status:'Active', dailyHours:8},
      {id:'r11',name:'Person 11', skillGroup:'Graduate Analyst',            division:'Enterprise Solutions', status:'Active', dailyHours:8},
      {id:'r12',name:'Person 12', skillGroup:'Consultant',                  division:'Custom Solutions',     status:'Active', dailyHours:8},
      {id:'r13',name:'Person 13', skillGroup:'Developer',                   division:'Data and Analytics',   status:'Active', dailyHours:8},
      {id:'r14',name:'Person 14', skillGroup:'Technical Support Analyst',   division:'Enterprise Solutions', status:'Inactive',dailyHours:8},
      {id:'r15',name:'Person 15', skillGroup:'Project Manager',             division:'Custom Solutions',     status:'Active', dailyHours:8},
    ],
    projects: [
      {id:'p1', name:'Project Alpha',   type:'MRI Implementation', division:'Enterprise Solutions', status:'In Progress',
        scenarios:[{id:'sp1a',name:'Baseline',active:true},{id:'sp1b',name:'Accelerated',active:false}]},
      {id:'p2', name:'Project Beta',    type:'MRI Projects',       division:'Enterprise Solutions', status:'In Progress',
        scenarios:[{id:'sp2a',name:'Baseline',active:true}]},
      {id:'p3', name:'Project Gamma',   type:'MRI Consulting',     division:'Custom Solutions',     status:'On Hold',
        scenarios:[{id:'sp3a',name:'Baseline',active:true},{id:'sp3b',name:'Reduced scope',active:false}]},
      {id:'p4', name:'Project Delta',   type:'MRI Support',        division:'Enterprise Solutions', status:'In Progress',
        scenarios:[{id:'sp4a',name:'Baseline',active:true}]},
      {id:'p5', name:'Project Epsilon', type:'MRI Implementation', division:'Data and Analytics',   status:'Opportunity',
        scenarios:[{id:'sp5a',name:'Lean',active:true},{id:'sp5b',name:'Full team',active:false}]},
      {id:'p6', name:'Project Zeta',    type:'MRI Projects',       division:'Custom Solutions',     status:'In Progress',
        scenarios:[{id:'sp6a',name:'Baseline',active:true}]},
      {id:'p7', name:'Project Eta',     type:'Other',              division:'Enterprise Solutions', status:'Completed',
        scenarios:[{id:'sp7a',name:'Baseline',active:true}]},
      {id:'p8', name:'Project Theta',   type:'MRI Consulting',     division:'Data and Analytics',   status:'In Progress',
        scenarios:[{id:'sp8a',name:'Baseline',active:true},{id:'sp8b',name:'Extended',active:false}]},
      {id:'p9', name:'Project Iota',    type:'Opportunity',        division:'Custom Solutions',     status:'Opportunity',
        scenarios:[{id:'sp9a',name:'Initial',active:true}]},
      {id:'p10',name:'Project Kappa',   type:'MRI Support',        division:'Enterprise Solutions', status:'Delayed',
        scenarios:[{id:'sp10a',name:'Baseline',active:true}]},
    ],
    allocations: [
      // Project Alpha – Baseline
      {id:'a1', resourceId:'r1',  projectId:'p1', scenarioId:'sp1a', allocationPct:100, startDate:'2026-01-01', endDate:'2026-09-30'},
      {id:'a2', resourceId:'r2',  projectId:'p1', scenarioId:'sp1a', allocationPct:100, startDate:'2026-01-01', endDate:'2026-09-30'},
      {id:'a3', resourceId:'r3',  projectId:'p1', scenarioId:'sp1a', allocationPct:80,  startDate:'2026-02-01', endDate:'2026-08-31'},
      {id:'a4', resourceId:'r10', projectId:'p1', scenarioId:'sp1a', allocationPct:50,  startDate:'2026-06-01', endDate:'2026-09-30'},
      // Project Alpha – Accelerated
      {id:'a5', resourceId:'r1',  projectId:'p1', scenarioId:'sp1b', allocationPct:100, startDate:'2026-01-01', endDate:'2026-06-30'},
      {id:'a6', resourceId:'r2',  projectId:'p1', scenarioId:'sp1b', allocationPct:100, startDate:'2026-01-01', endDate:'2026-06-30'},
      {id:'a7', resourceId:'r3',  projectId:'p1', scenarioId:'sp1b', allocationPct:100, startDate:'2026-01-01', endDate:'2026-06-30'},
      // Project Beta
      {id:'a8', resourceId:'r4',  projectId:'p2', scenarioId:'sp2a', allocationPct:100, startDate:'2026-01-01', endDate:'2026-12-31'},
      {id:'a9', resourceId:'r5',  projectId:'p2', scenarioId:'sp2a', allocationPct:100, startDate:'2026-01-01', endDate:'2026-12-31'},
      {id:'a10',resourceId:'r11', projectId:'p2', scenarioId:'sp2a', allocationPct:50,  startDate:'2026-03-01', endDate:'2026-12-31'},
      // Project Gamma (on hold)
      {id:'a11',resourceId:'r12', projectId:'p3', scenarioId:'sp3a', allocationPct:100, startDate:'2026-04-01', endDate:'2026-10-31'},
      {id:'a12',resourceId:'r7',  projectId:'p3', scenarioId:'sp3a', allocationPct:50,  startDate:'2026-04-01', endDate:'2026-10-31'},
      // Project Delta
      {id:'a13',resourceId:'r4',  projectId:'p4', scenarioId:'sp4a', allocationPct:50,  startDate:'2026-01-01', endDate:'2026-12-31'},
      {id:'a14',resourceId:'r5',  projectId:'p4', scenarioId:'sp4a', allocationPct:50,  startDate:'2026-01-01', endDate:'2026-12-31'},
      // Project Zeta
      {id:'a15',resourceId:'r6',  projectId:'p6', scenarioId:'sp6a', allocationPct:100, startDate:'2026-05-01', endDate:'2026-12-31'},
      {id:'a16',resourceId:'r15', projectId:'p6', scenarioId:'sp6a', allocationPct:80,  startDate:'2026-05-01', endDate:'2026-12-31'},
      {id:'a17',resourceId:'r7',  projectId:'p6', scenarioId:'sp6a', allocationPct:100, startDate:'2026-06-01', endDate:'2026-11-30'},
      // Project Theta
      {id:'a18',resourceId:'r8',  projectId:'p8', scenarioId:'sp8a', allocationPct:100, startDate:'2026-02-01', endDate:'2026-11-30'},
      {id:'a19',resourceId:'r9',  projectId:'p8', scenarioId:'sp8a', allocationPct:80,  startDate:'2026-02-01', endDate:'2026-11-30'},
      {id:'a20',resourceId:'r13', projectId:'p8', scenarioId:'sp8a', allocationPct:60,  startDate:'2026-04-01', endDate:'2026-10-31'},
      // Project Kappa (delayed)
      {id:'a21',resourceId:'r2',  projectId:'p10',scenarioId:'sp10a',allocationPct:50,  startDate:'2026-07-01', endDate:'2026-12-31'},
      {id:'a22',resourceId:'r11', projectId:'p10',scenarioId:'sp10a',allocationPct:50,  startDate:'2026-07-01', endDate:'2026-12-31'},
    ],
    v2Scenarios: [], v2Projects: [], v2Allocations: [],
  };
}

const TODAY = new Date();
const CUR_YEAR = TODAY.getFullYear();

const btnStyle = (primary) => ({
  fontFamily:FONT,fontSize:12,padding:'6px 14px',borderRadius:3,cursor:'pointer',
  border: primary ? 'none' : `1px solid ${OB.greyPale}`,
  background: primary ? OB.green : OB.white,
  color: primary ? OB.greyDeep : OB.greyDark,
  fontWeight: primary ? 600 : 400,
  whiteSpace:'nowrap',
});
const inputStyle = {width:'100%',fontFamily:FONT,fontSize:13,padding:'7px 10px',borderRadius:3,border:`1px solid ${OB.greyPale}`,background:OB.white,color:OB.greyDeep,boxSizing:'border-box'};
// Shared compact control style (selects/inputs in toolbars). Used app-wide.
const ctrl = {fontFamily:FONT,fontSize:12,padding:'5px 9px',borderRadius:3,border:`1px solid ${OB.greyPale}`,background:OB.white,color:OB.greyDeep};
const card = {background:OB.white,border:`1px solid ${OB.greyPale}`,borderRadius:4,padding:'1rem 1.25rem'};
const sectionLabel = {fontSize:10,fontWeight:600,color:OB.grey,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:8,display:'block'};

// Planner-style pill button. active = filled green.
const pillStyle = active => ({
  fontFamily:FONT,fontSize:12,padding:'4px 12px',borderRadius:3,cursor:'pointer',border:'none',
  background:active?OB.green:OB.greyPale, color:active?OB.greyDeep:OB.grey, fontWeight:active?600:400, whiteSpace:'nowrap',
});
// Multi-select button-row filter. `selected` is an array; [] means All.
function MultiFilter({label, options, selected, onChange}) {
  const toggle = v => onChange(selected.includes(v) ? selected.filter(x=>x!==v) : [...selected, v]);
  return (
    <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
      <button onClick={()=>onChange([])} style={pillStyle(selected.length===0)}>All</button>
      {options.map(o=>(<button key={o} onClick={()=>toggle(o)} style={pillStyle(selected.includes(o))}>{o}</button>))}
    </div>
  );
}

// Secondary tab bar (pill buttons).
function SubNav({tabs, selected, onSelect}) {
  return (
    <div style={{display:'flex',gap:6,marginBottom:'1.25rem',flexWrap:'wrap'}}>
      {tabs.map(([key,label])=>(<button key={key} onClick={()=>onSelect(key)} style={pillStyle(selected===key)}>{label}</button>))}
    </div>
  );
}

// ── Custom date pickers (popover) ─────────────────────────────────────────────
const PICKER_SEL = OB.green;
function usePickerOpen(){
  const [open,setOpen]=useState(false); const ref=useRef();
  useEffect(()=>{ if(!open) return; const h=e=>{ if(ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener('mousedown',h); return ()=>document.removeEventListener('mousedown',h); },[open]);
  return {open,setOpen,ref};
}
const pickerPop = {position:'absolute',top:'calc(100% + 4px)',left:0,zIndex:60,background:OB.white,border:`1px solid ${OB.greyPale}`,borderRadius:8,padding:12,boxShadow:'0 6px 20px rgba(0,0,0,0.12)',width:288};
const pickerTrigger = open => ({...ctrl,cursor:'pointer',textAlign:'left',minWidth:120,border:`1.5px solid ${open?OB.green:OB.greyPale}`,background:OB.white,color:OB.greyDeep});
const pickerNav = {display:'flex',alignItems:'center',justifyContent:'space-between',margin:'2px 0 8px'};
const pickerArrow = {background:'none',border:'none',cursor:'pointer',color:OB.greyDeep,fontSize:18,lineHeight:1,padding:'2px 8px',fontFamily:FONT};
const pickerQuickRow = {display:'flex',justifyContent:'space-between',gap:6,marginBottom:10};
const pickerQuick = active => ({flex:1,fontFamily:FONT,fontSize:11,padding:'4px 6px',borderRadius:20,cursor:'pointer',border:'none',background:active?OB.greenPale:'transparent',color:active?OB.greenDark:OB.grey,fontWeight:active?600:400,whiteSpace:'nowrap'});
const pickerCell = sel => ({fontFamily:FONT,fontSize:12,padding:'8px 0',borderRadius:20,cursor:'pointer',border:'none',background:sel?PICKER_SEL:'transparent',color:sel?OB.greyDeep:OB.greyDeep,fontWeight:sel?700:400});

function fmtYmLabel(ym){ const [y,m]=ym.split('-'); return `${MONTHS[parseInt(m)-1]} ${y}`; }
function fmtDayLabel(ds){ const [y,m,d]=ds.split('-'); return `${parseInt(d)} ${MONTHS[parseInt(m)-1]} ${y}`; }

// Month picker: value 'YYYY-MM'. Grid of 12 months + year nav + Last/This/Next month.
function MonthPicker({value, onChange, style, block}) {
  const {open,setOpen,ref}=usePickerOpen();
  const today=new Date(); const curYm=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;
  const val=(value||curYm).slice(0,7);
  const [vy,setVy]=useState(parseInt(val.split('-')[0]));
  useEffect(()=>{ if(open) setVy(parseInt(val.split('-')[0])); },[open]); // eslint-disable-line
  const label = val===curYm ? 'This month' : fmtYmLabel(val);
  const quickYm=off=>{ const d=new Date(today.getFullYear(),today.getMonth()+off,1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; };
  return (
    <div ref={ref} style={{position:'relative',display:block?'block':'inline-block',...(block?{width:'100%'}:{}),...style}}>
      <button type="button" onClick={()=>setOpen(o=>!o)} style={{...pickerTrigger(open),...(block?{width:'100%'}:{})}}>{label}</button>
      {open && (
        <div style={pickerPop}>
          <div style={pickerNav}><button style={pickerArrow} onClick={()=>setVy(y=>y-1)}>‹</button><span style={{fontSize:15,fontWeight:600,color:OB.greyDeep}}>{vy}</span><button style={pickerArrow} onClick={()=>setVy(y=>y+1)}>›</button></div>
          <div style={pickerQuickRow}>{[['Last month',-1],['This month',0],['Next month',1]].map(([lbl,off])=>(<button key={lbl} style={pickerQuick(val===quickYm(off))} onClick={()=>{ onChange(quickYm(off)); setOpen(false); }}>{lbl}</button>))}</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6}}>
            {MONTHS.map((mn,mi)=>{ const ym=`${vy}-${String(mi+1).padStart(2,'0')}`; return <button key={mn} style={pickerCell(ym===val)} onClick={()=>{ onChange(ym); setOpen(false); }}>{mn.toUpperCase()}</button>; })}
          </div>
        </div>
      )}
    </div>
  );
}

// Day picker: value 'YYYY-MM-DD' (may be ''). Day grid (Mon start) + month nav + Last/This/Next week.
function DayPicker({value, onChange, style, placeholder='Select date', allowClear, block}) {
  const {open,setOpen,ref}=usePickerOpen();
  const todayS=(()=>{ const n=new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`; })();
  const anchor=value||todayS;
  const [viewYm,setViewYm]=useState(anchor.slice(0,7));
  useEffect(()=>{ if(open) setViewYm((value||todayS).slice(0,7)); },[open]); // eslint-disable-line
  const [vy,vm]=viewYm.split('-').map(Number);
  const firstDow=(new Date(Date.UTC(vy,vm-1,1)).getUTCDay()+6)%7;
  const daysInMonth=new Date(Date.UTC(vy,vm,0)).getUTCDate();
  const cells=[]; for(let i=0;i<firstDow;i++) cells.push(null); for(let d=1;d<=daysInMonth;d++) cells.push(d);
  while(cells.length%7!==0) cells.push(null);
  const hasDay = value && value.length>7;
  const label = !value ? placeholder
    : hasDay ? (mondayOf(value)===mondayOf(todayS) ? 'This week' : fmtDayLabel(value))
    : fmtYmLabel(value.slice(0,7)); // month-level value (not yet narrowed to a day)
  const shiftMonth=n=>{ const d=new Date(Date.UTC(vy,vm-1+n,1)); setViewYm(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`); };
  const quickMonday=off=>{ const m=parseYMD(mondayOf(todayS)); m.setUTCDate(m.getUTCDate()+off*7); return ymdOf(m); };
  const pick=d=>{ if(!d) return; onChange(`${vy}-${String(vm).padStart(2,'0')}-${String(d).padStart(2,'0')}`); setOpen(false); };
  const selDay = hasDay && value.slice(0,7)===viewYm ? parseInt(value.split('-')[2]) : null;
  return (
    <div ref={ref} style={{position:'relative',display:block?'block':'inline-block',...(block?{width:'100%'}:{}),...style}}>
      <button type="button" onClick={()=>setOpen(o=>!o)} style={{...pickerTrigger(open),...(block?{width:'100%'}:{}),color:value?OB.greyDeep:OB.greyLight}}>{label}</button>
      {open && (
        <div style={block?{...pickerPop,top:'auto',bottom:'calc(100% + 4px)'}:pickerPop}>
          {allowClear && value && <div style={{textAlign:'right',marginBottom:2}}><button style={{...pickerArrow,fontSize:13,color:OB.grey}} onClick={()=>{ onChange(''); setOpen(false); }}>clear ×</button></div>}
          <div style={pickerNav}><button style={pickerArrow} onClick={()=>shiftMonth(-1)}>‹</button><span style={{fontSize:15,fontWeight:600,color:OB.greyDeep}}>{MONTHS[vm-1]} {vy}</span><button style={pickerArrow} onClick={()=>shiftMonth(1)}>›</button></div>
          <div style={pickerQuickRow}>{[['Last week',-1],['This week',0],['Next week',1]].map(([lbl,off])=>(<button key={lbl} style={pickerQuick(hasDay&&mondayOf(value)===quickMonday(off))} onClick={()=>{ onChange(quickMonday(off)); setOpen(false); }}>{lbl}</button>))}</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:2,textAlign:'center'}}>
            {['M','T','W','T','F','S','S'].map((d,i)=><div key={i} style={{fontSize:10,color:OB.grey,fontWeight:600,padding:'2px 0'}}>{d}</div>)}
            {cells.map((d,i)=> d===null ? <div key={i} style={{color:OB.greyPale,fontSize:12,padding:'6px 0'}}>·</div> : <button key={i} style={{...pickerCell(d===selDay),padding:'6px 0',borderRadius:'50%'}} onClick={()=>pick(d)}>{String(d).padStart(2,'0')}</button>)}
          </div>
        </div>
      )}
    </div>
  );
}

// Month / Week granularity toggle (segmented control) for any grid that shows periods as columns.
function GranularityToggle({value, onChange}) {
  return (
    <div style={{display:'flex',borderRadius:3,overflow:'hidden',border:`1px solid ${OB.greyPale}`,flexShrink:0}}>
      {[['month','Monthly'],['week','Weekly']].map(([key,label])=>(
        <button key={key} onClick={()=>onChange(key)} style={{fontFamily:FONT,fontSize:12,padding:'5px 12px',cursor:'pointer',border:'none',background:value===key?OB.green:OB.white,color:value===key?OB.greyDeep:OB.grey,fontWeight:value===key?600:400}}>{label}</button>
      ))}
    </div>
  );
}

// Multi-select dropdown: a control-styled button that opens a checkbox panel.
// `selected` is an array; [] means All.
function MultiSelect({options, selected, onChange, placeholder='All'}) {
  const [open,setOpen]=useState(false);
  const ref=useRef(null);
  useEffect(()=>{
    if(!open) return;
    const onDoc=e=>{ if(ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown',onDoc);
    return ()=>document.removeEventListener('mousedown',onDoc);
  },[open]);
  const toggle=v=>onChange(selected.includes(v)?selected.filter(x=>x!==v):[...selected,v]);
  const label = selected.length===0 ? placeholder : selected.length===1 ? selected[0] : `${selected.length} selected`;
  return (
    <div ref={ref} style={{position:'relative'}}>
      <button onClick={()=>setOpen(o=>!o)} style={{...ctrl,cursor:'pointer',display:'flex',alignItems:'center',gap:8,minWidth:130,justifyContent:'space-between'}}>
        <span style={{whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',color:selected.length?OB.greyDeep:OB.grey}}>{label}</span>
        <span style={{fontSize:9,color:OB.grey}}>▾</span>
      </button>
      {open && (
        <div style={{position:'absolute',top:'100%',left:0,marginTop:4,zIndex:50,background:OB.white,border:`1px solid ${OB.greyPale}`,borderRadius:3,boxShadow:'0 4px 14px rgba(0,0,0,0.14)',minWidth:180,maxHeight:280,overflowY:'auto',padding:4}}>
          <div onClick={()=>onChange([])} style={{padding:'6px 8px',fontSize:12,color:selected.length===0?OB.greenDark:OB.grey,cursor:'pointer',fontWeight:selected.length===0?600:400}}>All</div>
          {options.map(o=>{
            const on=selected.includes(o);
            return (
              <label key={o} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 8px',fontSize:12,color:OB.greyDeep,cursor:'pointer',whiteSpace:'nowrap',borderRadius:2,background:on?OB.greenPale:'transparent'}}>
                <input type="checkbox" checked={on} onChange={()=>toggle(o)} style={{accentColor:OB.green}}/>
                {o}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function App({user, onSignOut, initialData}) {
  const supabase = useMemo(()=>createClient(), []);
  const [data, setData] = useState(initialData || initData());
  const [tab, setTab] = useState('capacity');
  const [adminTab, setAdminTab] = useState('dashboard');
  const [v2SubTab, setV2SubTab] = useState('scenarios'); // 'scenarios' | 'planner'
  const [granularity, setGranularity] = useState('month'); // 'month' | 'week' — shared across all period grids
  const [allocSubTab, setAllocSubTab] = useState('heatmap'); // 'heatmap' | 'projects' | 'resources'
  const [resourceModal, setResourceModal] = useState(null);
  const [projectModal, setProjectModal] = useState(null);
  const [allocModal, setAllocModal] = useState(null);
  const [filterDiv, setFilterDiv] = useState([]);
  const [filterSkill, setFilterSkill] = useState([]);
  const [filterPm, setFilterPm] = useState([]);
  const [viewYear, setViewYear] = useState(CUR_YEAR);

  const viewMonths = useMemo(() => MONTHS.map((_,i) => `${viewYear}-${String(i+1).padStart(2,'0')}`), [viewYear]);
  const activeAllocs = useMemo(() => activeAllocations(data), [data]);
  const allocationByResource = useMemo(() => buildAllocationMap(activeAllocs, data.resources), [activeAllocs, data.resources]);
  // Resources staffed on the selected PM(s)' projects (null = no PM filter).
  const pmResourceIds = useMemo(() => {
    if (filterPm.length===0) return null;
    const projIds = new Set(data.projects.filter(p=>p.pm && filterPm.includes(p.pm)).map(p=>p.id));
    return new Set(activeAllocs.filter(a=>projIds.has(a.projectId)).map(a=>a.resourceId));
  }, [filterPm, data.projects, activeAllocs]);
  const filteredResources = useMemo(() => data.resources.filter(r =>
    (filterDiv.length===0||filterDiv.includes(r.division)) && (filterSkill.length===0||filterSkill.includes(r.skillGroup)) && (!pmResourceIds||pmResourceIds.has(r.id))
  ), [data.resources, filterDiv, filterSkill, pmResourceIds]);

  // Re-fetch everything from the DB and replace local state. Used to re-sync
  // the UI to DB truth after a multi-step write fails partway through.
  async function reloadData() {
    try {
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
      setData({
        resources: (resources||[]).map(rowToRes),
        projects: (projects||[]).map(p=>({
          id:p.id, name:p.name, type:p.type, division:p.division, status:p.status,
          client:p.client||undefined, pm:p.project_manager||undefined,
          scenarios:(scenarios||[]).filter(s=>s.project_id===p.id).map(s=>({id:s.id,name:s.name,active:s.active})),
        })),
        allocations: (allocations||[]).map(rowToAlloc),
        v2Scenarios: (v2Scenarios||[]).map(s=>({id:s.id,name:s.name})),
        v2Projects: (v2Projects||[]).map(p=>({id:p.id,v2ScenarioId:p.v2_scenario_id,projectId:p.project_id})),
        v2Allocations: (v2Allocations||[]).map(rowToV2Alloc),
      });
    } catch(_){ /* best-effort re-sync; leave state as-is if the reload also fails */ }
  }

  async function saveResource(res) {
    try {
      if (res.id && UUID_RE.test(res.id)) {
        const {data:row,error}=await supabase.from('resources').update(resToRow(res)).eq('id',res.id).select().single();
        if(error) throw error;
        setData(d=>({...d,resources:d.resources.map(r=>r.id===row.id?rowToRes(row):r)}));
      } else {
        const {data:row,error}=await supabase.from('resources').insert(resToRow(res)).select().single();
        if(error) throw error;
        setData(d=>({...d,resources:[...d.resources,rowToRes(row)]}));
      }
      setResourceModal(null);
    } catch(e){ alert('Could not save resource: '+(e.message||e)); }
  }
  async function deleteResource(id) {
    try {
      // allocations.resource_id is ON DELETE CASCADE, so the DB drops them too.
      if (UUID_RE.test(id)) { const {error}=await supabase.from('resources').delete().eq('id',id); if(error) throw error; }
      setData(d=>({...d,resources:d.resources.filter(r=>r.id!==id),allocations:d.allocations.filter(a=>a.resourceId!==id)}));
    } catch(e){ alert('Could not delete resource: '+(e.message||e)); }
  }
  async function saveProject(proj) {
    try {
      if (proj.id && UUID_RE.test(proj.id)) {
        const {data:row,error}=await supabase.from('projects').update(projToRow(proj)).eq('id',proj.id).select().single();
        if(error) throw error;
        setData(d=>({...d,projects:d.projects.map(p=>p.id===row.id?{...p,name:row.name,type:row.type,division:row.division,status:row.status,client:row.client||undefined,pm:row.project_manager||undefined}:p)}));
      } else {
        const {data:prow,error}=await supabase.from('projects').insert(projToRow(proj)).select().single();
        if(error) throw error;
        // Every project needs a starting active scenario.
        const {data:srow,error:se}=await supabase.from('scenarios').insert({project_id:prow.id,name:'Baseline',active:true}).select().single();
        if(se) throw se;
        setData(d=>({...d,projects:[...d.projects,{id:prow.id,name:prow.name,type:prow.type,division:prow.division,status:prow.status,client:prow.client||undefined,pm:prow.project_manager||undefined,scenarios:[{id:srow.id,name:srow.name,active:srow.active}]}]}));
      }
      setProjectModal(null);
    } catch(e){ alert('Could not save project: '+(e.message||e)); await reloadData(); }
  }
  async function deleteProject(id) {
    try {
      // projects cascade to scenarios and allocations via FK ON DELETE CASCADE.
      if (UUID_RE.test(id)) { const {error}=await supabase.from('projects').delete().eq('id',id); if(error) throw error; }
      setData(d=>({...d,projects:d.projects.filter(p=>p.id!==id),allocations:d.allocations.filter(a=>a.projectId!==id)}));
    } catch(e){ alert('Could not delete project: '+(e.message||e)); return; }
  }
  // Create/update an allocation in Supabase, then mirror the result into state.
  async function saveAlloc(alloc) {
    try {
      if (alloc.id && UUID_RE.test(alloc.id)) {
        const {data:row,error} = await supabase.from('allocations').update(allocToRow(alloc)).eq('id',alloc.id).select().single();
        if (error) throw error;
        setData(d=>({...d,allocations:d.allocations.map(a=>a.id===row.id?rowToAlloc(row):a)}));
      } else {
        const {data:row,error} = await supabase.from('allocations').insert(allocToRow(alloc)).select().single();
        if (error) throw error;
        setData(d=>({...d,allocations:[...d.allocations,rowToAlloc(row)]}));
      }
      setAllocModal(null);
    } catch(e) {
      alert('Could not save allocation: '+(e.message||e));
    }
  }
  async function deleteAlloc(id) {
    try {
      if (UUID_RE.test(id)) { const {error}=await supabase.from('allocations').delete().eq('id',id); if(error) throw error; }
      setData(d=>({...d,allocations:d.allocations.filter(a=>a.id!==id)}));
    } catch(e) {
      alert('Could not delete allocation: '+(e.message||e));
    }
  }
  // Set one person's allocation % for a single month within a project/scenario.
  // Allocations are date ranges, so any range covering `month` is split around it
  // and the edited month becomes its own single-month allocation (0 removes it).
  // All resulting deletes/updates/inserts are persisted to Supabase.
  // Set one person's % for a single period (month OR week) on a project/scenario.
  // period = {start,end} as 'YYYY-MM-DD'. Range-splits any covering allocation around the period.
  async function setPeriodAllocation(projectId, scenarioId, resourceId, period, pct) {
    pct = Math.max(0, Math.min(200, Math.round(pct||0)));
    const mStart = period.start;
    const mEnd = period.end;
    const prevEnd = addDaysStr(mStart, -1);   // day before the period
    const nextStart = addDaysStr(mEnd, 1);    // day after the period
    const target = scenarioId || null;

    const covering = data.allocations.filter(a =>
      a.projectId===projectId && a.resourceId===resourceId && (a.scenarioId===target || !a.scenarioId) &&
      a.startDate <= mEnd && a.endDate >= mStart
    );

    const toDelete = [];  // ids
    const toUpdate = [];  // {id, patch:{start_date?,end_date?}, local:{startDate?,endDate?}}
    const toInsert = [];  // in-app allocation shapes
    covering.forEach(a => {
      const hasLeft = a.startDate < mStart;
      const hasRight = a.endDate > mEnd;
      if (hasLeft && hasRight) {
        toUpdate.push({id:a.id, patch:{end_date:prevEnd}, local:{endDate:prevEnd}});
        toInsert.push({resourceId, projectId, scenarioId:a.scenarioId, allocationPct:a.allocationPct, startDate:nextStart, endDate:a.endDate});
      } else if (hasLeft) {
        toUpdate.push({id:a.id, patch:{end_date:prevEnd}, local:{endDate:prevEnd}});
      } else if (hasRight) {
        toUpdate.push({id:a.id, patch:{start_date:nextStart}, local:{startDate:nextStart}});
      } else {
        toDelete.push(a.id);
      }
    });
    if (pct > 0) toInsert.push({resourceId, projectId, scenarioId:target, allocationPct:pct, startDate:mStart, endDate:mEnd});

    try {
      for (const id of toDelete) {
        if (UUID_RE.test(id)) { const {error}=await supabase.from('allocations').delete().eq('id',id); if(error) throw error; }
      }
      for (const u of toUpdate) {
        if (UUID_RE.test(u.id)) { const {error}=await supabase.from('allocations').update(u.patch).eq('id',u.id); if(error) throw error; }
      }
      const insertedRows = [];
      for (const ins of toInsert) {
        const {data:row,error}=await supabase.from('allocations').insert(allocToRow(ins)).select().single();
        if(error) throw error;
        insertedRows.push(rowToAlloc(row));
      }
      setData(d=>{
        let allocs = d.allocations.filter(a=>!toDelete.includes(a.id));
        allocs = allocs.map(a=>{
          const u = toUpdate.find(x=>x.id===a.id);
          return u ? {...a, ...u.local} : a;
        });
        return {...d, allocations:[...allocs, ...insertedRows]};
      });
    } catch(e) {
      alert('Could not save allocation change: '+(e.message||e));
      await reloadData(); // re-sync: earlier writes in this sequence may have committed
    }
  }
  // Backward-compatible month wrapper.
  function setMonthAllocation(projectId, scenarioId, resourceId, month, pct) {
    return setPeriodAllocation(projectId, scenarioId, resourceId, {start:`${month}-01`, end:monthEnd(month)}, pct);
  }
  // Insert several allocations at once (used by Team Finder). Returns count saved.
  async function addAllocations(allocs) {
    if (!allocs.length) return 0;
    try {
      const {data:rows,error} = await supabase.from('allocations').insert(allocs.map(allocToRow)).select();
      if (error) throw error;
      const mapped = (rows||[]).map(rowToAlloc);
      setData(d=>({...d, allocations:[...d.allocations, ...mapped]}));
      return mapped.length;
    } catch(e) {
      alert('Could not allocate team: '+(e.message||e));
      return 0;
    }
  }
  // Create a scenario in Supabase; returns the new UUID (or null on failure).
  async function addScenario(projectId, name) {
    try {
      const {data:row,error} = await supabase.from('scenarios').insert({project_id:projectId,name,active:false}).select().single();
      if (error) throw error;
      setData(d=>({...d,projects:d.projects.map(p=>p.id!==projectId?p:{...p,scenarios:[...(p.scenarios||[]),{id:row.id,name:row.name,active:row.active}]})}));
      return row.id;
    } catch(e) { alert('Could not add scenario: '+(e.message||e)); return null; }
  }
  // Activate one scenario: clear the project's current active first (unique index
  // allows only one active per project), then set the target active.
  async function activateScenario(projectId, scenarioId) {
    try {
      if (UUID_RE.test(scenarioId)) {
        const {error:e1}=await supabase.from('scenarios').update({active:false}).eq('project_id',projectId).eq('active',true);
        if (e1) throw e1;
        const {error:e2}=await supabase.from('scenarios').update({active:true}).eq('id',scenarioId);
        if (e2) throw e2;
      }
      setData(d=>({...d,projects:d.projects.map(p=>p.id!==projectId?p:{...p,scenarios:(p.scenarios||[]).map(s=>({...s,active:s.id===scenarioId}))})}));
    } catch(e) { alert('Could not activate scenario: '+(e.message||e)); }
  }
  async function deleteScenario(projectId, scenarioId) {
    try {
      // FK on allocations.scenario_id is ON DELETE CASCADE, so the DB drops its allocations too.
      if (UUID_RE.test(scenarioId)) { const {error}=await supabase.from('scenarios').delete().eq('id',scenarioId); if(error) throw error; }
      setData(d=>({...d,projects:d.projects.map(p=>p.id!==projectId?p:{...p,scenarios:(p.scenarios||[]).filter(s=>s.id!==scenarioId)}),allocations:d.allocations.filter(a=>!(a.projectId===projectId&&a.scenarioId===scenarioId))}));
    } catch(e) { alert('Could not remove scenario: '+(e.message||e)); }
  }
  async function renameScenario(projectId, scenarioId, name) {
    try {
      if (UUID_RE.test(scenarioId)) { const {error}=await supabase.from('scenarios').update({name}).eq('id',scenarioId); if(error) throw error; }
      setData(d=>({...d,projects:d.projects.map(p=>p.id!==projectId?p:{...p,scenarios:(p.scenarios||[]).map(s=>s.id===scenarioId?{...s,name}:s)})}));
    } catch(e) { alert('Could not rename scenario: '+(e.message||e)); }
  }
  // Clone a scenario and all its allocations into a new (inactive) scenario.
  async function duplicateScenario(projectId, scenarioId) {
    const proj = data.projects.find(p=>p.id===projectId);
    const scen = (proj?.scenarios||[]).find(s=>s.id===scenarioId);
    if (!scen) return;
    const names = new Set((proj.scenarios||[]).map(s=>s.name.toLowerCase()));
    let name = `${scen.name} copy`, n = 2;
    while (names.has(name.toLowerCase())) name = `${scen.name} copy ${n++}`;
    const newId = await addScenario(projectId, name);
    if (!newId) return;
    const src = data.allocations.filter(a=>a.projectId===projectId && a.scenarioId===scenarioId);
    if (src.length) {
      await addAllocations(src.map(a=>({resourceId:a.resourceId,projectId,scenarioId:newId,allocationPct:a.allocationPct,startDate:a.startDate,endDate:a.endDate})));
    }
  }

  // ── v2 cross-project scenarios (each scenario spans projects + allocations) ──
  async function addV2Scenario(name) {
    try {
      const {data:row,error}=await supabase.from('v2_scenarios').insert({name}).select().single();
      if(error) throw error;
      setData(d=>({...d, v2Scenarios:[...(d.v2Scenarios||[]), {id:row.id, name:row.name}]}));
      return row.id;
    } catch(e){ alert('Could not create scenario: '+(e.message||e)); return null; }
  }
  async function deleteV2Scenario(id) {
    try {
      if(UUID_RE.test(id)){ const {error}=await supabase.from('v2_scenarios').delete().eq('id',id); if(error) throw error; }
      setData(d=>({...d, v2Scenarios:(d.v2Scenarios||[]).filter(s=>s.id!==id), v2Projects:(d.v2Projects||[]).filter(p=>p.v2ScenarioId!==id), v2Allocations:(d.v2Allocations||[]).filter(a=>a.v2ScenarioId!==id)}));
    } catch(e){ alert('Could not delete scenario: '+(e.message||e)); }
  }
  async function renameV2Scenario(id, name) {
    try {
      if(UUID_RE.test(id)){ const {error}=await supabase.from('v2_scenarios').update({name}).eq('id',id); if(error) throw error; }
      setData(d=>({...d, v2Scenarios:(d.v2Scenarios||[]).map(s=>s.id===id?{...s,name}:s)}));
    } catch(e){ alert('Could not rename scenario: '+(e.message||e)); }
  }
  async function addV2Project(scenarioId, projectId) {
    if(!projectId || (data.v2Projects||[]).some(p=>p.v2ScenarioId===scenarioId&&p.projectId===projectId)) return;
    try {
      const {data:row,error}=await supabase.from('v2_scenario_projects').insert({v2_scenario_id:scenarioId, project_id:projectId}).select().single();
      if(error) throw error;
      // Seed the v2 scenario with the project's current active-scenario allocations.
      const proj=data.projects.find(p=>p.id===projectId);
      const activeScen=(proj?.scenarios||[]).find(s=>s.active);
      const src=data.allocations.filter(a=>a.projectId===projectId && (a.scenarioId===activeScen?.id || !a.scenarioId));
      let inserted=[];
      if(src.length){
        const {data:rows,error:e2}=await supabase.from('v2_allocations').insert(src.map(a=>v2AllocToRow({v2ScenarioId:scenarioId,projectId,resourceId:a.resourceId,allocationPct:a.allocationPct,startDate:a.startDate,endDate:a.endDate}))).select();
        if(e2) throw e2;
        inserted=(rows||[]).map(rowToV2Alloc);
      }
      setData(d=>({...d, v2Projects:[...(d.v2Projects||[]), {id:row.id, v2ScenarioId:scenarioId, projectId}], v2Allocations:[...(d.v2Allocations||[]), ...inserted]}));
    } catch(e){ alert('Could not add project: '+(e.message||e)); await reloadData(); }
  }
  async function removeV2Project(scenarioId, projectId) {
    try {
      if(UUID_RE.test(scenarioId)){ const {error}=await supabase.from('v2_scenario_projects').delete().eq('v2_scenario_id',scenarioId).eq('project_id',projectId); if(error) throw error; }
      setData(d=>({...d, v2Projects:(d.v2Projects||[]).filter(p=>!(p.v2ScenarioId===scenarioId&&p.projectId===projectId)), v2Allocations:(d.v2Allocations||[]).filter(a=>!(a.v2ScenarioId===scenarioId&&a.projectId===projectId))}));
    } catch(e){ alert('Could not remove project: '+(e.message||e)); }
  }
  // Apply a v2 scenario to the live plan: replace each of its projects' active-scenario
  // allocations with the scenario's allocations. Destructive; confirmed by caller.
  async function commitV2Scenario(scenarioId) {
    const projectIds = (data.v2Projects||[]).filter(p=>p.v2ScenarioId===scenarioId).map(p=>p.projectId);
    if(!projectIds.length){ alert('This scenario has no projects to commit.'); return; }
    if(!window.confirm(`Commit this scenario? It replaces the active allocations of ${projectIds.length} project${projectIds.length!==1?'s':''} with this scenario's allocations. This changes the live plan.`)) return;
    try {
      const deletedIds=[], inserted=[];
      for(const pid of projectIds){
        const proj=data.projects.find(p=>p.id===pid);
        const activeScenId=(proj?.scenarios||[]).find(s=>s.active)?.id||null;
        const toDel=data.allocations.filter(a=>a.projectId===pid && (a.scenarioId===activeScenId || !a.scenarioId));
        for(const a of toDel){ if(UUID_RE.test(a.id)){ const {error}=await supabase.from('allocations').delete().eq('id',a.id); if(error) throw error; } deletedIds.push(a.id); }
        const v2 = (data.v2Allocations||[]).filter(a=>a.v2ScenarioId===scenarioId && a.projectId===pid);
        if(v2.length){
          const {data:rows,error}=await supabase.from('allocations').insert(v2.map(a=>allocToRow({resourceId:a.resourceId,projectId:pid,scenarioId:activeScenId||undefined,allocationPct:a.allocationPct,startDate:a.startDate,endDate:a.endDate}))).select();
          if(error) throw error;
          inserted.push(...(rows||[]).map(rowToAlloc));
        }
      }
      setData(d=>({...d, allocations:[...d.allocations.filter(a=>!deletedIds.includes(a.id)), ...inserted]}));
      alert('Scenario committed to the live plan.');
    } catch(e){ alert('Could not commit scenario: '+(e.message||e)); await reloadData(); }
  }
  // Set one person's % for a single month on a project within a v2 scenario (range-split, persisted).
  async function setV2Period(scenarioId, projectId, resourceId, period, pct) {
    pct = Math.max(0, Math.min(200, Math.round(pct||0)));
    const mStart = period.start, mEnd = period.end, prevEnd = addDaysStr(mStart,-1), nextStart = addDaysStr(mEnd,1);
    const covering = (data.v2Allocations||[]).filter(a=>a.v2ScenarioId===scenarioId && a.projectId===projectId && a.resourceId===resourceId && a.startDate<=mEnd && a.endDate>=mStart);
    const toDelete=[], toUpdate=[], toInsert=[];
    covering.forEach(a=>{
      const hasLeft=a.startDate<mStart, hasRight=a.endDate>mEnd;
      if(hasLeft&&hasRight){ toUpdate.push({id:a.id,patch:{end_date:prevEnd},local:{endDate:prevEnd}}); toInsert.push({v2ScenarioId:scenarioId,projectId,resourceId,allocationPct:a.allocationPct,startDate:nextStart,endDate:a.endDate}); }
      else if(hasLeft){ toUpdate.push({id:a.id,patch:{end_date:prevEnd},local:{endDate:prevEnd}}); }
      else if(hasRight){ toUpdate.push({id:a.id,patch:{start_date:nextStart},local:{startDate:nextStart}}); }
      else { toDelete.push(a.id); }
    });
    if(pct>0) toInsert.push({v2ScenarioId:scenarioId,projectId,resourceId,allocationPct:pct,startDate:mStart,endDate:mEnd});
    try {
      for(const id of toDelete){ if(UUID_RE.test(id)){ const {error}=await supabase.from('v2_allocations').delete().eq('id',id); if(error) throw error; } }
      for(const u of toUpdate){ if(UUID_RE.test(u.id)){ const {error}=await supabase.from('v2_allocations').update(u.patch).eq('id',u.id); if(error) throw error; } }
      const inserted=[];
      for(const ins of toInsert){ const {data:row,error}=await supabase.from('v2_allocations').insert(v2AllocToRow(ins)).select().single(); if(error) throw error; inserted.push(rowToV2Alloc(row)); }
      setData(d=>{
        let allocs=(d.v2Allocations||[]).filter(a=>!toDelete.includes(a.id));
        allocs=allocs.map(a=>{ const u=toUpdate.find(x=>x.id===a.id); return u?{...a,...u.local}:a; });
        return {...d, v2Allocations:[...allocs, ...inserted]};
      });
    } catch(e){ alert('Could not save allocation: '+(e.message||e)); await reloadData(); }
  }
  function setV2Month(scenarioId, projectId, resourceId, month, pct) {
    return setV2Period(scenarioId, projectId, resourceId, {start:`${month}-01`, end:monthEnd(month)}, pct);
  }

  const statusColor = s => ({
    'In Progress':OB.green,'On Hold':OB.onHold,'Completed':OB.greyDark,
    'Cancelled':OB.cancelled,'Delayed':OB.cancelled,'Opportunity':OB.opportunity,
    'Open <50%':OB.onHold,'Open >50%':OB.opportunity,'Deal Won':OB.greenDark,'Closed':OB.grey
  }[s]||OB.grey);
  const statusBg = s => ({
    'In Progress':OB.greenPale,'On Hold':'#fef3e2','Completed':'#f0f3f3',
    'Cancelled':'#fdf0ef','Delayed':'#fdf0ef','Opportunity':'#e8f3f7',
    'Open <50%':'#fef3e2','Open >50%':'#e8f3f7','Deal Won':OB.greenPale,'Closed':'#f0f3f3'
  }[s]||OB.greyPale);
  const allocColor = pct => pct===0?'transparent':pct>100?OB.cancelled:pct===100?OB.green:pct>=75?OB.greenLight:pct>=50?OB.greenPale:'#f9fde8';
  const allocTextColor = pct => pct>100?'#ffdede':OB.greenDark;

  const TABS = [
    ['capacity','Allocations'],['scenariosv2','Scenarios'],
  ];
  const ADMIN_TABS = [
    ['dashboard','Dashboard'],['teamfinder','Team finder'],['resources','Resources'],['projects','Projects'],
  ];

  return (
    <div style={{fontFamily:FONT,padding:'0 0 2rem',width:'90%',maxWidth:1500,margin:'0 auto',color:OB.greyDeep}}>
      <style>{globalStyle}</style>
      <div style={{borderBottom:`3px solid ${OB.green}`,marginBottom:'1.5rem',paddingTop:'1.25rem',paddingBottom:'1rem'}}>
        <div style={{display:'flex',alignItems:'baseline',gap:12}}>
          <h2 style={{fontSize:22,fontWeight:300,color:OB.greyDeep,margin:0,letterSpacing:'-0.02em'}}>Headroom</h2>
          <span style={{fontSize:12,color:OB.grey}}>{data.resources.length} resources · {data.projects.length} projects · {activeAllocs.length} active allocations</span>
          <div style={{flex:1}}/>
          {user && <span style={{fontSize:11,color:OB.grey,marginLeft:'auto'}}>{user.email}</span>}
          {onSignOut && <button onClick={onSignOut} style={{fontFamily:FONT,fontSize:11,padding:'3px 10px',borderRadius:3,border:`1px solid ${OB.greyPale}`,background:OB.white,color:OB.grey,cursor:'pointer',marginLeft:8}}>Sign out</button>}
        </div>
      </div>
      <div style={{display:'flex',alignItems:'center',marginBottom:'1.5rem',borderBottom:`1px solid ${OB.greyPale}`}}>
        {TABS.map(([key,label]) => (
          <button key={key} onClick={()=>setTab(key)} style={{
            background:'none',border:'none',borderBottom:tab===key?`2px solid ${OB.green}`:'2px solid transparent',
            padding:'8px 14px',fontSize:12,fontWeight:tab===key?600:400,
            color:tab===key?OB.greyDeep:OB.grey,cursor:'pointer',marginBottom:-1
          }}>{label}</button>
        ))}
        <div style={{flex:1}}/>
        <button onClick={()=>setTab('admin')} title="Admin" aria-label="Admin" style={{
          background:'none',border:'none',borderBottom:tab==='admin'?`2px solid ${OB.green}`:'2px solid transparent',
          padding:'6px 12px',fontSize:17,lineHeight:1,color:tab==='admin'?OB.greyDeep:OB.grey,cursor:'pointer',marginBottom:-1
        }}>{'⚙'}</button>
      </div>

      {tab==='admin' && (
        <>
          <div style={{display:'flex',gap:6,marginBottom:'1.25rem',flexWrap:'wrap'}}>
            {ADMIN_TABS.map(([key,label])=>(
              <button key={key} onClick={()=>setAdminTab(key)} style={{
                fontFamily:FONT,fontSize:12,padding:'5px 12px',borderRadius:3,cursor:'pointer',border:'none',
                background:adminTab===key?OB.green:OB.greyPale,
                color:adminTab===key?OB.greyDeep:OB.grey,
                fontWeight:adminTab===key?600:400,
              }}>{label}</button>
            ))}
          </div>
          {adminTab==='dashboard' && <Dashboard data={data} allocationByResource={allocationByResource} statusColor={statusColor} statusBg={statusBg} />}
          {adminTab==='teamfinder' && <TeamFinderView data={data} allocationByResource={allocationByResource} onAllocateTeam={addAllocations} />}
          {adminTab==='resources' && <ResourcesTab data={data} onEdit={r=>setResourceModal(r)} onDelete={deleteResource} onAdd={()=>setResourceModal({})} onSetMonth={setMonthAllocation} statusColor={statusColor} statusBg={statusBg} allocColor={allocColor} allocTextColor={allocTextColor} simple />}
          {adminTab==='projects' && <ProjectsTab data={data} onEdit={p=>setProjectModal(p)} onDelete={deleteProject} onAdd={()=>setProjectModal({})} onAddAlloc={a=>setAllocModal(a)} onSetPeriod={setPeriodAllocation} granularity={granularity} setGranularity={setGranularity} statusColor={statusColor} statusBg={statusBg} allocColor={allocColor} allocTextColor={allocTextColor} simple />}
        </>
      )}
      {tab==='capacity' && (
        <>
          <SubNav tabs={[['heatmap','By Person'],['projects','By Project']]} selected={allocSubTab} onSelect={setAllocSubTab} />
          {allocSubTab==='heatmap' && <CapacityView data={data} allocationByResource={allocationByResource} allocColor={allocColor} allocTextColor={allocTextColor} granularity={granularity} setGranularity={setGranularity} filterDiv={filterDiv} setFilterDiv={setFilterDiv} filterSkill={filterSkill} setFilterSkill={setFilterSkill} filterPm={filterPm} setFilterPm={setFilterPm} filteredResources={filteredResources} onAddAlloc={a=>setAllocModal(a)} onSetPeriod={setPeriodAllocation} statusColor={statusColor} />}
          {allocSubTab==='projects' && <ProjectsTab data={data} onEdit={p=>setProjectModal(p)} onDelete={deleteProject} onAdd={()=>setProjectModal({})} onAddAlloc={a=>setAllocModal(a)} onSetPeriod={setPeriodAllocation} granularity={granularity} setGranularity={setGranularity} statusColor={statusColor} statusBg={statusBg} allocColor={allocColor} allocTextColor={allocTextColor} hideScenario hideEdit />}
        </>
      )}
      {tab==='scenariosv2' && (
        <>
          <SubNav tabs={[['scenarios','Scenarios'],['planner','Planner']]} selected={v2SubTab} onSelect={setV2SubTab} />
          {v2SubTab==='scenarios' && <ScenariosView data={data} onAddScenario={addV2Scenario} onDeleteScenario={deleteV2Scenario} onRenameScenario={renameV2Scenario} onAddProject={addV2Project} onRemoveProject={removeV2Project} onSetPeriod={setV2Period} granularity={granularity} setGranularity={setGranularity} statusColor={statusColor} allocColor={allocColor} allocTextColor={allocTextColor} />}
          {v2SubTab==='planner' && <PlannerView data={data} allocColor={allocColor} allocTextColor={allocTextColor} onCommit={commitV2Scenario} granularity={granularity} setGranularity={setGranularity} />}
        </>
      )}

      {resourceModal!==null && <ResourceModal resource={resourceModal} onSave={saveResource} onClose={()=>setResourceModal(null)} />}
      {projectModal!==null && <ProjectModal project={projectModal} onSave={saveProject} onClose={()=>setProjectModal(null)} clients={[...new Set(data.projects.map(p=>p.client).filter(Boolean))].sort()} resources={data.resources} />}
      {allocModal!==null && <AllocModal alloc={allocModal} data={data} onSave={saveAlloc} onDelete={deleteAlloc} onClose={()=>setAllocModal(null)} />}
    </div>
  );
}

function Dashboard({data, allocationByResource, statusColor, statusBg}) {
  const now = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}`;

  const [divFilter, setDivFilter] = useState([]);
  const [projSearch, setProjSearch] = useState('');
  const [projStatusFilter, setProjStatusFilter] = useState([]);
  const [projSort, setProjSort] = useState('name');
  const [projSortDir, setProjSortDir] = useState('asc');

  // Cursor-following tooltip shared by the dashboard charts.
  const [tip, setTip] = useState(null); // {x,y,content}
  const showTip = (e,content)=>setTip({x:e.clientX,y:e.clientY,content});
  const moveTip = e=>setTip(t=>t?{...t,x:e.clientX,y:e.clientY}:t);
  const hideTip = ()=>setTip(null);
  const tipProps = content => ({ onMouseEnter:e=>showTip(e,content), onMouseMove:moveTip, onMouseLeave:hideTip });

  const divisions = [...new Set(data.resources.map(r=>r.division))].sort();

  // All panels respect the top-level division filter
  const visibleResources = divFilter.length===0 ? data.resources : data.resources.filter(r=>divFilter.includes(r.division));
  const visibleProjects  = divFilter.length===0 ? data.projects  : data.projects.filter(p=>divFilter.includes(p.division));

  const totalRes       = visibleResources.length;
  const available      = visibleResources.filter(r=>(allocationByResource[r.id]?.[now]||0)<100).length;
  const fullyAllocated = visibleResources.filter(r=>(allocationByResource[r.id]?.[now]||0)>=100).length;
  const overAllocated  = visibleResources.filter(r=>(allocationByResource[r.id]?.[now]||0)>100).length;
  const activeProjects = visibleProjects.filter(p=>p.status==='In Progress').length;

  const skillBreakdown = {};
  visibleResources.forEach(r=>{skillBreakdown[r.skillGroup]=(skillBreakdown[r.skillGroup]||0)+1;});

  // ── Dashboard analytics (all respect the division filter) ──────────────────
  const addYM=(ym,n)=>{const [y,mm]=ym.split('-').map(Number);const idx=y*12+(mm-1)+n;return `${Math.floor(idx/12)}-${String(idx%12+1).padStart(2,'0')}`;};
  const next12=Array.from({length:12},(_,i)=>addYM(now,i));
  const next3=[now,addYM(now,1),addYM(now,2)];
  const capacity=visibleResources.filter(r=>r.status==='Active').length;

  const trend=next12.map(m=>({m, demand:Math.round(visibleResources.reduce((s,r)=>s+(allocationByResource[r.id]?.[m]||0),0)/100*10)/10}));
  const trendMax=Math.max(capacity,...trend.map(t=>t.demand),1);

  const projActive=visibleProjects.map(p=>{
    const activeScen=(p.scenarios||[]).find(s=>s.active);
    const allocs=data.allocations.filter(a=>a.projectId===p.id&&(a.scenarioId===activeScen?.id||!a.scenarioId));
    const resourceIds=[...new Set(allocs.map(a=>a.resourceId))];
    const effort=allocs.reduce((s,a)=>s+(a.allocationPct/100)*monthsInRange(a.startDate,a.endDate).length,0);
    const overNow=resourceIds.filter(id=>(allocationByResource[id]?.[now]||0)>100).length;
    return {project:p, resourceIds, headcount:resourceIds.length, effort:Math.round(effort*10)/10, overNow};
  });
  const perProject=[...projActive].filter(x=>x.headcount>0).sort((a,b)=>b.headcount-a.headcount).slice(0,8);
  const projMax=Math.max(1,...perProject.map(x=>x.headcount));

  const clientAgg={};
  projActive.forEach(({project,resourceIds,effort})=>{
    const c=project.client||'— No client —';
    const e=(clientAgg[c]=clientAgg[c]||{people:new Set(),effort:0,projects:0});
    resourceIds.forEach(id=>e.people.add(id)); e.effort+=effort; e.projects+=1;
  });
  const perClient=Object.entries(clientAgg).map(([client,v])=>({client,count:v.people.size,effort:Math.round(v.effort*10)/10,projects:v.projects})).sort((a,b)=>b.count-a.count);
  const clientMax=Math.max(1,...perClient.map(x=>x.count));

  const watch=visibleResources.map(r=>{
    let peak=0,peakMonth=now;
    next3.forEach(m=>{const v=allocationByResource[r.id]?.[m]||0; if(v>peak){peak=v;peakMonth=m;}});
    return {r,peak,peakMonth};
  }).filter(x=>x.peak>100).sort((a,b)=>b.peak-a.peak);

  const utilDivs=(divFilter.length===0?divisions:divFilter).map(d=>{
    const rs=visibleResources.filter(r=>r.division===d&&r.status==='Active');
    const cap=rs.length;
    const alloc=Math.round(rs.reduce((s,r)=>s+(allocationByResource[r.id]?.[now]||0),0)/100*10)/10;
    return {d,cap,alloc,util:cap?Math.round(alloc/cap*100):0};
  }).filter(x=>x.cap>0);

  const statusCounts=PROJECT_STATUSES.map(s=>({s,count:visibleProjects.filter(p=>p.status===s).length})).filter(x=>x.count>0);
  const statusMax=Math.max(1,...statusCounts.map(x=>x.count));

  const _t=new Date(); const _p=n=>`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
  const todayStr=_p(_t); const in60Str=_p(new Date(_t.getFullYear(),_t.getMonth(),_t.getDate()+60));
  const rollOffs=data.allocations.map(a=>{
    const proj=visibleProjects.find(p=>p.id===a.projectId); if(!proj) return null;
    const activeScen=(proj.scenarios||[]).find(s=>s.active);
    if(!(a.scenarioId===activeScen?.id||!a.scenarioId)) return null;
    if(!(a.endDate>=todayStr&&a.endDate<=in60Str)) return null;
    const res=data.resources.find(r=>r.id===a.resourceId); if(!res) return null;
    return {a,res,proj};
  }).filter(Boolean).sort((x,y)=>x.a.endDate.localeCompare(y.a.endDate));

  function toggleSort(col) {
    if (projSort===col) setProjSortDir(d=>d==='asc'?'desc':'asc');
    else { setProjSort(col); setProjSortDir('asc'); }
  }

  const filteredProjects = useMemo(() => {
    return visibleProjects
      .filter(p => {
        const q = projSearch.toLowerCase();
        const matchSearch = !q || p.name.toLowerCase().includes(q) || p.type.toLowerCase().includes(q) || p.division.toLowerCase().includes(q);
        const matchStatus = projStatusFilter.length===0 || projStatusFilter.includes(p.status);
        return matchSearch && matchStatus;
      })
      .map(p => {
        const activeScen = (p.scenarios||[]).find(s=>s.active);
        const activeAllocs = data.allocations.filter(a=>a.projectId===p.id&&(a.scenarioId===activeScen?.id||!a.scenarioId));
        const resourceIds = [...new Set(activeAllocs.map(a=>a.resourceId))];
        return {...p, activeScen, resourceCount: resourceIds.length, resourceIds};
      })
      .sort((a,b) => {
        let av = a[projSort]||'', bv = b[projSort]||'';
        if (projSort==='resourceCount') { av=a.resourceCount; bv=b.resourceCount; }
        const cmp = typeof av==='number' ? av-bv : String(av).localeCompare(String(bv));
        return projSortDir==='asc' ? cmp : -cmp;
      });
  }, [visibleProjects, data.allocations, projSearch, projStatusFilter, projSort, projSortDir]);


  function SortIcon({col}) {
    if (projSort!==col) return <span style={{color:OB.greyPale,marginLeft:4}}>↕</span>;
    return <span style={{color:OB.green,marginLeft:4}}>{projSortDir==='asc'?'↑':'↓'}</span>;
  }

  const thStyle = (col) => ({
    textAlign:'left', padding:'8px 10px', fontWeight:600, color:OB.grey,
    fontSize:10, textTransform:'uppercase', letterSpacing:'0.06em',
    borderBottom:`2px solid ${OB.greyPale}`, cursor:'pointer', whiteSpace:'nowrap',
    userSelect:'none', background:OB.greyPale,
  });

  function BarRow({label,value,frac,color=OB.green,valColor=OB.greyDeep,tip}){
    return (
      <div {...(tip?tipProps(tip):{})} style={{display:'flex',alignItems:'center',gap:8,marginBottom:6,cursor:tip?'default':'inherit'}}>
        <div style={{fontSize:12,color:OB.greyDark,width:120,flexShrink:0,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{label}</div>
        <div style={{flex:1,background:OB.greyPale,borderRadius:2,height:12}}>
          <div style={{width:`${Math.min(frac*100,100)}%`,background:color,borderRadius:2,height:12}}/>
        </div>
        <div style={{fontSize:11,fontWeight:600,minWidth:64,textAlign:'right',color:valColor}}>{value}</div>
      </div>
    );
  }

  return (
    <div>
      {/* Division filter */}
      <div style={{marginBottom:'1.25rem'}}>
        <MultiFilter label="Division" options={divisions} selected={divFilter} onChange={setDivFilter}/>
      </div>

      {/* KPI strip */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:10,marginBottom:'1.5rem'}}>
        {[['Total resources',totalRes,OB.greyDeep],['Available now',available,OB.greenDark],['Fully allocated',fullyAllocated,OB.onHold],['Over-allocated',overAllocated,OB.cancelled],['Active projects',activeProjects,OB.greyDeep]].map(([label,val,col])=>(
          <div key={label} style={{background:OB.greyPale,borderRadius:4,padding:'14px 16px',borderLeft:`3px solid ${col}`}}>
            <div style={{fontSize:11,color:OB.grey,marginBottom:6,textTransform:'uppercase',letterSpacing:'0.06em',fontWeight:600}}>{label}</div>
            <div style={{fontSize:26,fontWeight:300,color:col,lineHeight:1}}>{val}</div>
          </div>
        ))}
      </div>

      {/* Capacity vs demand */}
      <div style={{...card,marginBottom:'1.5rem'}}>
        <span style={sectionLabel}>Capacity vs demand — next 12 months (FTE)</span>
        <div style={{display:'flex',alignItems:'flex-end',gap:5,height:100,position:'relative',marginTop:8}}>
          <div style={{position:'absolute',left:0,right:0,bottom:`${(capacity/trendMax)*100}px`,borderTop:`1px dashed ${OB.greyDeep}`,zIndex:1}}/>
          {trend.map(({m,demand})=>{
            const diff=Math.round((demand-capacity)*10)/10;
            return <div key={m} {...tipProps(
              <div><div style={{fontWeight:700,marginBottom:2}}>{fmtMonth(m)}</div>
                <div>Demand: {demand} FTE</div><div>Capacity: {capacity} FTE</div>
                <div style={{color:diff>0?'#ffb3b3':OB.greenLight}}>{diff>0?`Over by ${diff}`:`${Math.abs(diff)} FTE spare`}</div>
              </div>
            )} style={{flex:1,height:`${Math.max((demand/trendMax)*100,demand>0?2:0)}px`,background:demand>capacity?OB.cancelled:OB.green,borderRadius:'2px 2px 0 0',cursor:'default'}}/>;
          })}
        </div>
        <div style={{display:'flex',gap:5,marginTop:3}}>
          {trend.map(({m})=>(<div key={m} style={{flex:1,textAlign:'center',fontSize:9,color:OB.greyLight}}>{MONTHS[parseInt(m.split('-')[1])-1]}</div>))}
        </div>
        <div style={{display:'flex',gap:14,marginTop:8,fontSize:10,color:OB.grey,flexWrap:'wrap',alignItems:'center'}}>
          <span style={{display:'flex',alignItems:'center',gap:5}}><span style={{width:12,height:12,background:OB.green,borderRadius:2}}/>Within capacity</span>
          <span style={{display:'flex',alignItems:'center',gap:5}}><span style={{width:12,height:12,background:OB.cancelled,borderRadius:2}}/>Over capacity</span>
          <span style={{display:'flex',alignItems:'center',gap:5}}><span style={{width:14,borderTop:`1px dashed ${OB.greyDeep}`}}/>Capacity ({capacity} FTE)</span>
        </div>
      </div>

      {/* People per client / project */}
      <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) minmax(0,1fr)',gap:16,marginBottom:'1.5rem'}}>
        <div style={card}>
          <span style={sectionLabel}>People per client</span>
          {perClient.length===0&&<div style={{fontSize:12,color:OB.greyLight}}>No projects with clients yet.</div>}
          {perClient.map(({client,count,projects,effort})=>(
            <BarRow key={client} label={client} frac={count/clientMax}
              value={<span style={{whiteSpace:'nowrap'}}><b style={{color:OB.greyDeep}}>{count}</b> <span style={{color:OB.greyLight,fontWeight:400}}>{projects} proj</span></span>}
              tip={<div><div style={{fontWeight:700,marginBottom:2}}>{client}</div><div>{count} {count===1?'person':'people'} staffed</div><div>{projects} {projects===1?'project':'projects'}</div><div>{effort} person-months</div></div>}/>
          ))}
        </div>
        <div style={card}>
          <span style={sectionLabel}>People per project (top 8)</span>
          {perProject.length===0&&<div style={{fontSize:12,color:OB.greyLight}}>No staffed projects.</div>}
          {perProject.map(({project,headcount,overNow})=>(
            <BarRow key={project.id} label={project.name} frac={headcount/projMax}
              value={<span style={{whiteSpace:'nowrap'}}><b style={{color:OB.greyDeep}}>{headcount}</b>{overNow>0&&<span style={{fontSize:9,background:'#fdf0ef',color:OB.cancelled,padding:'1px 5px',borderRadius:2,marginLeft:5,fontWeight:600}}>{overNow} over</span>}</span>}
              tip={<div><div style={{fontWeight:700,marginBottom:2}}>{project.name}</div><div>{headcount} on the team</div><div style={{color:overNow>0?'#ffb3b3':OB.greenLight}}>{overNow>0?`${overNow} over-allocated this month`:'None over-allocated'}</div></div>}/>
          ))}
        </div>
      </div>

      {/* Utilization / watchlist */}
      <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) minmax(0,1fr)',gap:16,marginBottom:'1.5rem'}}>
        <div style={card}>
          <span style={sectionLabel}>Utilization by division — this month</span>
          {utilDivs.length===0&&<div style={{fontSize:12,color:OB.greyLight}}>No active resources.</div>}
          {utilDivs.map(({d,cap,alloc,util})=>(
            <BarRow key={d} label={d} frac={util/100} color={util>100?OB.cancelled:util>=90?OB.green:OB.greenLight} value={`${util}%`}
              tip={<div><div style={{fontWeight:700,marginBottom:2}}>{d}</div><div>{alloc} of {cap} FTE allocated</div><div>{util}% utilization this month</div></div>}/>
          ))}
        </div>
        <div style={card}>
          <span style={sectionLabel}>Over-allocation watchlist — next 3 months</span>
          {watch.length===0&&<div style={{fontSize:12,color:OB.greenDark}}>No one is over-allocated in this window.</div>}
          {watch.map(({r,peak,peakMonth})=>(
            <div key={r.id} {...tipProps(<div><div style={{fontWeight:700,marginBottom:2}}>{r.name}</div><div>{r.skillGroup}</div><div style={{color:'#ffb3b3'}}>Peaks at {peak}% in {fmtMonth(peakMonth)}</div></div>)} style={{display:'flex',alignItems:'center',gap:8,marginBottom:6,cursor:'default'}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:600,color:OB.greyDeep,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{r.name}</div>
                <div style={{fontSize:10,color:OB.grey}}>{r.skillGroup}</div>
              </div>
              <div style={{fontSize:12,fontWeight:600,color:OB.cancelled,whiteSpace:'nowrap'}}>{peak}% · {fmtMonth(peakMonth)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Status / roll-offs */}
      <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) minmax(0,1fr)',gap:16,marginBottom:'1.5rem'}}>
        <div style={card}>
          <span style={sectionLabel}>Projects by status</span>
          {statusCounts.length===0&&<div style={{fontSize:12,color:OB.greyLight}}>No projects.</div>}
          {statusCounts.map(({s,count})=>(
            <div key={s} {...tipProps(<div><div style={{fontWeight:700,marginBottom:2}}>{s}</div><div>{count} {count===1?'project':'projects'}</div></div>)} style={{display:'flex',alignItems:'center',gap:8,marginBottom:6,cursor:'default'}}>
              <div style={{display:'flex',alignItems:'center',gap:6,width:120,flexShrink:0}}>
                <span style={{width:8,height:8,borderRadius:'50%',background:statusColor(s),flexShrink:0}}/>
                <span style={{fontSize:12,color:OB.greyDark,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{s}</span>
              </div>
              <div style={{flex:1,background:OB.greyPale,borderRadius:2,height:12}}>
                <div style={{width:`${count/statusMax*100}%`,background:statusColor(s),borderRadius:2,height:12}}/>
              </div>
              <div style={{fontSize:11,fontWeight:600,minWidth:24,textAlign:'right',color:OB.greyDeep}}>{count}</div>
            </div>
          ))}
        </div>
        <div style={card}>
          <span style={sectionLabel}>Rolling off — next 60 days</span>
          {rollOffs.length===0&&<div style={{fontSize:12,color:OB.greyLight}}>No allocations ending soon.</div>}
          {rollOffs.slice(0,8).map(({a,res,proj})=>(
            <div key={a.id} {...tipProps(<div><div style={{fontWeight:700,marginBottom:2}}>{res.name}</div><div>{proj.name}</div><div>{a.allocationPct}% · ends {a.endDate}</div></div>)} style={{display:'flex',alignItems:'center',gap:8,marginBottom:6,cursor:'default'}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:600,color:OB.greyDeep,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{res.name}</div>
                <div style={{fontSize:10,color:OB.grey,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{proj.name}</div>
              </div>
              <div style={{fontSize:11,color:OB.greyDark,whiteSpace:'nowrap'}}>{a.endDate}</div>
            </div>
          ))}
          {rollOffs.length>8&&<div style={{fontSize:11,color:OB.greyLight,marginTop:4}}>+{rollOffs.length-8} more</div>}
        </div>
      </div>

      {/* Two-col panels */}
      <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) minmax(0,1fr)',gap:16,marginBottom:'1.5rem'}}>
        <div style={card}>
          <span style={sectionLabel}>Resources by skill group</span>
          <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
            {Object.entries(skillBreakdown).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([skill,count])=>(
              <div key={skill} style={{display:'inline-flex',alignItems:'center',gap:8,background:OB.greyPale,borderRadius:20,padding:'5px 6px 5px 12px'}}>
                <span style={{fontSize:12,color:OB.greyDark,whiteSpace:'nowrap'}}>{skill}</span>
                <span style={{minWidth:22,height:22,borderRadius:'50%',background:OB.green,color:OB.greyDeep,fontSize:12,fontWeight:700,display:'inline-flex',alignItems:'center',justifyContent:'center',padding:'0 6px'}}>{count}</span>
              </div>
            ))}
          </div>
          {totalRes===0&&<div style={{fontSize:12,color:OB.greyLight}}>No resources in this division.</div>}
        </div>
        <div style={card}>
          <span style={sectionLabel}>Current month allocation</span>
          {visibleResources.filter(r=>r.status==='Active').map(r=>{
            const pct = allocationByResource[r.id]?.[now]||0;
            return (
              <div key={r.id} style={{display:'flex',alignItems:'center',gap:8,marginBottom:7}}>
                <div title={r.name} style={{fontSize:12,color:OB.greyDark,width:130,flexShrink:0,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{r.name}</div>
                <div style={{flex:1,background:OB.greyPale,borderRadius:2,height:6}}>
                  <div style={{width:`${Math.min(pct,100)}%`,background:pct>100?OB.cancelled:pct>=100?OB.green:OB.greenLight,borderRadius:2,height:6}}/>
                </div>
                <div style={{fontSize:11,fontWeight:600,minWidth:34,textAlign:'right',color:pct>100?OB.cancelled:pct>=100?OB.greenDark:OB.grey}}>{pct}%</div>
              </div>
            );
          })}
          {visibleResources.filter(r=>r.status==='Active').length===0&&<div style={{fontSize:12,color:OB.greyLight}}>No active resources in this division.</div>}
        </div>
      </div>

      {/* Projects table */}
      <div style={card}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:'1rem',flexWrap:'wrap'}}>
          <span style={{...sectionLabel,marginBottom:0,flex:'none'}}>Projects overview</span>
          <div style={{flex:1}}/>
          <input
            placeholder="Search projects..."
            value={projSearch}
            onChange={e=>setProjSearch(e.target.value)}
            style={{...ctrl,padding:'5px 9px',minWidth:160}}
          />
          <MultiSelect options={PROJECT_STATUSES} selected={projStatusFilter} onChange={setProjStatusFilter} placeholder="All statuses"/>
          <span style={{fontSize:11,color:OB.grey,flexShrink:0}}>{filteredProjects.length} of {visibleProjects.length}</span>
        </div>

        <div style={{overflowX:'auto',borderRadius:3,border:`1px solid ${OB.greyPale}`}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12,fontFamily:FONT}}>
            <thead>
              <tr>
                <th style={thStyle('name')} onClick={()=>toggleSort('name')}>Project <SortIcon col="name"/></th>
                <th style={thStyle('type')} onClick={()=>toggleSort('type')}>Type <SortIcon col="type"/></th>
                <th style={thStyle('division')} onClick={()=>toggleSort('division')}>Division <SortIcon col="division"/></th>
                <th style={thStyle('status')} onClick={()=>toggleSort('status')}>Status <SortIcon col="status"/></th>
                <th style={{...thStyle('resourceCount'),textAlign:'center'}} onClick={()=>toggleSort('resourceCount')}>Team <SortIcon col="resourceCount"/></th>
                <th style={thStyle('activeScen')}>Scenario</th>
                <th style={{...thStyle(''),textAlign:'left'}}>People</th>
              </tr>
            </thead>
            <tbody>
              {filteredProjects.map((p,i)=>{
                const teamResources = p.resourceIds.map(id=>data.resources.find(r=>r.id===id)).filter(Boolean);
                return (
                  <tr key={p.id} style={{borderBottom:`1px solid ${OB.greyPale}`,background:i%2===0?OB.white:'#fafafa'}}>
                    <td style={{padding:'9px 10px',fontWeight:600,color:OB.greyDeep,whiteSpace:'nowrap'}}>
                      <div style={{display:'flex',alignItems:'center',gap:6}}>
                        <div style={{width:3,height:20,borderRadius:2,background:statusColor(p.status),flexShrink:0}}/>
                        {p.name}
                      </div>
                    </td>
                    <td style={{padding:'9px 10px',color:OB.grey,whiteSpace:'nowrap'}}>{p.type}</td>
                    <td style={{padding:'9px 10px',color:OB.grey,whiteSpace:'nowrap'}}>{p.division}</td>
                    <td style={{padding:'9px 10px'}}>
                      <span style={{fontSize:10,padding:'2px 8px',borderRadius:2,background:statusBg(p.status),color:statusColor(p.status),fontWeight:600,textTransform:'uppercase',letterSpacing:'0.04em',whiteSpace:'nowrap'}}>{p.status}</span>
                    </td>
                    <td style={{padding:'9px 10px',textAlign:'center'}}>
                      <span style={{fontSize:12,fontWeight:600,color:p.resourceCount>0?OB.greyDeep:OB.greyLight}}>{p.resourceCount}</span>
                    </td>
                    <td style={{padding:'9px 10px'}}>
                      {p.activeScen&&<span style={{fontSize:10,padding:'2px 7px',borderRadius:2,background:OB.greenPale,color:OB.greenDark,fontWeight:600,whiteSpace:'nowrap'}}>{p.activeScen.name}</span>}
                    </td>
                    <td style={{padding:'9px 10px'}}>
                      <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                        {teamResources.slice(0,5).map(r=>(
                          <div key={r.id} title={r.name} style={{width:24,height:24,borderRadius:'50%',background:OB.greenPale,display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontWeight:600,color:OB.greenDark,flexShrink:0}}>
                            {r.name.split(' ').map(n=>n[0]).slice(0,2).join('')}
                          </div>
                        ))}
                        {teamResources.length>5&&(
                          <div style={{width:24,height:24,borderRadius:'50%',background:OB.greyPale,display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontWeight:600,color:OB.grey}}>+{teamResources.length-5}</div>
                        )}
                        {teamResources.length===0&&<span style={{fontSize:11,color:OB.greyLight}}>—</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filteredProjects.length===0&&(
                <tr><td colSpan={7} style={{padding:'2rem',textAlign:'center',color:OB.grey,fontSize:13}}>No projects match the current filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {tip && (
        <div style={{position:'fixed',left:tip.x+14,top:tip.y+14,zIndex:1000,background:OB.greyDeep,color:OB.white,padding:'7px 10px',borderRadius:4,fontSize:11,lineHeight:1.4,pointerEvents:'none',boxShadow:'0 3px 12px rgba(0,0,0,0.28)',maxWidth:260}}>
          {tip.content}
        </div>
      )}
    </div>
  );
}

function CapacityView({data,allocationByResource,allocColor,allocTextColor,granularity,setGranularity,filterDiv,setFilterDiv,filterSkill,setFilterSkill,filterPm,setFilterPm,filteredResources,onAddAlloc,onSetPeriod,statusColor}) {
  const [view, setView] = useState('heatmap'); // 'heatmap' | 'availability'
  const [sortCol, setSortCol] = useState('skillGroup');
  const [sortDir, setSortDir] = useState('asc');
  const capAllocs = useMemo(()=>{ const ok=plannableProjectIds(data); return activeAllocations(data).filter(a=>ok.has(a.projectId)); }, [data]); // active plan, excluding completed/cancelled projects
  const { tipProps:cellTip, tipNode:cellTipNode } = useHoverTip();
  const [expanded, setExpanded] = useState({}); // resourceId -> true when drilled down
  const toggleExpand = id => setExpanded(e=>({...e,[id]:!e[id]}));

  // Shared date-range state for both Heat map and Availability — default to a
  // full year (current month through +11 months = exactly 12 columns).
  const now = new Date();
  const defaultFrom = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const _toIdx = now.getFullYear()*12 + now.getMonth() + 11;
  const defaultTo = `${Math.floor(_toIdx/12)}-${String(_toIdx%12+1).padStart(2,'0')}`;
  const [fromMonth, setFromMonth] = useState(defaultFrom);
  const [toMonth, setToMonth] = useState(defaultTo);
  const [showOnlyAvailable, setShowOnlyAvailable] = useState(false);

  // Visible period columns (months or weeks) + a per-period load map for the active plan.
  const periods = useMemo(()=>buildPeriods(fromMonth,toMonth,granularity),[fromMonth,toMonth,granularity]);
  const capMap = useMemo(()=>bucketByPeriod(capAllocs, periods),[capAllocs,periods]);

  const availStats = useMemo(()=>filteredResources
    .map(r=>{
      const periodData=periods.map(p=>{ const allocated=capMap[r.id]?.[p.key]||0; return {p,allocated,available:Math.max(0,100-allocated)}; });
      const avgAlloc=periods.length?Math.round(periodData.reduce((s,d)=>s+d.allocated,0)/periods.length):0;
      return {resource:r,periodData,avgAllocated:avgAlloc,avgAvailable:Math.max(0,100-avgAlloc)};
    })
    .filter(s=>!showOnlyAvailable||s.avgAvailable>0)
    .sort((a,b)=>{
      const av = sortCol==='name' ? a.resource.name : a.resource.skillGroup;
      const bv = sortCol==='name' ? b.resource.name : b.resource.skillGroup;
      let cmp = av.localeCompare(bv, undefined, {numeric:true, sensitivity:'base'});
      if (cmp===0) cmp = a.resource.name.localeCompare(b.resource.name, undefined, {numeric:true, sensitivity:'base'});
      return sortDir==='asc' ? cmp : -cmp;
    })
  ,[filteredResources,capMap,periods,showOnlyAvailable,sortCol,sortDir]);

  // Availability heat colours: more free = greener, fully booked = grey.
  const availBg = a => a===0?OB.greyPale : a>=100?OB.green : a>=75?OB.greenLight : a>=50?OB.greenPale : '#f9fde8';
  const availText = a => a===0?OB.greyLight : OB.greenDark;

  function toggleSort(col) {
    if (sortCol===col) setSortDir(d=>d==='asc'?'desc':'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }

  const sortedResources = useMemo(() => [...filteredResources].sort((a,b) => {
    const av = sortCol==='name' ? a.name : a.skillGroup;
    const bv = sortCol==='name' ? b.name : b.skillGroup;
    let cmp = av.localeCompare(bv, undefined, {numeric:true, sensitivity:'base'});
    if (cmp===0) cmp = a.name.localeCompare(b.name, undefined, {numeric:true, sensitivity:'base'});
    return sortDir==='asc' ? cmp : -cmp;
  }), [filteredResources, sortCol, sortDir]);

  function SortIcon({col}) {
    if (sortCol!==col) return <span style={{color:OB.greyPale,marginLeft:3}}>↕</span>;
    return <span style={{color:OB.green,marginLeft:3}}>{sortDir==='asc'?'↑':'↓'}</span>;
  }

  const thSortable = (sticky) => ({
    textAlign:'left', padding:'8px 12px', fontWeight:600, color:OB.grey,
    borderBottom:`1px solid #e8e8e8`, fontSize:10, textTransform:'uppercase',
    letterSpacing:'0.06em', cursor:'pointer', userSelect:'none', whiteSpace:'nowrap',
    background:OB.greyPale, position:'sticky', top:0, zIndex:2,
    ...(sticky ? {left:0,zIndex:3,minWidth:160} : {minWidth:80,padding:'8px 10px'}),
  });

  // Summary counts for availability strip
  const totalAvailable = availStats.filter(s=>s.avgAvailable>0).length;
  const totalFree      = availStats.filter(s=>s.avgAvailable===100).length;
  const totalPartial   = availStats.filter(s=>s.avgAvailable>0&&s.avgAvailable<100).length;

  return (
    <div>
      {/* Controls row */}
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:'1rem',flexWrap:'wrap'}}>
        {/* View toggle */}
        <div style={{display:'flex',borderRadius:3,overflow:'hidden',border:`1px solid ${OB.greyPale}`,flexShrink:0}}>
          {[['heatmap','Allocated'],['availability','Availability']].map(([key,label])=>(
            <button key={key} onClick={()=>setView(key)} style={{
              fontFamily:FONT,fontSize:12,padding:'5px 14px',cursor:'pointer',border:'none',
              background:view===key?OB.green:OB.white,
              color:view===key?OB.greyDeep:OB.grey,
              fontWeight:view===key?600:400,
            }}>{label}</button>
          ))}
        </div>

        {/* Date range — shared by both views */}
        <div style={{display:'flex',alignItems:'center',gap:6}}>
          <label style={{fontSize:12,color:OB.grey}}>From</label>
          {granularity==='week' ? <DayPicker value={fromMonth} onChange={setFromMonth}/> : <MonthPicker value={fromMonth} onChange={setFromMonth}/>}
        </div>
        <div style={{display:'flex',alignItems:'center',gap:6}}>
          <label style={{fontSize:12,color:OB.grey}}>To</label>
          {granularity==='week' ? <DayPicker value={toMonth} onChange={setToMonth}/> : <MonthPicker value={toMonth} onChange={setToMonth}/>}
        </div>
        <GranularityToggle value={granularity} onChange={setGranularity}/>
        {view==='availability' && (
          <label style={{display:'flex',alignItems:'center',gap:6,fontSize:12,color:OB.grey,cursor:'pointer'}}>
            <input type="checkbox" checked={showOnlyAvailable} onChange={e=>setShowOnlyAvailable(e.target.checked)}/>
            Available only
          </label>
        )}

      </div>

      {/* Division / skill multi-select filters */}
      <div style={{display:'flex',flexWrap:'wrap',gap:8,alignItems:'center',marginBottom:'1rem'}}>
        <MultiFilter options={[...new Set(data.resources.map(r=>r.division))].sort()} selected={filterDiv} onChange={setFilterDiv}/>
        <MultiSelect options={[...new Set(data.resources.map(r=>r.skillGroup))].sort()} selected={filterSkill} onChange={setFilterSkill} placeholder="All skills"/>
        {[...new Set(data.projects.map(p=>p.pm).filter(Boolean))].length>0&&<MultiSelect options={[...new Set(data.projects.map(p=>p.pm).filter(Boolean))].sort()} selected={filterPm} onChange={setFilterPm} placeholder="All owners"/>}
      </div>

      {/* ── HEAT MAP ── */}
      {view==='heatmap' && (
        <>
          <div style={{overflow:'auto',maxHeight:'70vh',border:`1px solid ${OB.greyPale}`,borderRadius:4}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12,fontFamily:FONT}}>
              <thead>
                <tr style={{background:OB.greyPale}}>
                  <th style={thSortable(true)} onClick={()=>toggleSort('name')}>Resource <SortIcon col="name"/></th>
                  {periods.map(p=>(
                    <th key={p.key} style={{textAlign:'center',padding:'8px 4px',fontWeight:600,color:OB.grey,borderBottom:`1px solid #e8e8e8`,minWidth:52,fontSize:10,textTransform:'uppercase',letterSpacing:'0.06em',background:OB.greyPale,position:'sticky',top:0,zIndex:1}}>
                      <div style={{whiteSpace:'nowrap'}}>{p.label}</div>
                      <div style={{fontSize:9,color:OB.greyLight,fontWeight:400}}>{p.sub}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedResources.map(r=>{
                  const isOpen = !!expanded[r.id];
                  let projRows = [];
                  if (isOpen) {
                    const byProjAllocs={};
                    capAllocs.filter(a=>a.resourceId===r.id).forEach(a=>{ (byProjAllocs[a.projectId]=byProjAllocs[a.projectId]||[]).push(a); });
                    projRows = Object.entries(byProjAllocs).map(([pid,pa])=>{
                      const proj=data.projects.find(p=>p.id===pid); const activeScenId=(proj?.scenarios||[]).find(s=>s.active)?.id||'';
                      const byKey={}; periods.forEach(p=>{ let s=0; pa.forEach(a=>{ if(p.start<=a.endDate&&p.end>=a.startDate) s+=a.allocationPct||0; }); if(s) byKey[p.key]=s; });
                      return {proj,byKey,activeScenId};
                    }).filter(x=>x.proj).sort((a,b)=>a.proj.name.localeCompare(b.proj.name));
                  }
                  return (
                    <Fragment key={r.id}>
                      <tr onClick={()=>toggleExpand(r.id)} title={isOpen?'Hide projects':'Show projects'} style={{borderBottom:`1px solid ${OB.greyPale}`,cursor:'pointer'}}>
                        <td style={{padding:'7px 12px',fontWeight:600,color:OB.greyDeep,position:'sticky',left:0,background:OB.white,zIndex:1,whiteSpace:'nowrap'}}>
                          <div style={{display:'flex',alignItems:'center',gap:6}}>
                            <span style={{color:OB.green,fontSize:10,fontWeight:700,width:9,flexShrink:0}}>{isOpen?'▾':'▸'}</span>
                            <div>
                              <div>{r.name}</div>
                              <div style={{fontSize:10,color:OB.grey,fontWeight:400}}>{r.skillGroup}{r.division?`, ${r.division}`:''}</div>
                            </div>
                          </div>
                        </td>
                        {periods.map(p=>{
                          const pct = capMap[r.id]?.[p.key]||0;
                          const bd = pct>0 ? allocBreakdown(capAllocs,data.projects,r.id,p) : null;
                          const tipContent = bd ? <div><div style={{fontWeight:700,marginBottom:3}}>{r.name} · {p.label} {p.sub} — {bd.total}%</div>{bd.rows.map(x=><div key={x.pid}>• {x.name}: {x.pct}%</div>)}</div> : null;
                          return (
                            <td key={p.key}
                              onClick={(e)=>{e.stopPropagation();onAddAlloc({resourceId:r.id,projectId:'',scenarioId:'',allocationPct:100,startDate:p.start,endDate:p.end});}}
                              {...(tipContent?cellTip(tipContent):{})}
                              style={{padding:3,textAlign:'center',cursor:'pointer'}}>
                              {pct>0&&<div style={{background:allocColor(pct),borderRadius:2,padding:'3px 2px',fontSize:11,fontWeight:600,color:allocTextColor(pct)}}>{pct}%</div>}
                              {pct===0&&<div style={{background:OB.greyPale,borderRadius:2,padding:'3px 2px',fontSize:11,color:OB.greyLight}}>free</div>}
                            </td>
                          );
                        })}
                      </tr>
                      {isOpen && (
                        <>
                          {/* Sub-rows share the outer table's columns, so periods always line up */}
                          <tr style={{background:OB.greyPale}}>
                            <td colSpan={1} style={{padding:'9px 12px 4px 30px',borderTop:`1px solid ${OB.greenLight}`,background:OB.greyPale,position:'sticky',left:0,zIndex:1}}>
                              <span style={{...sectionLabel,marginBottom:0}}>Allocations by project</span>
                            </td>
                            <td colSpan={periods.length} style={{borderTop:`1px solid ${OB.greenLight}`,background:OB.greyPale}}/>
                          </tr>
                          {projRows.length===0 && (
                            <tr style={{background:OB.greyPale}}>
                              <td colSpan={periods.length+1} style={{padding:'0 12px 10px 30px',fontSize:12,color:OB.greyLight,background:OB.greyPale}}>No active allocations for {r.name}.</td>
                            </tr>
                          )}
                          {projRows.map(({proj,byKey,activeScenId})=>(
                            <tr key={r.id+'-'+proj.id} style={{background:OB.greyPale,borderBottom:`1px solid ${OB.white}`}}>
                              <td colSpan={1} style={{padding:'4px 10px 4px 30px',background:OB.greyPale,position:'sticky',left:0,zIndex:1,whiteSpace:'nowrap'}}>
                                <div style={{display:'flex',alignItems:'center',gap:6}}>
                                  <div style={{width:3,height:16,borderRadius:2,background:statusColor(proj.status),flexShrink:0}}/>
                                  <span style={{fontSize:12,fontWeight:600,color:OB.greyDeep}}>{proj.name}</span>
                                </div>
                              </td>
                              {periods.map(p=><td key={p.key} style={{padding:3,textAlign:'center'}}><MonthCell pct={byKey[p.key]||0} allocColor={allocColor} allocTextColor={allocTextColor} onCommit={n=>onSetPeriod(proj.id, activeScenId, r.id, p, n)}/></td>)}
                            </tr>
                          ))}
                          {projRows.length>0 && (
                            <tr style={{background:OB.greyPale}}>
                              <td colSpan={1} style={{padding:'5px 10px 5px 30px',fontSize:10,fontWeight:600,color:OB.grey,textTransform:'uppercase',letterSpacing:'0.05em',background:OB.greyPale,position:'sticky',left:0,zIndex:1}}>Total</td>
                              {periods.map(p=>{ const t=capMap[r.id]?.[p.key]||0; return <td key={p.key} style={{padding:'5px 2px',textAlign:'center',fontSize:10,fontWeight:700,color:t>100?OB.cancelled:OB.greyDeep}}>{t?`${t}%`:''}</td>; })}
                            </tr>
                          )}
                          <tr style={{background:OB.greyPale,borderBottom:`1px solid ${OB.greyPale}`}}>
                            <td colSpan={periods.length+1} style={{padding:'6px 12px 12px 30px',background:OB.greyPale}}>
                              <button onClick={e=>{e.stopPropagation();onAddAlloc({resourceId:r.id,projectId:'',scenarioId:'',allocationPct:100,startDate:'',endDate:''});}} style={btnStyle(true)}>+ Assign project</button>
                            </td>
                          </tr>
                        </>
                      )}
                    </Fragment>
                  );
                })}
                {sortedResources.length===0&&<tr><td colSpan={periods.length+1} style={{padding:'2rem',textAlign:'center',color:OB.grey}}>No resources match the filter.</td></tr>}
              </tbody>
            </table>
          </div>
          <div style={{display:'flex',gap:16,marginTop:'1rem',flexWrap:'wrap',fontSize:11}}>
            {[['Free',OB.greyPale],['Partial',OB.greenLight],['100%',OB.green],['Over',OB.cancelled]].map(([label,bg])=>(
              <div key={label} style={{display:'flex',alignItems:'center',gap:6}}>
                <div style={{width:14,height:14,borderRadius:2,background:bg,border:`1px solid ${OB.greyPale}`}}/>
                <span style={{color:OB.grey,textTransform:'uppercase',letterSpacing:'0.04em'}}>{label}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── AVAILABILITY ── */}
      {view==='availability' && (
        <>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))',gap:8,marginBottom:'1.25rem'}}>
            {[['Available',totalAvailable,OB.greenDark],['Fully free',totalFree,OB.green],['Partially free',totalPartial,OB.onHold],['Fully booked',filteredResources.length-totalAvailable,OB.grey]].map(([label,val,col])=>(
              <div key={label} style={{background:OB.greyPale,borderRadius:4,padding:'12px 14px',borderLeft:`3px solid ${col}`}}>
                <div style={{fontSize:11,color:OB.grey,marginBottom:4,textTransform:'uppercase',letterSpacing:'0.06em',fontWeight:600}}>{label}</div>
                <div style={{fontSize:22,fontWeight:300,color:col}}>{val}</div>
              </div>
            ))}
          </div>
          <div style={{overflow:'auto',maxHeight:'70vh',border:`1px solid ${OB.greyPale}`,borderRadius:4}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12,fontFamily:FONT}}>
              <thead>
                <tr style={{background:OB.greyPale}}>
                  <th style={thSortable(true)} onClick={()=>toggleSort('name')}>Resource <SortIcon col="name"/></th>
                  {periods.map(p=>(
                      <th key={p.key} style={{textAlign:'center',padding:'8px 4px',fontWeight:600,color:OB.grey,borderBottom:`1px solid #e8e8e8`,minWidth:52,fontSize:10,textTransform:'uppercase',letterSpacing:'0.04em',background:OB.greyPale,position:'sticky',top:0,zIndex:1}}>
                        <div style={{whiteSpace:'nowrap'}}>{p.label}</div>
                        <div style={{fontSize:9,color:OB.greyLight,fontWeight:400}}>{p.sub}</div>
                      </th>
                  ))}
                  <th style={{textAlign:'center',padding:'8px 6px',fontWeight:600,color:OB.grey,borderBottom:`1px solid #e8e8e8`,minWidth:52,fontSize:10,textTransform:'uppercase',letterSpacing:'0.04em',background:OB.greyPale,position:'sticky',top:0,zIndex:1}}>Avg</th>
                </tr>
              </thead>
              <tbody>
                {availStats.map(({resource:r,periodData,avgAvailable})=>{
                  const isOpen=!!expanded[r.id];
                  let projRows=[];
                  if(isOpen){
                    const byProjAllocs={};
                    capAllocs.filter(a=>a.resourceId===r.id).forEach(a=>{ (byProjAllocs[a.projectId]=byProjAllocs[a.projectId]||[]).push(a); });
                    projRows=Object.entries(byProjAllocs).map(([pid,pa])=>{
                      const proj=data.projects.find(p=>p.id===pid); const activeScenId=(proj?.scenarios||[]).find(s=>s.active)?.id||'';
                      const byKey={}; periods.forEach(p=>{ let s=0; pa.forEach(a=>{ if(p.start<=a.endDate&&p.end>=a.startDate) s+=a.allocationPct||0; }); if(s) byKey[p.key]=s; });
                      return {proj,byKey,activeScenId};
                    }).filter(x=>x.proj).sort((a,b)=>a.proj.name.localeCompare(b.proj.name));
                  }
                  return (
                  <Fragment key={r.id}>
                    <tr onClick={()=>toggleExpand(r.id)} title={isOpen?'Hide projects':'Show projects'} style={{borderBottom:`1px solid ${OB.greyPale}`,cursor:'pointer'}}>
                      <td style={{padding:'7px 12px',fontWeight:600,color:OB.greyDeep,position:'sticky',left:0,background:OB.white,zIndex:1,whiteSpace:'nowrap'}}>
                        <div style={{display:'flex',alignItems:'center',gap:6}}>
                          <span style={{color:OB.green,fontSize:10,fontWeight:700,width:9,flexShrink:0}}>{isOpen?'▾':'▸'}</span>
                          <div>
                            <div>{r.name}</div>
                            <div style={{fontSize:10,color:OB.grey,fontWeight:400}}>{r.skillGroup}{r.division?`, ${r.division}`:''}</div>
                          </div>
                        </div>
                      </td>
                      {periodData.map(({p,available})=>(
                        <td key={p.key} style={{padding:3,textAlign:'center'}}>
                          <div style={{background:availBg(available),borderRadius:2,padding:'3px 2px',fontSize:11,fontWeight:600,color:availText(available)}}>{available===0?'Full':`${available}%`}</div>
                        </td>
                      ))}
                      <td style={{padding:3,textAlign:'center',fontWeight:600,color:avgAvailable===0?OB.greyLight:OB.greenDark}}>{avgAvailable}%</td>
                    </tr>
                    {isOpen && (
                      <>
                        <tr style={{background:OB.greyPale}}>
                          <td colSpan={1} style={{padding:'9px 12px 4px 30px',borderTop:`1px solid ${OB.greenLight}`,background:OB.greyPale,position:'sticky',left:0,zIndex:1}}>
                            <span style={{...sectionLabel,marginBottom:0}}>Allocations by project</span>
                          </td>
                          <td colSpan={periods.length+1} style={{borderTop:`1px solid ${OB.greenLight}`,background:OB.greyPale}}/>
                        </tr>
                        {projRows.length===0 && (
                          <tr style={{background:OB.greyPale}}>
                            <td colSpan={periods.length+2} style={{padding:'0 12px 10px 30px',fontSize:12,color:OB.greyLight,background:OB.greyPale}}>No active allocations for {r.name}.</td>
                          </tr>
                        )}
                        {projRows.map(({proj,byKey,activeScenId})=>(
                          <tr key={r.id+'-'+proj.id} style={{background:OB.greyPale,borderBottom:`1px solid ${OB.white}`}}>
                            <td colSpan={1} style={{padding:'4px 10px 4px 30px',background:OB.greyPale,position:'sticky',left:0,zIndex:1,whiteSpace:'nowrap'}}>
                              <div style={{display:'flex',alignItems:'center',gap:6}}>
                                <div style={{width:3,height:16,borderRadius:2,background:statusColor(proj.status),flexShrink:0}}/>
                                <span style={{fontSize:12,fontWeight:600,color:OB.greyDeep}}>{proj.name}</span>
                              </div>
                            </td>
                            {periods.map(p=><td key={p.key} style={{padding:3,textAlign:'center'}}><MonthCell pct={byKey[p.key]||0} allocColor={allocColor} allocTextColor={allocTextColor} onCommit={n=>onSetPeriod(proj.id, activeScenId, r.id, p, n)}/></td>)}
                            <td style={{background:OB.greyPale}}/>
                          </tr>
                        ))}
                        {projRows.length>0 && (
                          <tr style={{background:OB.greyPale}}>
                            <td colSpan={1} style={{padding:'5px 10px 5px 30px',fontSize:10,fontWeight:600,color:OB.grey,textTransform:'uppercase',letterSpacing:'0.05em',background:OB.greyPale,position:'sticky',left:0,zIndex:1}}>Total</td>
                            {periods.map(p=>{ const t=capMap[r.id]?.[p.key]||0; return <td key={p.key} style={{padding:'5px 2px',textAlign:'center',fontSize:10,fontWeight:700,color:t>100?OB.cancelled:OB.greyDeep}}>{t?`${t}%`:''}</td>; })}
                            <td style={{background:OB.greyPale}}/>
                          </tr>
                        )}
                        <tr style={{background:OB.greyPale,borderBottom:`1px solid ${OB.greyPale}`}}>
                          <td colSpan={periods.length+2} style={{padding:'6px 12px 12px 30px',background:OB.greyPale}}>
                            <button onClick={e=>{e.stopPropagation();onAddAlloc({resourceId:r.id,projectId:'',scenarioId:'',allocationPct:100,startDate:'',endDate:''});}} style={btnStyle(true)}>+ Assign project</button>
                          </td>
                        </tr>
                      </>
                    )}
                  </Fragment>
                  );
                })}
                {availStats.length===0&&<tr><td colSpan={periods.length+2} style={{padding:'2.5rem',textAlign:'center',color:OB.grey,fontSize:13}}>No resources match the current filters.</td></tr>}
              </tbody>
            </table>
          </div>
          <div style={{display:'flex',gap:16,marginTop:'1rem',flexWrap:'wrap',fontSize:11}}>
            {[['Fully free',OB.green],['Partly free',OB.greenPale],['Fully booked',OB.greyPale]].map(([label,bg])=>(
              <div key={label} style={{display:'flex',alignItems:'center',gap:6}}>
                <div style={{width:14,height:14,borderRadius:2,background:bg,border:`1px solid ${OB.greyPale}`}}/>
                <span style={{color:OB.grey,textTransform:'uppercase',letterSpacing:'0.04em'}}>{label}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {cellTipNode}
    </div>
  );
}

function TeamFinderView({data, allocationByResource, onAllocateTeam}) {
  const [mode, setMode] = useState('dates');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [durationMonths, setDurationMonths] = useState(3);
  const [minAvailPct, setMinAvailPct] = useState(50);
  const [requirements, setRequirements] = useState([{id:1,skillGroup:SKILL_GROUPS[0],division:'Any',count:1}]);
  const [results, setResults] = useState(null);
  // Allocation-from-results state
  const [allocProjectId, setAllocProjectId] = useState('');
  const [allocScenarioId, setAllocScenarioId] = useState('');
  const [allocPct, setAllocPct] = useState(100);
  const [allocMsg, setAllocMsg] = useState('');
  const [allocating, setAllocating] = useState(false);

  function addReq(){setRequirements(r=>[...r,{id:Date.now(),skillGroup:SKILL_GROUPS[0],division:'Any',count:1}]);}
  function updateReq(id,field,val){setRequirements(r=>r.map(req=>req.id===id?{...req,[field]:val}:req));}
  function removeReq(id){setRequirements(r=>r.filter(req=>req.id!==id));}

  // The people that would actually be booked: the top `needed` candidates per role.
  const selectedTeam = useMemo(()=>{
    const ids = new Set();
    (results?.teamSlots||[]).forEach(({candidates,needed})=>candidates.slice(0,needed).forEach(c=>ids.add(c.resource.id)));
    return [...ids];
  },[results]);

  const allocProject = data.projects.find(p=>p.id===allocProjectId);
  const allocScenarios = allocProject?.scenarios||[];

  async function allocateTeam() {
    if (!allocProjectId || !selectedTeam.length || !results) return;
    const start = results.startDate.length===7 ? results.startDate+'-01' : results.startDate;
    const end   = results.endDate.length===7   ? monthEnd(results.endDate) : results.endDate;
    const allocs = selectedTeam.map(rid=>({
      resourceId:rid, projectId:allocProjectId, scenarioId:allocScenarioId||undefined,
      allocationPct:allocPct, startDate:start, endDate:end,
    }));
    setAllocating(true);
    const saved = await onAllocateTeam(allocs);
    setAllocating(false);
    if (saved>0) setAllocMsg(`Allocated ${saved} ${saved===1?'person':'people'} to ${allocProject?.name} at ${allocPct}% (${start} → ${end}).`);
  }

  function getCandidates(months, req) {
    return data.resources
      .filter(r=>r.skillGroup===req.skillGroup&&r.status==='Active'&&(!req.division||req.division==='Any'||r.division===req.division))
      .map(r=>{
        const avgAlloc=months.length?Math.round(months.reduce((s,m)=>s+(allocationByResource[r.id]?.[m]||0),0)/months.length):0;
        return {resource:r,avgAlloc,avgAvailable:Math.max(0,100-avgAlloc),monthData:months.map(m=>({month:m,alloc:allocationByResource[r.id]?.[m]||0,avail:Math.max(0,100-(allocationByResource[r.id]?.[m]||0))}))};
      })
      .filter(c=>c.avgAvailable>=minAvailPct)
      .sort((a,b)=>b.avgAvailable-a.avgAvailable);
  }

  function findTeam() {
    setAllocMsg('');
    if (mode==='dates') {
      if (!startDate||!endDate) return;
      const months = monthsInRange(startDate, endDate);
      const teamSlots = requirements.map(req=>({req,candidates:getCandidates(months,req),needed:req.count}));
      setResults({mode:'dates',startDate,endDate,teamSlots,canForm:teamSlots.every(s=>s.candidates.length>=s.needed)});
    } else {
      const today = new Date();
      let testStart = new Date(today.getFullYear(), today.getMonth(), 1);
      let found = null;
      for (let i=0;i<36;i++) {
        const sd = `${testStart.getFullYear()}-${String(testStart.getMonth()+1).padStart(2,'0')}-01`;
        const ed = addMonths(sd, durationMonths-1).slice(0,7)+'-28';
        const months = monthsInRange(sd, ed);
        const teamSlots = requirements.map(req=>({req,candidates:getCandidates(months,req),needed:req.count}));
        if (teamSlots.every(s=>s.candidates.length>=s.needed)) {
          found = {mode:'duration',startDate:sd.slice(0,7),endDate:addMonths(sd,durationMonths-1).slice(0,7),durationMonths,teamSlots,canForm:true};
          break;
        }
        testStart.setMonth(testStart.getMonth()+1);
      }
      setResults(found||{mode:'duration',canForm:false,teamSlots:[],durationMonths});
    }
  }


  return (
    <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) minmax(0,1fr)',gap:16}}>
      <div style={card}>
        <span style={sectionLabel}>Mode</span>
        <div style={{display:'flex',gap:8,marginBottom:'1.25rem'}}>
          {[['dates','Fixed dates'],['duration','Find earliest start']].map(([key,label])=>(
            <button key={key} onClick={()=>{setMode(key);setResults(null);}} style={{...btnStyle(mode===key),flex:1,textAlign:'center'}}>{label}</button>
          ))}
        </div>

        {mode==='dates'?(
          <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) minmax(0,1fr)',gap:10,marginBottom:'1rem'}}>
            <div><span style={sectionLabel}>Start date</span><DayPicker block value={startDate} onChange={setStartDate}/></div>
            <div><span style={sectionLabel}>End date</span><DayPicker block value={endDate} onChange={setEndDate}/></div>
          </div>
        ):(
          <div style={{marginBottom:'1rem'}}>
            <span style={sectionLabel}>Duration: {durationMonths} month{durationMonths!==1?'s':''}</span>
            <input type="range" min="1" max="24" step="1" value={durationMonths} onChange={e=>setDurationMonths(Number(e.target.value))} style={{width:'100%',accentColor:OB.green}}/>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:OB.greyLight,marginTop:2}}><span>1</span><span>12</span><span>24 months</span></div>
          </div>
        )}

        <div style={{marginBottom:'1rem'}}>
          <span style={sectionLabel}>Min availability: {minAvailPct}%</span>
          <input type="range" min="10" max="100" step="10" value={minAvailPct} onChange={e=>setMinAvailPct(Number(e.target.value))} style={{width:'100%',accentColor:OB.green}}/>
        </div>

        <span style={sectionLabel}>Team requirements</span>
        {requirements.map(req=>(
          <div key={req.id} style={{display:'flex',gap:6,alignItems:'center',marginBottom:8}}>
            <select value={req.skillGroup} onChange={e=>updateReq(req.id,'skillGroup',e.target.value)} style={{...ctrl,flex:2,minWidth:0}}>
              {SKILL_GROUPS.map(s=><option key={s}>{s}</option>)}
            </select>
            <select value={req.division||'Any'} onChange={e=>updateReq(req.id,'division',e.target.value)} style={{...ctrl,flex:2,minWidth:0}}>
              <option value="Any">Any division</option>
              {DIVISIONS.map(d=><option key={d}>{d}</option>)}
            </select>
            <span style={{fontSize:11,color:OB.grey}}>×</span>
            <input type="number" min="1" max="10" value={req.count} onChange={e=>updateReq(req.id,'count',Number(e.target.value))} style={{...ctrl,width:44,textAlign:'center',flexShrink:0}}/>
            <button onClick={()=>removeReq(req.id)} title="Remove role" style={{background:'none',border:'none',color:OB.cancelled,cursor:'pointer',fontSize:18,padding:'0 2px',lineHeight:1,flexShrink:0}}>×</button>
          </div>
        ))}
        <button onClick={addReq} style={{...btnStyle(false),width:'100%',marginTop:4,textAlign:'center'}}>+ Add role</button>
        <button onClick={findTeam} style={{...btnStyle(true),width:'100%',marginTop:10,textAlign:'center',padding:'9px 14px',fontSize:13}}>
          {mode==='dates'?'Find available team':'Find earliest start'}
        </button>
      </div>

      <div style={card}>
        <span style={sectionLabel}>Results</span>
        {!results&&<div style={{color:OB.greyLight,fontSize:13,paddingTop:8}}>Configure your requirements and run a search to see who is available.</div>}
        {results&&(
          <div>
            {results.canForm&&results.mode==='duration'&&(
              <div style={{background:OB.greenPale,borderRadius:4,padding:'10px 14px',marginBottom:14,borderLeft:`3px solid ${OB.green}`}}>
                <div style={{fontSize:13,fontWeight:600,color:OB.greenDark}}>Earliest start: {fmtMonth(results.startDate)}</div>
                <div style={{fontSize:11,color:OB.greenDark,marginTop:3}}>Team available for {results.durationMonths} months through {fmtMonth(results.endDate)}</div>
              </div>
            )}
            {results.canForm&&results.mode==='dates'&&(
              <div style={{background:OB.greenPale,borderRadius:4,padding:'10px 14px',marginBottom:14,borderLeft:`3px solid ${OB.green}`}}>
                <div style={{fontSize:13,fontWeight:600,color:OB.greenDark}}>Team can be formed</div>
                <div style={{fontSize:11,color:OB.greenDark,marginTop:3}}>{results.startDate} — {results.endDate}</div>
              </div>
            )}
            {!results.canForm&&(
              <div style={{background:'#fdf0ef',borderRadius:4,padding:'10px 14px',marginBottom:14,borderLeft:`3px solid ${OB.cancelled}`}}>
                <div style={{fontSize:13,fontWeight:600,color:OB.cancelled}}>{results.mode==='duration'?'Cannot form team within 36 months':'Cannot form full team for this period'}</div>
                <div style={{fontSize:11,color:OB.cancelled,marginTop:3}}>Some roles lack available resources at {minAvailPct}%+.</div>
              </div>
            )}

            {/* Allocate the selected team to a project */}
            {selectedTeam.length>0 && (
              <div style={{background:OB.greyPale,borderRadius:4,padding:'12px 14px',marginBottom:16}}>
                <span style={sectionLabel}>Allocate this team ({selectedTeam.length} {selectedTeam.length===1?'person':'people'})</span>
                <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
                  <select value={allocProjectId} onChange={e=>{setAllocProjectId(e.target.value);setAllocScenarioId('');setAllocMsg('');}} style={{...ctrl,flex:'1 1 160px',minWidth:0,background:OB.white}}>
                    <option value="">Select project...</option>
                    {[...data.projects].sort((a,b)=>a.name.localeCompare(b.name)).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  {allocScenarios.length>0 && (
                    <select value={allocScenarioId} onChange={e=>setAllocScenarioId(e.target.value)} style={{...ctrl,flex:'1 1 120px',minWidth:0,background:OB.white}}>
                      <option value="">No scenario</option>
                      {allocScenarios.map(s=><option key={s.id} value={s.id}>{s.name}{s.active?' (active)':''}</option>)}
                    </select>
                  )}
                  <div style={{display:'flex',alignItems:'center',gap:4}}>
                    <input type="number" min="5" max="100" step="5" value={allocPct} onChange={e=>setAllocPct(Math.max(5,Math.min(100,Number(e.target.value)||0)))} style={{...ctrl,width:52,textAlign:'center',background:OB.white}}/>
                    <span style={{fontSize:11,color:OB.grey}}>%</span>
                  </div>
                  <button onClick={allocateTeam} disabled={!allocProjectId||allocating} style={{...btnStyle(true),opacity:(!allocProjectId||allocating)?0.4:1}}>
                    {allocating?'Allocating…':'Allocate'}
                  </button>
                </div>
                {allocMsg && <div style={{fontSize:11,color:OB.greenDark,fontWeight:600,marginTop:8}}>{allocMsg}</div>}
              </div>
            )}

            {(results.teamSlots||[]).map(({req,candidates,needed})=>(
              <div key={req.id} style={{marginBottom:16}}>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6,flexWrap:'wrap'}}>
                  <span style={{fontSize:12,fontWeight:600,color:OB.greyDeep}}>{req.skillGroup}</span>
                  {req.division&&req.division!=='Any'&&(
                    <span style={{fontSize:10,padding:'2px 7px',borderRadius:2,background:OB.greyPale,color:OB.greyDark,fontWeight:600}}>{req.division}</span>
                  )}
                  <span style={{fontSize:10,padding:'2px 7px',borderRadius:2,background:candidates.length>=needed?OB.greenPale:'#fdf0ef',color:candidates.length>=needed?OB.greenDark:OB.cancelled,fontWeight:600}}>
                    {candidates.length}/{needed} found
                  </span>
                </div>
                {candidates.slice(0,needed+2).map((c,i)=>(
                  <div key={c.resource.id} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 10px',borderRadius:3,background:i<needed?OB.greenPale:OB.greyPale,marginBottom:4,border:`1px solid ${i<needed?OB.greenLight:OB.greyPale}`}}>
                    <div style={{width:24,height:24,borderRadius:'50%',background:i<needed?OB.greenLight:OB.white,display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:600,color:OB.greenDark,flexShrink:0}}>
                      {c.resource.name.split(' ').map(n=>n[0]).slice(0,2).join('')}
                    </div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,fontWeight:i<needed?600:400,color:i<needed?OB.greyDeep:OB.grey,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{c.resource.name}</div>
                      <div style={{fontSize:10,color:OB.grey}}>{c.resource.division}</div>
                    </div>
                    <div style={{fontSize:12,fontWeight:600,color:OB.greenDark}}>{c.avgAvailable}% free</div>
                    {i<needed&&<span style={{fontSize:10,background:OB.green,color:OB.greyDeep,padding:'1px 6px',borderRadius:2,fontWeight:600}}>SELECTED</span>}
                  </div>
                ))}
                {candidates.length===0&&<div style={{fontSize:12,color:OB.cancelled,padding:'4px 0'}}>No available resources for this skill{req.division&&req.division!=='Any'?` in ${req.division}`:''}.</div>}
              </div>
            ))}
            {/* All resources ranked by availability for the window */}
            {results.startDate && (
              <div style={{marginTop:8,paddingTop:12,borderTop:`1px solid ${OB.greyPale}`}}>
                <span style={sectionLabel}>All resources — ranked by availability</span>
                {data.resources
                  .filter(r=>r.status==='Active')
                  .map(r=>{
                    const months = monthsInRange(
                      results.startDate.length===7 ? results.startDate+'-01' : results.startDate,
                      results.endDate.length===7   ? results.endDate+'-28'   : results.endDate
                    );
                    const avgAlloc = months.length ? Math.round(months.reduce((s,m)=>s+(allocationByResource[r.id]?.[m]||0),0)/months.length) : 0;
                    const avail = Math.max(0,100-avgAlloc);
                    return {resource:r, avail};
                  })
                  .sort((a,b)=>b.avail-a.avail)
                  .map(({resource:r, avail})=>{
                    const barColor = avail===0?OB.greyPale:avail===100?OB.green:OB.greenLight;
                    return (
                      <div key={r.id} style={{display:'flex',alignItems:'center',gap:8,marginBottom:5}}>
                        <div style={{width:24,height:24,borderRadius:'50%',background:avail>0?OB.greenPale:OB.greyPale,display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontWeight:600,color:avail>0?OB.greenDark:OB.grey,flexShrink:0}}>
                          {r.name.split(' ').map(n=>n[0]).slice(0,2).join('')}
                        </div>
                        <div style={{fontSize:12,color:OB.greyDark,minWidth:90,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{r.name}</div>
                        <div style={{flex:1,background:OB.greyPale,borderRadius:2,height:5}}>
                          <div style={{width:`${avail}%`,background:barColor,borderRadius:2,height:5}}/>
                        </div>
                        <span style={{fontSize:11,fontWeight:600,color:avail>0?OB.greenDark:OB.greyLight,minWidth:34,textAlign:'right'}}>{avail>0?`${avail}%`:'Full'}</span>
                      </div>
                    );
                  })
                }
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ResourcesTab({data,onEdit,onDelete,onAdd,onSetMonth,statusColor,statusBg,allocColor,allocTextColor,simple,hideStatus,hideEdit,hideAdd}) {
  const [search, setSearch] = useState('');
  const [skillFilter, setSkillFilter] = useState([]);
  const [divFilter, setDivFilter] = useState([]);
  const [statusFilter, setStatusFilter] = useState(['Active']);
  const [sortCol, setSortCol] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [expanded, setExpanded] = useState(null);

  function toggleSort(col) {
    if (sortCol===col) setSortDir(d=>d==='asc'?'desc':'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }

  // Current month for live allocation %
  const now = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}`;
  const todayStr = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-${String(new Date().getDate()).padStart(2,'0')}`;
  const activeAllocs = activeAllocations(data);
  const allocMap = buildAllocationMap(activeAllocs, data.resources);

  const rows = useMemo(() => {
    return data.resources
      .filter(r => {
        const q = search.toLowerCase();
        const matchSearch = !q || r.name.toLowerCase().includes(q) || r.skillGroup.toLowerCase().includes(q) || r.division.toLowerCase().includes(q);
        return matchSearch
          && (skillFilter.length===0 || skillFilter.includes(r.skillGroup))
          && (divFilter.length===0 || divFilter.includes(r.division))
          && (statusFilter.length===0 || statusFilter.includes(r.status));
      })
      .map(r => {
        const myAllocs = data.allocations.filter(a=>a.resourceId===r.id);
        const currentPct = allocMap[r.id]?.[now] || 0;
        // Active-scenario allocations, laid out as a project x month table for the drawer.
        const myActive = activeAllocs.filter(a=>a.resourceId===r.id);
        let resMonths=[];
        if (myActive.length){
          const starts=myActive.map(a=>a.startDate).filter(Boolean).sort();
          const ends=myActive.map(a=>a.endDate).filter(Boolean).sort();
          if (starts.length&&ends.length) resMonths=monthsInRange(starts[0],ends[ends.length-1]);
        }
        const projectRows=[...new Set(myActive.map(a=>a.projectId))].map(pid=>{
          const proj=data.projects.find(p=>p.id===pid);
          const activeScenId=(proj?.scenarios||[]).find(s=>s.active)?.id||'';
          const byMonth={};
          myActive.filter(a=>a.projectId===pid).forEach(a=>{ monthsInRange(a.startDate,a.endDate).forEach(m=>{ byMonth[m]=(byMonth[m]||0)+(a.allocationPct||0); }); });
          return {proj, activeScenId, byMonth};
        }).filter(x=>x.proj).sort((a,b)=>a.proj.name.localeCompare(b.proj.name));
        const totalByMonth={};
        resMonths.forEach(m=>{ totalByMonth[m]=allocMap[r.id]?.[m]||0; });
        return {...r, myAllocs, allocCount: myAllocs.length, currentPct, resMonths, projectRows, totalByMonth};
      })
      .sort((a,b) => {
        let av, bv;
        if (sortCol==='allocCount') { av=a.allocCount; bv=b.allocCount; }
        else if (sortCol==='currentPct') { av=a.currentPct; bv=b.currentPct; }
        else { av=a[sortCol]||''; bv=b[sortCol]||''; }
        const cmp = typeof av==='number' ? av-bv : av.localeCompare(bv, undefined, {numeric:true, sensitivity:'base'});
        return sortDir==='asc' ? cmp : -cmp;
      });
  }, [data.resources, data.allocations, search, skillFilter, divFilter, statusFilter, sortCol, sortDir, allocMap, now]);


  function SortIcon({col}) {
    if (sortCol!==col) return <span style={{color:OB.greyPale,marginLeft:3}}>↕</span>;
    return <span style={{color:OB.green,marginLeft:3}}>{sortDir==='asc'?'↑':'↓'}</span>;
  }

  const thBase = {textAlign:'left',padding:'8px 12px',fontWeight:600,color:OB.grey,fontSize:10,textTransform:'uppercase',letterSpacing:'0.06em',borderBottom:`2px solid ${OB.greyPale}`,background:OB.greyPale,cursor:'pointer',whiteSpace:'nowrap',userSelect:'none'};

  // Derive unique divisions for filter
  const divisions = [...new Set(data.resources.map(r=>r.division))].sort();

  const showStatus = !hideStatus;
  const showThisMonth = !simple;
  const showAllocations = !simple;
  const showExpand = !simple;
  const showEdit = !hideEdit;
  const colCount = 3 + (showStatus?1:0) + (showThisMonth?1:0) + (showAllocations?1:0) + 1;

  return (
    <div>
      {/* Summary strip */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))',gap:8,marginBottom:'1.25rem'}}>
        {[
          ['Total',data.resources.length,OB.greyDeep],
          ['Active',data.resources.filter(r=>r.status==='Active').length,OB.greenDark],
          ...(simple ? [] : [
            ['Allocated now',data.resources.filter(r=>(allocMap[r.id]?.[now]||0)>=100).length,OB.onHold],
            ['Available now',data.resources.filter(r=>(allocMap[r.id]?.[now]||0)<100&&r.status==='Active').length,OB.green],
          ]),
        ].map(([label,val,col])=>(
          <div key={label} style={{background:OB.greyPale,borderRadius:4,padding:'10px 14px',borderLeft:`3px solid ${col}`,cursor:'pointer'}}
            onClick={()=>{ if(label==='Active') setStatusFilter(['Active']); else if(label==='Total') setStatusFilter([]); }}>
            <div style={{fontSize:10,color:OB.grey,marginBottom:4,textTransform:'uppercase',letterSpacing:'0.06em',fontWeight:600}}>{label}</div>
            <div style={{fontSize:22,fontWeight:300,color:col,lineHeight:1}}>{val}</div>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:'1rem',flexWrap:'wrap'}}>
        <input placeholder="Search name, role, division..." value={search} onChange={e=>setSearch(e.target.value)} style={{...ctrl,flex:'1 1 160px',minWidth:140,padding:'6px 10px'}}/>
        <span style={{fontSize:11,color:OB.grey,flexShrink:0}}>{rows.length} of {data.resources.length}</span>
        <div style={{flex:1}}/>
        {!hideAdd && <button onClick={onAdd} style={btnStyle(true)}>+ Add resource</button>}
      </div>
      <div style={{display:'flex',flexWrap:'wrap',gap:8,alignItems:'center',marginBottom:'1rem'}}>
        <MultiFilter options={divisions} selected={divFilter} onChange={setDivFilter}/>
        <MultiSelect options={[...new Set(data.resources.map(r=>r.skillGroup))].sort()} selected={skillFilter} onChange={setSkillFilter} placeholder="All skills"/>
        <MultiSelect options={['Active','Inactive']} selected={statusFilter} onChange={setStatusFilter} placeholder="All statuses"/>
      </div>

      {/* Table */}
      <div style={{borderRadius:4,border:`1px solid ${OB.greyPale}`,overflow:'hidden'}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:12,fontFamily:FONT}}>
          <thead>
            <tr>
              <th style={thBase} onClick={()=>toggleSort('name')}>Name <SortIcon col="name"/></th>
              <th style={thBase} onClick={()=>toggleSort('skillGroup')}>Role <SortIcon col="skillGroup"/></th>
              <th style={thBase} onClick={()=>toggleSort('division')}>Division <SortIcon col="division"/></th>
              {showStatus && <th style={thBase} onClick={()=>toggleSort('status')}>Status <SortIcon col="status"/></th>}
              {showThisMonth && <th style={{...thBase,minWidth:140}} onClick={()=>toggleSort('currentPct')}>This month <SortIcon col="currentPct"/></th>}
              {showAllocations && <th style={thBase} onClick={()=>toggleSort('allocCount')}>Allocations <SortIcon col="allocCount"/></th>}
              <th style={{...thBase,cursor:'default'}}/>
            </tr>
          </thead>
          <tbody>
            {rows.map((r,i) => {
              const isOpen = expanded===r.id;
              const pct = r.currentPct;
              const barColor = pct>100?OB.cancelled:pct===100?OB.green:pct>0?OB.greenLight:OB.greyPale;
              const pctColor = pct>100?OB.cancelled:pct>=100?OB.greenDark:pct>0?OB.greenDark:OB.greyLight;
              return (
                <Fragment key={r.id}>
                  <tr
                    onClick={simple?undefined:()=>setExpanded(isOpen?null:r.id)}
                    style={{borderBottom:isOpen?'none':`1px solid ${OB.greyPale}`,background:isOpen?OB.greenPale:i%2===0?OB.white:'#fafafa',cursor:simple?'default':'pointer'}}
                  >
                    {/* Name + avatar */}
                    <td style={{padding:'5px 12px',whiteSpace:'nowrap'}}>
                      <div style={{display:'flex',alignItems:'center',gap:8}}>
                        <div style={{width:20,height:20,borderRadius:'50%',background:r.status==='Active'?OB.greenPale:OB.greyPale,display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontWeight:600,color:r.status==='Active'?OB.greenDark:OB.grey,flexShrink:0}}>
                          {r.name.split(' ').map(n=>n[0]).slice(0,2).join('')}
                        </div>
                        <span style={{fontSize:13,fontWeight:600,color:OB.greyDeep}}>{r.name}</span>
                        {r.startDate&&r.startDate>todayStr&&<span style={{fontSize:9,padding:'1px 6px',borderRadius:2,background:'#e8f3f7',color:OB.opportunity,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.04em'}}>Starts {r.startDate}</span>}
                        {r.endDate&&r.endDate<todayStr&&<span style={{fontSize:9,padding:'1px 6px',borderRadius:2,background:OB.greyPale,color:OB.grey,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.04em'}}>Left {r.endDate}</span>}
                        {r.endDate&&r.endDate>=todayStr&&<span style={{fontSize:9,padding:'1px 6px',borderRadius:2,background:'#fef3e2',color:OB.onHold,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.04em'}}>Leaves {r.endDate}</span>}
                      </div>
                    </td>
                    {/* Role */}
                    <td style={{padding:'5px 12px',color:OB.greyDark,whiteSpace:'nowrap'}}>{r.skillGroup}</td>
                    {/* Division */}
                    <td style={{padding:'5px 12px',color:OB.grey,whiteSpace:'nowrap'}}>{r.division}</td>
                    {/* Status */}
                    {showStatus && (
                    <td style={{padding:'5px 12px'}}>
                      <span style={{fontSize:10,padding:'2px 8px',borderRadius:2,background:r.status==='Active'?OB.greenPale:OB.greyPale,color:r.status==='Active'?OB.greenDark:OB.grey,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.05em'}}>{r.status}</span>
                    </td>)}
                    {!simple && <>
                    {/* This month bar */}
                    <td style={{padding:'5px 12px'}}>
                      <div style={{display:'flex',alignItems:'center',gap:7}}>
                        <div style={{flex:1,background:OB.greyPale,borderRadius:2,height:5,minWidth:60}}>
                          <div style={{width:`${Math.min(pct,100)}%`,background:barColor,borderRadius:2,height:5}}/>
                        </div>
                        <span style={{fontSize:11,fontWeight:600,color:pctColor,minWidth:34,textAlign:'right'}}>{pct>0?`${pct}%`:'free'}</span>
                      </div>
                    </td>
                    {/* Allocation count */}
                    <td style={{padding:'5px 12px'}}>
                      <span style={{fontSize:12,fontWeight:600,color:r.allocCount>0?OB.greyDeep:OB.greyLight}}>{r.allocCount>0?r.allocCount:'—'}</span>
                    </td>
                    </>}
                    {/* Actions */}
                    <td style={{padding:'5px 12px',whiteSpace:'nowrap',textAlign:'right'}}>
                      {showExpand && <span style={{color:OB.green,fontSize:11,fontWeight:600,marginRight:8}}>{isOpen?'▲':'▼'}</span>}
                      {showEdit && <><button onClick={e=>{e.stopPropagation();onEdit(r);}} style={{background:'none',border:'none',cursor:'pointer',color:OB.grey,fontSize:12,padding:'2px 5px',fontFamily:FONT}}>Edit</button>
                      <button onClick={e=>{e.stopPropagation();onDelete(r.id);}} style={{background:'none',border:'none',cursor:'pointer',color:OB.cancelled,fontSize:12,padding:'2px 5px',fontFamily:FONT}}>Remove</button></>}
                    </td>
                  </tr>

                  {/* Drawer */}
                  {showExpand && isOpen&&(
                    <tr key={r.id+'-drawer'}>
                      <td colSpan={colCount} style={{padding:0,borderBottom:`1px solid ${OB.greyPale}`}}>
                        <div style={{background:OB.greyPale,padding:'12px 14px 14px',borderTop:`1px solid ${OB.greenLight}`}}>
                          <span style={sectionLabel}>Allocations by project — {r.dailyHours}h/day{r.startDate?` · joined ${r.startDate}`:''}{r.endDate?` · leaves ${r.endDate}`:''}</span>
                          {r.projectRows.length===0&&<div style={{fontSize:12,color:OB.greyLight}}>No active allocations yet.</div>}
                          {r.projectRows.length>0&&(
                            <div style={{overflowX:'auto',background:OB.white,border:`1px solid ${OB.greyPale}`,borderRadius:3}}>
                              <table style={{borderCollapse:'collapse',fontSize:11,fontFamily:FONT,width:'100%'}}>
                                <thead>
                                  <tr>
                                    <th style={{textAlign:'left',padding:'7px 10px',fontWeight:600,color:OB.grey,fontSize:10,textTransform:'uppercase',letterSpacing:'0.06em',borderBottom:`1px solid ${OB.greyPale}`,background:OB.white,position:'sticky',left:0,zIndex:1,minWidth:160,whiteSpace:'nowrap'}}>Project</th>
                                    {r.resMonths.map(m=>{
                                      const [y,mm]=m.split('-');
                                      return <th key={m} style={{textAlign:'center',padding:'6px 4px',fontWeight:600,color:OB.grey,fontSize:10,textTransform:'uppercase',letterSpacing:'0.04em',borderBottom:`1px solid ${OB.greyPale}`,minWidth:46}}><div>{MONTHS[parseInt(mm)-1]}</div><div style={{fontSize:9,color:OB.greyLight,fontWeight:400}}>&apos;{y.slice(2)}</div></th>;
                                    })}
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.projectRows.map(({proj,byMonth,activeScenId})=>(
                                    <tr key={proj.id} style={{borderBottom:`1px solid ${OB.greyPale}`}}>
                                      <td style={{padding:'6px 10px',background:OB.white,position:'sticky',left:0,zIndex:1,whiteSpace:'nowrap',borderRight:`1px solid ${OB.greyPale}`}}>
                                        <div style={{display:'flex',alignItems:'center',gap:6}}>
                                          <div style={{width:3,height:16,borderRadius:2,background:statusColor(proj.status),flexShrink:0}}/>
                                          <span style={{fontSize:12,fontWeight:600,color:OB.greyDeep}}>{proj.name}</span>
                                        </div>
                                      </td>
                                      {r.resMonths.map(m=>{
                                        const pct=byMonth[m]||0;
                                        return <td key={m} style={{padding:3,textAlign:'center'}}><MonthCell pct={pct} allocColor={allocColor} allocTextColor={allocTextColor} onCommit={n=>onSetMonth(proj.id, activeScenId, r.id, m, n)}/></td>;
                                      })}
                                    </tr>
                                  ))}
                                  <tr style={{background:OB.greyPale}}>
                                    <td style={{padding:'6px 10px',fontSize:10,fontWeight:600,color:OB.grey,textTransform:'uppercase',letterSpacing:'0.05em',background:OB.greyPale,position:'sticky',left:0,zIndex:1}}>Total</td>
                                    {r.resMonths.map(m=>{
                                      const t=r.totalByMonth[m]||0;
                                      return <td key={m} style={{padding:'5px 2px',textAlign:'center',fontSize:10,fontWeight:700,color:t>100?OB.cancelled:OB.greyDeep}}>{t?`${t}%`:''}</td>;
                                    })}
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {rows.length===0&&(
              <tr><td colSpan={colCount} style={{padding:'2rem',textAlign:'center',color:OB.grey,fontSize:13}}>No resources match the current filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Click-to-edit cell for a single person's monthly allocation %.
function MonthCell({pct, allocColor, allocTextColor, onCommit}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  function start(){ setVal(pct?String(pct):''); setEditing(true); }
  function commit(){ setEditing(false); const n=Math.max(0,parseInt(val||'0',10)||0); if(n!==pct) onCommit(n); }
  if (editing) {
    return (
      <input
        autoFocus
        value={val}
        onChange={e=>setVal(e.target.value.replace(/[^0-9]/g,'').slice(0,3))}
        onBlur={commit}
        onKeyDown={e=>{ if(e.key==='Enter'){e.preventDefault();commit();} else if(e.key==='Escape'){setEditing(false);} }}
        style={{width:40,textAlign:'center',fontFamily:FONT,fontSize:11,fontWeight:600,padding:'3px 2px',border:`1px solid ${OB.green}`,borderRadius:2,color:OB.greyDeep,outline:'none'}}
      />
    );
  }
  return (
    <div
      onClick={start}
      title="Click to edit allocation"
      style={{cursor:'pointer',borderRadius:2,padding:'3px 2px',fontSize:11,fontWeight:600,minHeight:22,display:'flex',alignItems:'center',justifyContent:'center',
        background: pct>0?allocColor(pct):'transparent',
        color: pct>0?allocTextColor(pct):OB.greyLight,
        border: pct>0?'none':`1px dashed ${OB.greyPale}`}}
    >
      {pct>0?`${pct}%`:'+'}
    </div>
  );
}

function ProjectsTab({data,onEdit,onDelete,onAdd,onAddAlloc,onSetPeriod,statusColor,statusBg,allocColor,allocTextColor,granularity,setGranularity,simple,hideStatus,hideScenario,hideEdit}) {
  const [expanded, setExpanded] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState([]);
  const [typeFilter, setTypeFilter] = useState([]);
  const [divFilter, setDivFilter] = useState([]);
  const [clientFilter, setClientFilter] = useState([]);
  const [pmFilter, setPmFilter] = useState([]);
  const [sortCol, setSortCol] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const _now=new Date();
  const _defFrom=`${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}`;
  const _ti=_now.getFullYear()*12+_now.getMonth()+11; const _defTo=`${Math.floor(_ti/12)}-${String(_ti%12+1).padStart(2,'0')}`;
  const [fromMonth,setFromMonth]=useState(_defFrom); const [toMonth,setToMonth]=useState(_defTo);
  const periods = useMemo(()=>buildPeriods(fromMonth,toMonth,granularity||'month'),[fromMonth,toMonth,granularity]);
  const clients = [...new Set(data.projects.map(p=>p.client).filter(Boolean))].sort();
  const pms = [...new Set(data.projects.map(p=>p.pm).filter(Boolean))].sort();

  function toggleSort(col) {
    if (sortCol===col) setSortDir(d=>d==='asc'?'desc':'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }

  const rows = useMemo(() => {
    return data.projects
      .filter(p => {
        const q = search.toLowerCase();
        const matchSearch = !q || p.name.toLowerCase().includes(q) || p.type.toLowerCase().includes(q) || p.division.toLowerCase().includes(q) || (p.client||'').toLowerCase().includes(q) || (p.pm||'').toLowerCase().includes(q);
        // Completed/Cancelled projects are hidden everywhere except the Admin (simple) page.
        return matchSearch && (simple || isPlannable(p)) && (statusFilter.length===0||statusFilter.includes(p.status)) && (typeFilter.length===0||typeFilter.includes(p.type)) && (divFilter.length===0||divFilter.includes(p.division)) && (clientFilter.length===0||clientFilter.includes(p.client)) && (pmFilter.length===0||pmFilter.includes(p.pm));
      })
      .map(p => {
        const activeScen = (p.scenarios||[]).find(s=>s.active);
        const activeAllocs = data.allocations.filter(a=>a.projectId===p.id&&(a.scenarioId===activeScen?.id||!a.scenarioId));
        const resourceIds = [...new Set(activeAllocs.map(a=>a.resourceId))];
        const teamResources = resourceIds.map(id=>data.resources.find(r=>r.id===id)).filter(Boolean);
        // One row per person, with their allocation % per visible period (summed if multiple allocations)
        const personRows = resourceIds.map(id=>{
          const res = data.resources.find(r=>r.id===id);
          const my = activeAllocs.filter(a=>a.resourceId===id);
          const byKey = {};
          periods.forEach(pd=>{ let s=0; my.forEach(a=>{ if(pd.start<=a.endDate&&pd.end>=a.startDate) s+=a.allocationPct||0; }); if(s) byKey[pd.key]=s; });
          return {res, byKey};
        }).filter(x=>x.res);
        return {...p, activeScen, activeAllocs, resourceCount:resourceIds.length, teamResources, personRows};
      })
      .sort((a,b) => {
        let av = sortCol==='resourceCount' ? a.resourceCount : (a[sortCol]||'');
        let bv = sortCol==='resourceCount' ? b.resourceCount : (b[sortCol]||'');
        const cmp = typeof av==='number' ? av-bv : String(av).localeCompare(String(bv));
        return sortDir==='asc' ? cmp : -cmp;
      });
  }, [data.projects, data.allocations, data.resources, search, statusFilter, typeFilter, divFilter, clientFilter, pmFilter, sortCol, sortDir, periods, simple]);


  function SortIcon({col}) {
    if (sortCol!==col) return <span style={{color:OB.greyPale,marginLeft:3}}>↕</span>;
    return <span style={{color:OB.green,marginLeft:3}}>{sortDir==='asc'?'↑':'↓'}</span>;
  }

  const thBase = {textAlign:'left',padding:'8px 10px',fontWeight:600,color:OB.grey,fontSize:10,textTransform:'uppercase',letterSpacing:'0.06em',borderBottom:`2px solid ${OB.greyPale}`,background:OB.greyPale,cursor:'pointer',whiteSpace:'nowrap',userSelect:'none'};

  const byStatus = s => data.projects.filter(p=>p.status===s).length;
  const byType = t => data.projects.filter(p=>p.type===t).length;
  const peopleStaffed = new Set(activeAllocations(data).map(a=>a.resourceId)).size;
  const divisionCounts = [...new Set(data.projects.map(p=>p.division))].sort().map(d=>[d, data.projects.filter(p=>p.division===d).length]);
  const showStatus = !simple && !hideStatus;
  const showScenario = !simple && !hideScenario;
  const showTeam = !simple;
  const showExpand = !simple;
  const showEdit = !hideEdit;
  const colCount = 6 + (showStatus?1:0) + (showScenario?1:0) + (showTeam?1:0);

  return (
    <div>
      {/* Summary strip */}
      {simple ? (
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',gap:8,marginBottom:'1.25rem',alignItems:'stretch'}}>
          <div style={{background:OB.greyPale,borderRadius:4,padding:'10px 14px',borderLeft:`3px solid ${OB.greyDeep}`}}>
            <div style={{fontSize:10,color:OB.grey,marginBottom:4,textTransform:'uppercase',letterSpacing:'0.06em',fontWeight:600}}>Total</div>
            <div style={{fontSize:22,fontWeight:300,color:OB.greyDeep,lineHeight:1}}>{data.projects.length}</div>
          </div>
          <div style={{background:OB.greyPale,borderRadius:4,padding:'10px 14px',borderLeft:`3px solid ${OB.green}`}}>
            <div style={{fontSize:10,color:OB.grey,marginBottom:6,textTransform:'uppercase',letterSpacing:'0.06em',fontWeight:600}}>Type</div>
            {PROJECT_TYPES.map(t=>(<div key={t} style={{display:'flex',justifyContent:'space-between',fontSize:12,color:OB.greyDark,marginBottom:2}}><span>{t}</span><b style={{color:OB.greyDeep}}>{byType(t)}</b></div>))}
          </div>
          <div style={{background:OB.greyPale,borderRadius:4,padding:'10px 14px',borderLeft:`3px solid ${OB.opportunity}`}}>
            <div style={{fontSize:10,color:OB.grey,marginBottom:6,textTransform:'uppercase',letterSpacing:'0.06em',fontWeight:600}}>Division</div>
            {divisionCounts.map(([d,c])=>(<div key={d} style={{display:'flex',justifyContent:'space-between',gap:8,fontSize:12,color:OB.greyDark,marginBottom:2}}><span style={{whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{d}</span><b style={{color:OB.greyDeep}}>{c}</b></div>))}
          </div>
        </div>
      ) : (
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))',gap:8,marginBottom:'1.25rem'}}>
        {[
          ['Total',data.projects.length,OB.greyDeep,'All'],
          ['In progress',byStatus('In Progress'),OB.greenDark,'In Progress'],
          ['On hold',byStatus('On Hold'),OB.onHold,'On Hold'],
          ['Opportunities',byStatus('Opportunity'),OB.opportunity,'Opportunity'],
          ['People staffed',peopleStaffed,OB.greyDeep,null],
        ].map(([label,val,col,filter])=>(
          <div key={label} onClick={()=>{ if(filter!==null) setStatusFilter(filter==='All'?[]:[filter]); }} style={{background:OB.greyPale,borderRadius:4,padding:'10px 14px',borderLeft:`3px solid ${col}`,cursor:filter!==null?'pointer':'default'}}>
            <div style={{fontSize:10,color:OB.grey,marginBottom:4,textTransform:'uppercase',letterSpacing:'0.06em',fontWeight:600}}>{label}</div>
            <div style={{fontSize:22,fontWeight:300,color:col,lineHeight:1}}>{val}</div>
          </div>
        ))}
      </div>
      )}

      {/* Controls */}
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:'1rem',flexWrap:'wrap'}}>
        <input placeholder="Search projects..." value={search} onChange={e=>setSearch(e.target.value)} style={{...ctrl,flex:'1 1 160px',minWidth:140}}/>
        <span style={{fontSize:11,color:OB.grey,flexShrink:0}}>{rows.length} of {data.projects.length}</span>
        <div style={{flex:1}}/>
        <button onClick={onAdd} style={btnStyle(true)}>+ Add project</button>
      </div>
      {showExpand && (
        <div style={{display:'flex',flexWrap:'wrap',gap:8,alignItems:'center',marginBottom:'1rem'}}>
          <div style={{display:'flex',alignItems:'center',gap:6}}><label style={{fontSize:12,color:OB.grey}}>From</label>{granularity==='week' ? <DayPicker value={fromMonth} onChange={setFromMonth}/> : <MonthPicker value={fromMonth} onChange={setFromMonth}/>}</div>
          <div style={{display:'flex',alignItems:'center',gap:6}}><label style={{fontSize:12,color:OB.grey}}>To</label>{granularity==='week' ? <DayPicker value={toMonth} onChange={setToMonth}/> : <MonthPicker value={toMonth} onChange={setToMonth}/>}</div>
          <GranularityToggle value={granularity||'month'} onChange={setGranularity}/>
        </div>
      )}
      <div style={{display:'flex',flexWrap:'wrap',gap:8,alignItems:'center',marginBottom:'1rem'}}>
        <MultiFilter options={[...new Set(data.projects.map(p=>p.division))].sort()} selected={divFilter} onChange={setDivFilter}/>
        <MultiSelect options={PROJECT_TYPES} selected={typeFilter} onChange={setTypeFilter} placeholder="All types"/>
        {simple && <MultiSelect options={PROJECT_STATUSES} selected={statusFilter} onChange={setStatusFilter} placeholder="All statuses"/>}
        {clients.length>0&&<MultiSelect options={clients} selected={clientFilter} onChange={setClientFilter} placeholder="All clients"/>}
        {pms.length>0&&<MultiSelect options={pms} selected={pmFilter} onChange={setPmFilter} placeholder="All owners"/>}
      </div>

      {/* Table */}
      <div style={{borderRadius:4,border:`1px solid ${OB.greyPale}`,overflow:'hidden'}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:12,fontFamily:FONT}}>
          <thead>
            <tr>
              <th style={thBase} onClick={()=>toggleSort('name')}>Project <SortIcon col="name"/></th>
              <th style={thBase} onClick={()=>toggleSort('client')}>Client <SortIcon col="client"/></th>
              <th style={thBase} onClick={()=>toggleSort('pm')}>Owner <SortIcon col="pm"/></th>
              <th style={thBase} onClick={()=>toggleSort('type')}>Type <SortIcon col="type"/></th>
              <th style={thBase} onClick={()=>toggleSort('division')}>Division <SortIcon col="division"/></th>
              {showStatus && <th style={thBase} onClick={()=>toggleSort('status')}>Status <SortIcon col="status"/></th>}
              {showScenario && <th style={thBase}>Scenario</th>}
              {showTeam && <th style={{...thBase}} onClick={()=>toggleSort('resourceCount')}>Team <SortIcon col="resourceCount"/></th>}
              <th style={{...thBase,cursor:'default'}}/>
            </tr>
          </thead>
          <tbody>
            {rows.map((p,i) => {
              const isOpen = expanded===p.id;
              return (
                <Fragment key={p.id}>
                  <tr
                    onClick={showExpand?()=>setExpanded(isOpen?null:p.id):undefined}
                    style={{borderBottom:isOpen?'none':`1px solid ${OB.greyPale}`,background:isOpen?OB.greenPale:(p.type==='Opportunity'?'#f4fae3':(i%2===0?OB.white:'#fafafa')),cursor:showExpand?'pointer':'default'}}
                  >
                    {/* Project name */}
                    <td style={{padding:'5px 10px',fontWeight:600,color:OB.greyDeep,whiteSpace:'nowrap'}}>
                      <div style={{display:'flex',alignItems:'center',gap:7}}>
                        <div style={{width:3,height:20,borderRadius:2,background:statusColor(p.status),flexShrink:0}}/>
                        {p.name}
                      </div>
                    </td>
                    {/* Client */}
                    <td style={{padding:'5px 10px',color:p.client?OB.greyDark:OB.greyLight,whiteSpace:'nowrap'}}>{p.client||'—'}</td>
                    {/* PM */}
                    <td style={{padding:'5px 10px',color:p.pm?OB.greyDark:OB.greyLight,whiteSpace:'nowrap'}}>{p.pm||'—'}</td>
                    {/* Type */}
                    <td style={{padding:'5px 10px',color:OB.grey,whiteSpace:'nowrap'}}>{p.type}</td>
                    {/* Division */}
                    <td style={{padding:'5px 10px',color:OB.grey,whiteSpace:'nowrap'}}>{p.division}</td>
                    {showStatus && (
                    <td style={{padding:'5px 10px'}}>
                      <span style={{fontSize:10,padding:'2px 8px',borderRadius:2,background:statusBg(p.status),color:statusColor(p.status),fontWeight:600,textTransform:'uppercase',letterSpacing:'0.04em',whiteSpace:'nowrap'}}>{p.status}</span>
                    </td>)}
                    {showScenario && (
                    <td style={{padding:'5px 10px'}}>
                      {p.activeScen&&<span style={{fontSize:10,padding:'2px 7px',borderRadius:2,background:isOpen?OB.white:OB.greenPale,color:OB.greenDark,fontWeight:600,whiteSpace:'nowrap'}}>{p.activeScen.name}</span>}
                    </td>)}
                    {showTeam && (
                    <td style={{padding:'5px 10px'}}>
                      <span style={{fontSize:12,fontWeight:600,color:p.resourceCount>0?OB.greyDeep:OB.greyLight}}>{p.resourceCount>0?p.resourceCount:'—'}</span>
                    </td>)}
                    {/* Actions */}
                    <td style={{padding:'5px 10px',whiteSpace:'nowrap',textAlign:'right'}}>
                      {showExpand && <span style={{color:OB.green,fontSize:11,fontWeight:600,marginRight:8}}>{isOpen?'▲':'▼'}</span>}
                      {showEdit && <><button onClick={e=>{e.stopPropagation();onEdit(p);}} style={{background:'none',border:'none',cursor:'pointer',color:OB.grey,fontSize:12,padding:'2px 5px',fontFamily:FONT}}>Edit</button>
                      <button onClick={e=>{e.stopPropagation();onDelete(p.id);}} style={{background:'none',border:'none',cursor:'pointer',color:OB.cancelled,fontSize:12,padding:'2px 5px',fontFamily:FONT}}>Remove</button></>}
                    </td>
                  </tr>

                  {/* Expandable drawer */}
                  {showExpand && isOpen&&(
                    <tr key={p.id+'-drawer'}>
                      <td colSpan={colCount} style={{padding:'0',borderBottom:`1px solid ${OB.greyPale}`}}>
                        <div style={{background:OB.greyPale,padding:'12px 14px 14px',borderTop:`1px solid ${OB.greenLight}`}}>
                          <span style={sectionLabel}>Active scenario: {p.activeScen?.name||'none'} — allocation</span>
                          {p.personRows.length===0&&<div style={{fontSize:12,color:OB.greyLight}}>No allocations in the active scenario.</div>}
                          {p.personRows.length>0&&(
                            <div style={{overflowX:'auto',background:OB.white,border:`1px solid ${OB.greyPale}`,borderRadius:3}}>
                              <table style={{borderCollapse:'collapse',fontSize:11,fontFamily:FONT,width:'100%'}}>
                                <thead>
                                  <tr>
                                    <th style={{textAlign:'left',padding:'7px 10px',fontWeight:600,color:OB.grey,fontSize:10,textTransform:'uppercase',letterSpacing:'0.06em',borderBottom:`1px solid ${OB.greyPale}`,background:OB.white,position:'sticky',left:0,zIndex:1,minWidth:150,whiteSpace:'nowrap'}}>Person</th>
                                    {periods.map(pd=>(
                                        <th key={pd.key} style={{textAlign:'center',padding:'6px 4px',fontWeight:600,color:OB.grey,fontSize:10,textTransform:'uppercase',letterSpacing:'0.04em',borderBottom:`1px solid ${OB.greyPale}`,minWidth:46}}>
                                          <div style={{whiteSpace:'nowrap'}}>{pd.label}</div>
                                          <div style={{fontSize:9,color:OB.greyLight,fontWeight:400}}>{pd.sub}</div>
                                        </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {p.personRows.map(({res,byKey})=>(
                                    <tr key={res.id} style={{borderBottom:`1px solid ${OB.greyPale}`}}>
                                      <td style={{padding:'7px 10px',background:OB.white,position:'sticky',left:0,zIndex:1,whiteSpace:'nowrap',borderRight:`1px solid ${OB.greyPale}`}}>
                                        <div style={{fontSize:12,fontWeight:600,color:OB.greyDeep}}>{res.name}</div>
                                        <div style={{fontSize:10,color:OB.grey}}>{res.skillGroup}{res.division?`, ${res.division}`:''}</div>
                                      </td>
                                      {periods.map(pd=>(
                                          <td key={pd.key} style={{padding:3,textAlign:'center'}}>
                                            <MonthCell pct={byKey[pd.key]||0} allocColor={allocColor} allocTextColor={allocTextColor} onCommit={n=>onSetPeriod(p.id, p.activeScen?.id||'', res.id, pd, n)} />
                                          </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                          <button
                            onClick={e=>{e.stopPropagation();onAddAlloc({projectId:p.id,scenarioId:p.activeScen?.id||'',resourceId:'',allocationPct:100,startDate:'',endDate:''},);}}
                            style={{...btnStyle(true),marginTop:10}}>
                            + Assign resource
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {rows.length===0&&(
              <tr><td colSpan={colCount} style={{padding:'2rem',textAlign:'center',color:OB.grey,fontSize:13}}>No projects match the current filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Scenarios v2: cross-project scenarios you build up and inline-edit ────────
function ScenariosView({data, onAddScenario, onDeleteScenario, onRenameScenario, onAddProject, onRemoveProject, onSetPeriod, granularity, setGranularity, statusColor, allocColor, allocTextColor}) {
  const scenarios = data.v2Scenarios||[];
  const [selectedId, setSelectedId] = useState(scenarios[0]?.id||null);
  const [newName, setNewName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [editVal, setEditVal] = useState('');
  const yr = new Date().getFullYear();
  const [fromMonth, setFromMonth] = useState(`${yr}-01`);
  const [toMonth, setToMonth] = useState(`${yr}-12`);
  const [addRows, setAddRows] = useState({}); // projectId -> [resourceId] locally-added empty rows

  const periods = useMemo(()=>buildPeriods(fromMonth,toMonth,granularity||'month'),[fromMonth,toMonth,granularity]);

  const selected = scenarios.find(s=>s.id===selectedId);
  const scenProjectIds = (data.v2Projects||[]).filter(p=>p.v2ScenarioId===selectedId).map(p=>p.projectId);
  const scenProjects = scenProjectIds.map(pid=>data.projects.find(p=>p.id===pid)).filter(Boolean).sort((a,b)=>a.name.localeCompare(b.name));
  // Completed/Cancelled projects can't be added to scenarios.
  const availableProjects = [...data.projects].filter(p=>!scenProjectIds.includes(p.id)&&isPlannable(p)).sort((a,b)=>a.name.localeCompare(b.name));

  async function createScenario(){ const n=newName.trim(); if(!n) return; setNewName(''); const id=await onAddScenario(n); if(id) setSelectedId(id); }
  function commitRename(){ const n=editVal.trim(); setEditingName(false); if(n&&selected) onRenameScenario(selected.id,n); }
  function peopleRows(projectId){
    const withAlloc=[...new Set((data.v2Allocations||[]).filter(a=>a.v2ScenarioId===selectedId&&a.projectId===projectId).map(a=>a.resourceId))];
    const added=(addRows[projectId]||[]).filter(id=>!withAlloc.includes(id));
    return [...withAlloc, ...added].map(id=>{
      const res=data.resources.find(r=>r.id===id);
      const my=(data.v2Allocations||[]).filter(a=>a.v2ScenarioId===selectedId&&a.projectId===projectId&&a.resourceId===id);
      const byKey={}; periods.forEach(pd=>{ let s=0; my.forEach(a=>{ if(pd.start<=a.endDate&&pd.end>=a.startDate) s+=a.allocationPct||0; }); if(s) byKey[pd.key]=s; });
      return {res, byKey};
    }).filter(x=>x.res).sort((a,b)=>a.res.name.localeCompare(b.res.name));
  }

  return (
    <div style={{display:'grid',gridTemplateColumns:'220px minmax(0,1fr)',gap:16}}>
      <div style={card}>
        <span style={sectionLabel}>Scenarios</span>
        <div style={{display:'flex',gap:6,marginBottom:10}}>
          <input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="New scenario..." style={{...inputStyle,fontSize:12,padding:'5px 8px'}} onKeyDown={e=>{if(e.key==='Enter')createScenario();}}/>
          <button onClick={createScenario} style={btnStyle(true)}>+</button>
        </div>
        {scenarios.length===0&&<div style={{fontSize:12,color:OB.greyLight}}>No scenarios yet.</div>}
        {scenarios.map(s=>(
          <div key={s.id} onClick={()=>setSelectedId(s.id)} style={{padding:'8px 10px',borderRadius:3,cursor:'pointer',marginBottom:4,fontSize:12,fontWeight:600,background:selectedId===s.id?OB.greenPale:OB.white,border:`1px solid ${selectedId===s.id?OB.greenLight:OB.greyPale}`,color:OB.greyDeep}}>{s.name}</div>
        ))}
      </div>

      <div style={{minWidth:0}}>
        {!selected&&<div style={{color:OB.grey,fontSize:13}}>Create or select a scenario.</div>}
        {selected&&(
          <div>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:'1rem',flexWrap:'wrap'}}>
              {editingName
                ? <input value={editVal} onChange={e=>setEditVal(e.target.value)} onBlur={commitRename} onKeyDown={e=>{if(e.key==='Enter')commitRename(); else if(e.key==='Escape')setEditingName(false);}} style={{...inputStyle,width:220,fontSize:15}} autoFocus/>
                : <h3 style={{fontSize:16,fontWeight:300,margin:0,color:OB.greyDeep,cursor:'text'}} title="Double-click to rename" onDoubleClick={()=>{setEditingName(true);setEditVal(selected.name);}}>{selected.name}</h3>}
              <div style={{flex:1}}/>
              <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
                <label style={{fontSize:12,color:OB.grey}}>From</label>
                {granularity==='week' ? <DayPicker value={fromMonth} onChange={setFromMonth}/> : <MonthPicker value={fromMonth} onChange={setFromMonth}/>}
                <label style={{fontSize:12,color:OB.grey}}>To</label>
                {granularity==='week' ? <DayPicker value={toMonth} onChange={setToMonth}/> : <MonthPicker value={toMonth} onChange={setToMonth}/>}
                <GranularityToggle value={granularity||'month'} onChange={setGranularity}/>
              </div>
              <button onClick={()=>{ if(window.confirm(`Delete scenario "${selected.name}"?`)){ onDeleteScenario(selected.id); setSelectedId(null); } }} style={{background:'none',border:'none',cursor:'pointer',color:OB.cancelled,fontSize:12,fontFamily:FONT}}>Delete scenario</button>
            </div>

            <div style={{marginBottom:'1.25rem'}}>
              <select value="" onChange={e=>{ if(e.target.value){ onAddProject(selected.id,e.target.value); } }} style={{...ctrl,minWidth:280}} disabled={availableProjects.length===0}>
                <option value="">+ Add a project to this scenario…</option>
                {availableProjects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>

            {scenProjects.length===0&&<div style={{fontSize:12,color:OB.greyLight}}>No projects yet. Add one above to start allocating people.</div>}

            {scenProjects.length>0 && (
            <div style={{overflowX:'auto',border:`1px solid ${OB.greyPale}`,borderRadius:4}}>
              <table style={{borderCollapse:'collapse',fontSize:11,fontFamily:FONT,width:'100%'}}>
                <thead>
                  <tr style={{background:OB.greyPale}}>
                    <th style={{textAlign:'left',padding:'7px 10px',fontWeight:600,color:OB.grey,fontSize:10,textTransform:'uppercase',letterSpacing:'0.06em',borderBottom:`1px solid ${OB.greyPale}`,background:OB.greyPale,position:'sticky',left:0,top:0,zIndex:3,whiteSpace:'nowrap',width:200,minWidth:200}}>Person</th>
                    {periods.map(pd=><th key={pd.key} style={{textAlign:'center',padding:'6px 4px',fontWeight:600,color:OB.grey,fontSize:10,textTransform:'uppercase',letterSpacing:'0.04em',borderBottom:`1px solid ${OB.greyPale}`,background:OB.greyPale,position:'sticky',top:0,zIndex:2,minWidth:46}}><div style={{whiteSpace:'nowrap'}}>{pd.label}</div><div style={{fontSize:9,color:OB.greyLight,fontWeight:400}}>{pd.sub}</div></th>)}
                  </tr>
                </thead>
                <tbody>
                  {scenProjects.map(proj=>{
                    const rows=peopleRows(proj.id);
                    const rowIds=rows.map(x=>x.res.id);
                    const addable=[...data.resources].filter(r=>!rowIds.includes(r.id)).sort((a,b)=>a.name.localeCompare(b.name));
                    return (
                      <Fragment key={proj.id}>
                        <tr>
                          <td colSpan={periods.length+1} style={{padding:0,background:OB.greenPale,borderTop:`1px solid ${OB.greenLight}`,borderBottom:`1px solid ${OB.greyPale}`}}>
                            <div style={{position:'sticky',left:0,display:'inline-flex',alignItems:'center',gap:8,padding:'8px 12px'}}>
                              <div style={{width:3,height:16,borderRadius:2,background:statusColor(proj.status),flexShrink:0}}/>
                              <span style={{fontSize:13,fontWeight:600,color:OB.greyDeep,whiteSpace:'nowrap'}}>{proj.name}</span>
                              <button onClick={()=>{ if(window.confirm(`Remove ${proj.name} from this scenario?`)) onRemoveProject(selected.id,proj.id); }} title="Remove project" style={{background:'none',border:'none',cursor:'pointer',color:OB.cancelled,fontSize:15,lineHeight:1,padding:'0 2px'}}>×</button>
                            </div>
                          </td>
                        </tr>
                        {rows.map(({res,byKey})=>(
                          <tr key={res.id} style={{borderBottom:`1px solid ${OB.greyPale}`}}>
                            <td style={{padding:'6px 10px',background:OB.white,position:'sticky',left:0,zIndex:1,borderRight:`1px solid ${OB.greyPale}`}}>
                              <div style={{fontSize:12,fontWeight:600,color:OB.greyDeep,whiteSpace:'nowrap'}}>{res.name}</div>
                              <div style={{fontSize:10,color:OB.grey,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{res.skillGroup}{res.division?`, ${res.division}`:''}</div>
                            </td>
                            {periods.map(pd=><td key={pd.key} style={{padding:3,textAlign:'center'}}><MonthCell pct={byKey[pd.key]||0} allocColor={allocColor} allocTextColor={allocTextColor} onCommit={n=>onSetPeriod(selected.id, proj.id, res.id, pd, n)}/></td>)}
                          </tr>
                        ))}
                        <tr style={{borderBottom:`1px solid ${OB.greyPale}`}}>
                          <td colSpan={periods.length+1} style={{padding:0,background:OB.white}}>
                            <div style={{position:'sticky',left:0,display:'inline-flex',padding:'6px 12px'}}>
                              <select value="" onChange={e=>{ if(e.target.value){ setAddRows(a=>({...a,[proj.id]:[...(a[proj.id]||[]),e.target.value]})); } }} style={{...ctrl,fontSize:11,padding:'3px 6px'}} disabled={addable.length===0}>
                                <option value="">+ Add person…</option>
                                {addable.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
                              </select>
                            </div>
                          </td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Scenarios v2 planner: pick a scenario and see its combined per-person load ──
function PlannerView({data, allocColor, allocTextColor, onCommit, granularity, setGranularity}) {
  const scenarios = data.v2Scenarios||[];
  const [selectedId, setSelectedId] = useState(''); // no scenario selected on load
  const [divFilter, setDivFilter] = useState([]);
  const [pmFilter, setPmFilter] = useState([]);
  const [showAll, setShowAll] = useState(false); // false = only people in the scenario
  const divisions = [...new Set(data.resources.map(r=>r.division))].sort();
  const pms = [...new Set(data.projects.map(p=>p.pm).filter(Boolean))].sort();
  const scenAllocs = (data.v2Allocations||[]).filter(a=>a.v2ScenarioId===selectedId);
  const v2ProjectIds = new Set((data.v2Projects||[]).filter(p=>p.v2ScenarioId===selectedId).map(p=>p.projectId));
  const inScenarioIds = new Set(scenAllocs.map(a=>a.resourceId));
  const plannable = plannableProjectIds(data);
  const activeAll = activeAllocations(data).filter(a=>plannable.has(a.projectId)); // exclude completed/cancelled
  // Combined: active load for projects not in the scenario + this scenario's allocations.
  const combinedAllocs = [...activeAll.filter(a=>!v2ProjectIds.has(a.projectId)), ...scenAllocs];
  const months = (()=>{ let min=null,max=null; combinedAllocs.forEach(a=>{ const s=a.startDate.slice(0,7),e=a.endDate.slice(0,7); if(!min||s<min)min=s; if(!max||e>max)max=e; }); return (min&&max)?buildPeriods(min,max,granularity||'month'):[]; })();
  const map = bucketByPeriod(combinedAllocs, months);
  const activeMap = bucketByPeriod(activeAll, months);
  const pmResourceIds = pmFilter.length===0 ? null : (()=>{ const projIds=new Set(data.projects.filter(p=>p.pm && pmFilter.includes(p.pm)).map(p=>p.id)); return new Set(scenAllocs.filter(a=>projIds.has(a.projectId)).map(a=>a.resourceId)); })();
  const rows = data.resources.filter(r=>{
    if(divFilter.length && !divFilter.includes(r.division)) return false;
    if(pmResourceIds && !pmResourceIds.has(r.id)) return false;
    return showAll ? true : inScenarioIds.has(r.id);
  }).sort((a,b)=>a.name.localeCompare(b.name));
  const th = {textAlign:'center',padding:'8px 4px',fontWeight:600,color:OB.grey,borderBottom:`1px solid #e8e8e8`,minWidth:52,fontSize:10,textTransform:'uppercase',letterSpacing:'0.04em',background:OB.greyPale};

  return (
    <div>
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:'1rem',flexWrap:'wrap'}}>
        <span style={{...sectionLabel,marginBottom:0}}>Scenario</span>
        <select value={selectedId} onChange={e=>setSelectedId(e.target.value)} style={{...ctrl,minWidth:220}}>
          <option value="">Select a scenario…</option>
          {scenarios.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {selectedId && months.length>0 && <GranularityToggle value={granularity||'month'} onChange={setGranularity}/>}
        <div style={{flex:1}}/>
        {selectedId && v2ProjectIds.size>0 && <button onClick={()=>onCommit(selectedId)} style={btnStyle(true)}>Commit scenario</button>}
      </div>
      {selectedId && months.length>0 && (
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:'1rem',flexWrap:'wrap'}}>
          <MultiFilter options={divisions} selected={divFilter} onChange={setDivFilter}/>
          {pms.length>0 && <MultiSelect options={pms} selected={pmFilter} onChange={setPmFilter} placeholder="All owners"/>}
          <div style={{flex:1}}/>
          <div style={{display:'flex',gap:6}}>
            <button onClick={()=>setShowAll(false)} style={pillStyle(!showAll)}>In scenario</button>
            <button onClick={()=>setShowAll(true)} style={pillStyle(showAll)}>All resources</button>
          </div>
        </div>
      )}
      {!selectedId&&<div style={{fontSize:13,color:OB.greyLight}}>Pick a scenario to see its combined per-person load across projects.</div>}
      {selectedId&&months.length===0&&<div style={{fontSize:13,color:OB.greyLight}}>This scenario has no allocations yet.</div>}
      {selectedId&&months.length>0&&rows.length===0&&<div style={{fontSize:13,color:OB.greyLight}}>No resources match the current filters.</div>}
      {selectedId&&months.length>0&&rows.length>0&&(
        <div style={{overflowX:'auto',border:`1px solid ${OB.greyPale}`,borderRadius:4}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12,fontFamily:FONT}}>
            <thead>
              <tr style={{background:OB.greyPale}}>
                <th style={{textAlign:'left',padding:'8px 12px',fontWeight:600,color:OB.grey,fontSize:10,textTransform:'uppercase',letterSpacing:'0.06em',borderBottom:`1px solid #e8e8e8`,position:'sticky',left:0,zIndex:2,width:170,minWidth:170,maxWidth:170,background:OB.greyPale,whiteSpace:'nowrap'}}>Resource</th>
                <th style={{textAlign:'left',padding:'8px 10px',fontWeight:600,color:OB.grey,fontSize:10,textTransform:'uppercase',letterSpacing:'0.06em',borderBottom:`1px solid #e8e8e8`,width:110,minWidth:110,maxWidth:110,background:OB.greyPale,whiteSpace:'nowrap'}}>Skill</th>
                {months.map(pd=><th key={pd.key} style={th}><div style={{whiteSpace:'nowrap'}}>{pd.label}</div><div style={{fontSize:9,color:OB.greyLight,fontWeight:400}}>{pd.sub}</div></th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map(r=>(
                <tr key={r.id} style={{borderBottom:`1px solid ${OB.greyPale}`}}>
                  <td style={{padding:'7px 12px',fontWeight:600,color:OB.greyDeep,position:'sticky',left:0,background:OB.white,zIndex:1,width:170,minWidth:170,maxWidth:170}}><div title={r.name} style={{width:146,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.name}</div></td>
                  <td style={{padding:'7px 10px',color:OB.grey,fontSize:11,width:110,minWidth:110,maxWidth:110}}><div title={r.skillGroup} style={{width:90,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.skillGroup}</div></td>
                  {months.map(pd=>{
                    const w=map[r.id]?.[pd.key]||0, a=activeMap[r.id]?.[pd.key]||0, changed=w!==a;
                    return (
                      <td key={pd.key} style={{padding:3,textAlign:'center'}}>
                        {w>0
                          ? <div style={{background:allocColor(w),borderRadius:2,padding:'3px 2px',fontSize:11,fontWeight:600,color:allocTextColor(w)}}>{w}%</div>
                          : <div style={{background:OB.greyPale,borderRadius:2,padding:'3px 2px',fontSize:11,color:OB.greyLight}}>·</div>}
                        {changed&&<div style={{fontSize:9,marginTop:1,fontWeight:600,color:w>a?OB.cancelled:OB.greenDark}}>{w>a?'▲':'▼'}{w>a?'+':''}{w-a}%</div>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selectedId&&months.length>0&&rows.length>0&&<div style={{fontSize:11,color:OB.greyLight,marginTop:'0.75rem'}}>▲/▼ = change vs the current active plan. Cells show each person&apos;s total load with this scenario applied. &quot;Commit scenario&quot; replaces the active allocations of this scenario&apos;s projects.</div>}
    </div>
  );
}

function ModalWrapper({title,onClose,children}) {
  useEffect(()=>{
    const onKey = e => { if (e.key==='Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return ()=>window.removeEventListener('keydown', onKey);
  },[onClose]);
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(55,60,60,0.5)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:100,padding:16}}>
      <div style={{background:OB.white,borderRadius:4,borderTop:`3px solid ${OB.green}`,padding:'1.5rem',width:'100%',maxWidth:440,maxHeight:'90vh',overflowY:'auto',fontFamily:FONT}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'1.25rem'}}>
          <span style={{fontSize:15,fontWeight:300,color:OB.greyDeep,letterSpacing:'-0.01em'}}>{title}</span>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',fontSize:20,color:OB.grey,padding:4,lineHeight:1}}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({label,children}) {
  return (
    <div style={{marginBottom:'1rem'}}>
      <label style={{display:'block',fontSize:11,color:OB.grey,marginBottom:4,textTransform:'uppercase',letterSpacing:'0.06em',fontWeight:600}}>{label}</label>
      {children}
    </div>
  );
}

function ResourceModal({resource,onSave,onClose}) {
  const todayStr = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-${String(new Date().getDate()).padStart(2,'0')}`;
  const [form,setForm]=useState({name:'',skillGroup:SKILL_GROUPS[0],division:DIVISIONS[0],status:'Active',dailyHours:8,startDate:todayStr,endDate:'',...resource});
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const datesOk = !form.startDate || !form.endDate || form.endDate>=form.startDate;
  return (
    <ModalWrapper title={form.id?'Edit resource':'Add resource'} onClose={onClose}>
      <Field label="Full name"><input style={inputStyle} value={form.name} onChange={e=>set('name',e.target.value)} placeholder="Name"/></Field>
      <Field label="Skill group"><select style={inputStyle} value={form.skillGroup} onChange={e=>set('skillGroup',e.target.value)}>{SKILL_GROUPS.map(s=><option key={s}>{s}</option>)}</select></Field>
      <Field label="Division"><select style={inputStyle} value={form.division} onChange={e=>set('division',e.target.value)}>{DIVISIONS.map(d=><option key={d}>{d}</option>)}</select></Field>
      <Field label="Status"><select style={inputStyle} value={form.status} onChange={e=>set('status',e.target.value)}><option>Active</option><option>Inactive</option></select></Field>
      <Field label="Daily working hours"><input style={inputStyle} type="number" min="1" max="24" value={form.dailyHours} onChange={e=>set('dailyHours',Number(e.target.value))}/></Field>
      <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) minmax(0,1fr)',gap:10}}>
        <Field label="Start date (joins)"><DayPicker block value={form.startDate||''} onChange={v=>set('startDate',v)}/></Field>
        <Field label="End date (leaves — optional)"><DayPicker block allowClear placeholder="No end date" value={form.endDate||''} onChange={v=>set('endDate',v)}/></Field>
      </div>
      {!datesOk && <div style={{fontSize:11,color:OB.cancelled,fontWeight:600,marginBottom:8}}>End date must be on or after the start date.</div>}
      <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:'0.5rem'}}>
        <button onClick={onClose} style={btnStyle(false)}>Cancel</button>
        <button onClick={()=>onSave(form)} disabled={!form.name||!datesOk} style={{...btnStyle(true),opacity:(form.name&&datesOk)?1:0.4}}>Save</button>
      </div>
    </ModalWrapper>
  );
}

function ProjectModal({project,onSave,onClose,clients,resources}) {
  const [form,setForm]=useState({name:'',type:PROJECT_TYPES[0],division:DIVISIONS[0],status:'In Progress',client:'',pm:'',...project});
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const pmNames=[...new Set((resources||[]).map(r=>r.name))].sort();
  const [pmOther,setPmOther]=useState(!!form.pm && !pmNames.includes(form.pm));
  return (
    <ModalWrapper title={form.id?'Edit project':'Add project'} onClose={onClose}>
      <Field label="Division"><select style={inputStyle} value={form.division} onChange={e=>set('division',e.target.value)}>{DIVISIONS.map(d=><option key={d}>{d}</option>)}</select></Field>
      <Field label="Project name"><input style={inputStyle} value={form.name} onChange={e=>set('name',e.target.value)} placeholder="Project name"/></Field>
      <Field label="Client">
        <input style={inputStyle} value={form.client||''} onChange={e=>set('client',e.target.value)} placeholder="Client name" list="client-list"/>
        <datalist id="client-list">{(clients||[]).map(c=><option key={c} value={c}/>)}</datalist>
      </Field>
      <Field label="Opportunity / Project">
        <select style={inputStyle} value={form.type} onChange={e=>{ const v=e.target.value; const opts=statusesFor(v); setForm(f=>({...f,type:v,status:opts.includes(f.status)?f.status:opts[0]})); }}>{PROJECT_TYPES.map(t=><option key={t}>{t}</option>)}</select>
      </Field>
      <Field label="Status"><select style={inputStyle} value={form.status} onChange={e=>set('status',e.target.value)}>{statusesFor(form.type).map(s=><option key={s}>{s}</option>)}</select></Field>
      <Field label="Owner">
        <select style={inputStyle} value={pmOther?'__other__':(form.pm||'')} onChange={e=>{
          const v=e.target.value;
          if(v==='__other__'){ setPmOther(true); set('pm',''); }
          else { setPmOther(false); set('pm',v); }
        }}>
          <option value="">Select…</option>
          {pmNames.map(n=><option key={n} value={n}>{n}</option>)}
          <option value="__other__">Other…</option>
        </select>
        {pmOther && <input style={{...inputStyle,marginTop:6}} value={form.pm||''} onChange={e=>set('pm',e.target.value)} placeholder="Owner name" autoFocus/>}
      </Field>
      <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:'0.5rem'}}>
        <button onClick={onClose} style={btnStyle(false)}>Cancel</button>
        <button onClick={()=>onSave(form)} disabled={!form.name} style={{...btnStyle(true),opacity:form.name?1:0.4}}>Save</button>
      </div>
    </ModalWrapper>
  );
}

function AllocModal({alloc,data,onSave,onDelete,onClose}) {
  const [form,setForm]=useState({resourceId:'',projectId:'',scenarioId:'',allocationPct:100,startDate:'',endDate:'',...alloc});
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const selProj=data.projects.find(p=>p.id===form.projectId);
  const scenarios=selProj?.scenarios||[];
  const datesOk = !form.startDate || !form.endDate || form.endDate>=form.startDate;
  const valid=form.resourceId&&form.projectId&&form.startDate&&form.endDate&&datesOk;
  const duration = (form.startDate&&form.endDate&&datesOk) ? monthsInRange(form.startDate,form.endDate).length : 0;
  const resources=[...data.resources].sort((a,b)=>a.name.localeCompare(b.name));
  const projects=[...data.projects].sort((a,b)=>a.name.localeCompare(b.name));
  const newForThisResource = () => setForm(f=>({resourceId:f.resourceId,projectId:'',scenarioId:'',allocationPct:100,startDate:'',endDate:''}));
  const existing = form.resourceId ? data.allocations
    .filter(a=>a.resourceId===form.resourceId)
    .map(a=>{ const proj=data.projects.find(p=>p.id===a.projectId); const scen=(proj?.scenarios||[]).find(s=>s.id===a.scenarioId); return {...a, projName:proj?.name||'—', scenName:scen?.name||''}; })
    .sort((x,y)=>(x.startDate||'').localeCompare(y.startDate||'')) : [];
  return (
    <ModalWrapper title={form.id?'Edit allocation':'Add allocation'} onClose={onClose}>
      <Field label="Resource">
        <select style={inputStyle} value={form.resourceId} onChange={e=>set('resourceId',e.target.value)}>
          <option value="">Select resource...</option>
          {resources.map(r=><option key={r.id} value={r.id}>{r.name} — {r.skillGroup}</option>)}
        </select>
      </Field>
      <Field label="Project">
        <select style={inputStyle} value={form.projectId} onChange={e=>{set('projectId',e.target.value);set('scenarioId','');}}>
          <option value="">Select project...</option>
          {projects.map(p=><option key={p.id} value={p.id}>{p.name} — {p.division}</option>)}
        </select>
      </Field>
      {scenarios.length>0&&(
        <Field label="Scenario">
          <select style={inputStyle} value={form.scenarioId} onChange={e=>set('scenarioId',e.target.value)}>
            <option value="">No scenario</option>
            {scenarios.map(s=><option key={s.id} value={s.id}>{s.name}{s.active?' (active)':''}</option>)}
          </select>
        </Field>
      )}
      <Field label="Allocation">
        <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:10}}>
          <span style={{fontSize:30,fontWeight:300,color:OB.greenDark,lineHeight:1,minWidth:66}}>{form.allocationPct}%</span>
          <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
            {[25,50,75,100].map(v=>(
              <button key={v} type="button" onClick={()=>set('allocationPct',v)} style={{...btnStyle(form.allocationPct===v),padding:'4px 12px'}}>{v}%</button>
            ))}
          </div>
        </div>
        <input type="range" min="5" max="100" step="5" value={form.allocationPct} onChange={e=>set('allocationPct',Number(e.target.value))} style={{width:'100%',accentColor:OB.green}}/>
        <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:OB.greyLight,marginTop:2}}><span>5%</span><span>50%</span><span>100%</span></div>
      </Field>
      <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) minmax(0,1fr)',gap:10}}>
        <Field label="Start date"><DayPicker block value={form.startDate||''} onChange={v=>set('startDate',v)}/></Field>
        <Field label="End date"><DayPicker block value={form.endDate||''} onChange={v=>set('endDate',v)}/></Field>
      </div>
      <div style={{minHeight:18,marginBottom:6,fontSize:11}}>
        {!datesOk && <span style={{color:OB.cancelled,fontWeight:600}}>End date must be on or after the start date.</span>}
        {datesOk && duration>0 && <span style={{color:OB.grey}}>Spans {duration} month{duration!==1?'s':''}.</span>}
      </div>
      <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:'0.5rem'}}>
        <button onClick={onClose} style={btnStyle(false)}>Cancel</button>
        <button onClick={()=>onSave(form)} disabled={!valid} style={{...btnStyle(true),opacity:valid?1:0.4}}>{form.id?'Save changes':'Add'}</button>
      </div>

      {form.resourceId && existing.length>0 && (
        <div style={{marginTop:16,paddingTop:14,borderTop:`1px solid ${OB.greyPale}`}}>
          <div style={{display:'flex',alignItems:'center',marginBottom:8}}>
            <span style={{...sectionLabel,marginBottom:0}}>Existing allocations ({existing.length})</span>
            <div style={{flex:1}}/>
            <button type="button" onClick={newForThisResource} style={btnStyle(false)}>+ New</button>
          </div>
          <div style={{display:'grid',gap:5,maxHeight:200,overflowY:'auto'}}>
            {existing.map(a=>(
              <div key={a.id} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 10px',borderRadius:3,background:form.id===a.id?OB.greenPale:OB.greyPale,border:`1px solid ${form.id===a.id?OB.greenLight:OB.greyPale}`}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:600,color:OB.greyDeep,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{a.projName}{a.scenName?` · ${a.scenName}`:''}</div>
                  <div style={{fontSize:10,color:OB.grey}}>{a.startDate} → {a.endDate}</div>
                </div>
                <div style={{fontSize:12,fontWeight:600,color:a.allocationPct>100?OB.cancelled:OB.greenDark,minWidth:38,textAlign:'right'}}>{a.allocationPct}%</div>
                <button type="button" onClick={()=>setForm({resourceId:a.resourceId,projectId:a.projectId,scenarioId:a.scenarioId||'',allocationPct:a.allocationPct,startDate:a.startDate,endDate:a.endDate,id:a.id})} style={{background:'none',border:'none',cursor:'pointer',color:form.id===a.id?OB.greenDark:OB.grey,fontSize:11,fontWeight:600,fontFamily:FONT,padding:'2px 5px'}}>Edit</button>
                {onDelete&&<button type="button" onClick={()=>{ if(window.confirm('Remove this allocation?')){ onDelete(a.id); if(form.id===a.id) newForThisResource(); } }} title="Remove" style={{background:'none',border:'none',cursor:'pointer',color:OB.cancelled,fontSize:15,lineHeight:1,padding:'0 2px'}}>×</button>}
              </div>
            ))}
          </div>
        </div>
      )}
    </ModalWrapper>
  );
}

// ─── PlannerClient export ─────────────────────────────────────────────────────
export default function PlannerClient({ user, initialData }) {
  const supabase = createClient();
  const router = useRouter();

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return <App user={user} onSignOut={handleSignOut} initialData={initialData} />;
}
