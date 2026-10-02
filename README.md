# Headroom — Deployment Guide
## Resource capacity planning by Open Box Software
### Next.js 14 · Supabase · Vercel

---

## Overview

```
resource-capacity-planner/
├── src/
│   ├── app/
│   │   ├── layout.js              # Root layout
│   │   ├── page.js                # Main app (server component, loads data)
│   │   └── login/
│   │       └── page.js            # Login page
│   ├── components/
│   │   └── PlannerClient.js       # Client wrapper (paste your App here)
│   ├── lib/
│   │   ├── supabase.js            # Browser Supabase client
│   │   └── supabase-server.js     # Server Supabase client
│   └── middleware.js              # Auth guard (redirects to /login)
├── supabase/
│   └── migrations/
│       └── 001_initial_schema.sql # Full DB schema
├── .env.local.example
├── next.config.js
└── package.json
```

---

## Step 1 — Supabase project

1. Go to **https://supabase.com** and create a free account.
2. Click **New project**. Give it a name (e.g. `headroom`), choose a region close to your users, set a strong database password.
3. Wait ~2 minutes for the project to spin up.
4. Go to **SQL Editor** → **New query**.
5. Paste the entire contents of `supabase/migrations/001_initial_schema.sql` and click **Run**.
6. Go to **Project Settings → API**.
   - Copy **Project URL** → this is your `NEXT_PUBLIC_SUPABASE_URL`
   - Copy **anon public** key → this is your `NEXT_PUBLIC_SUPABASE_ANON_KEY`

### Add your first user

Supabase handles passwords for you — you never store them yourself.

1. Go to **Authentication → Users → Add user**.
2. Enter your email and a password. Click **Create user**.
3. Repeat for any colleagues who need access.

That's it — no separate user table needed. Supabase Auth + RLS handles the rest.

---

## Step 2 — Local development

```bash
# 1. Clone / create your project folder
mkdir headroom && cd headroom

# 2. Copy all files from this deployment package into the folder

# 3. Install dependencies
npm install

# 4. Set up environment variables
cp .env.local.example .env.local
# Edit .env.local and fill in your Supabase URL and anon key

# 5. Run locally
npm run dev
# Open http://localhost:3000
# You should see the login page — sign in with the user you created in Step 1
```

---

## Step 3 — Wire up the planner component

Open `src/components/PlannerClient.js`.

At the top of the file, paste the full contents of `resource_capacity_planner.jsx`
**except** the `Root` function at the top (the login gate — you don't need it here,
Supabase handles auth).

Then change the return statement at the bottom to:

```jsx
return <App user={user} onSignOut={handleSignOut} initialData={initialData} />;
```

And update your `App` function signature to accept and use `initialData`:

```jsx
export default function App({ user, onSignOut, initialData }) {
  const [data, setData] = useState(initialData || initData());
  // ...rest unchanged
```

This means on first load the app shows real data from Supabase instead of the
sample data.

---

## Step 4 — Persist changes to Supabase (save/delete functions)

In `src/components/PlannerClient.js`, replace each `setData(...)` mutation
with a Supabase call followed by a `router.refresh()` to re-fetch from the server.

Example — saving a resource:

```js
async function saveResource(res) {
  if (res.id) {
    await supabase.from('resources').update({
      name: res.name,
      skill_group: res.skillGroup,
      division: res.division,
      status: res.status,
      daily_hours: res.dailyHours,
    }).eq('id', res.id);
  } else {
    await supabase.from('resources').insert({
      name: res.name,
      skill_group: res.skillGroup,
      division: res.division,
      status: res.status,
      daily_hours: res.dailyHours,
    });
  }
  router.refresh(); // re-fetches from server and re-renders
  setResourceModal(null);
}
```

Apply the same pattern for projects, scenarios, and allocations.

**Column name mapping** (JS camelCase → Supabase snake_case):

| JS key          | Supabase column   |
|-----------------|-------------------|
| skillGroup      | skill_group       |
| dailyHours      | daily_hours       |
| allocationPct   | allocation_pct    |
| startDate       | start_date        |
| endDate         | end_date          |
| resourceId      | resource_id       |
| projectId       | project_id        |
| scenarioId      | scenario_id       |

---

## Step 5 — Deploy to Vercel

### Option A — Vercel CLI (recommended)

```bash
# Install Vercel CLI
npm i -g vercel

# In your project folder
vercel

# Follow the prompts:
# - Link to your Vercel account (or create one at vercel.com)
# - Framework preset: Next.js (auto-detected)
# - Root directory: ./
# - Build command: npm run build (default)
# - Output directory: .next (default)
```

### Option B — GitHub + Vercel dashboard

1. Push your project to a GitHub repo.
2. Go to **https://vercel.com/new**.
3. Import your GitHub repo.
4. Vercel detects Next.js automatically. Click **Deploy**.

### Add environment variables to Vercel

After import (before or after first deploy):

1. Go to your project on Vercel → **Settings → Environment Variables**.
2. Add:
   - `NEXT_PUBLIC_SUPABASE_URL` = your Supabase project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = your Supabase anon key
3. Set both for **Production**, **Preview**, and **Development**.
4. Redeploy (Vercel → Deployments → Redeploy latest).

### Add your Vercel domain to Supabase

1. In Supabase → **Authentication → URL Configuration**.
2. Set **Site URL** to your Vercel production URL (e.g. `https://headroom.vercel.app`).
3. Add it to **Redirect URLs** too.

---

## Step 6 — Verify everything works

- [ ] `https://headroom.vercel.app` redirects to `/login`
- [ ] Login with your Supabase user works
- [ ] App loads with data from the database
- [ ] Sign out returns to `/login`
- [ ] Adding/editing/removing records persists after page refresh

---

## Ongoing — invite more users

In Supabase → **Authentication → Users → Invite user**
Enter their email. They receive a link to set their own password.

No code changes needed.

---

## Notes

- **Free tiers are sufficient**: Supabase free tier (500 MB, 2 projects) and Vercel hobby tier (unlimited deployments) are both fine for internal team tools.
- **Custom domain**: In Vercel → Settings → Domains, add your own domain if you have one.
- **Real-time updates**: Supabase supports real-time subscriptions. If multiple people edit simultaneously, you can add `supabase.channel(...)` listeners to keep the UI in sync without refreshing.
