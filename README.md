# Restaurant Ratings

A Next.js + Supabase site for tracking restaurant ratings. Public pages are read-only; edits happen behind a password-protected `/admin`.

## Stack

- **Next.js 15** (App Router, TypeScript, Tailwind v4)
- **Postgres** via **Supabase** (hosted, free tier)
- **Vercel** for hosting

## Project structure

```
.
├── app/                       # Next.js App Router pages
│   ├── page.tsx               # Homepage — filterable/sortable table
│   ├── restaurant/[id]/       # Single restaurant detail
│   ├── city/[city]/           # All restaurants in a city
│   ├── cuisine/[cuisine]/     # All restaurants of a cuisine
│   └── admin/                 # Password-gated CRUD
├── lib/                       # Shared helpers (Supabase client, auth, utils, types)
├── db/schema.sql              # Postgres schema — run once in Supabase
├── scripts/import.ts          # One-shot CSV import
└── data/restaurants-4-21.csv  # Source data
```

---

## First-time setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create a Supabase project

1. Sign up at <https://supabase.com> (free tier is plenty)
2. Click **New project** → give it a name, set a database password, pick a region close to you
3. Wait ~1 minute for the project to provision
4. In the project, go to **Project Settings → API Keys** and copy:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL` (form: `https://<project-ref>.supabase.co`)
   - **Publishable** key (`sb_publishable_…`) → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - **Secret** key (`sb_secret_…`) → `SUPABASE_SECRET_KEY` (keep this secret — it bypasses all security)

### 3. Apply the schema

1. In Supabase, open **SQL Editor** → **New query**
2. Paste the contents of `db/schema.sql` and click **Run**
3. You should see the `restaurants` table under **Table Editor**

### 4. Fill in environment variables

```bash
cp .env.example .env.local
```

Then open `.env.local` and fill in the four values:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`
- `ADMIN_PASSWORD` — pick a long random string (this is what you'll type at `/admin/login`)

### 5. Import the CSV

```bash
npm run db:import
```

You should see something like `inserted 220/220` at the end. Data-quality fixes are applied automatically (e.g. `Monetey` → `Monterey`, trailing whitespace trimmed, stray quotes stripped).

If you add more rows to the CSV later, just re-run `npm run db:import` — it truncates and reloads, so no duplicates.

### 6. Run locally

```bash
npm run dev
```

Visit:
- <http://localhost:3000> — the public site
- <http://localhost:3000/admin> — will redirect to `/admin/login` the first time

---

## Deploying to Vercel

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
# Create an empty repo on github.com first, then:
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

### 2. Import to Vercel

1. Sign up at <https://vercel.com> (free tier works)
2. Click **Add New → Project** → pick your GitHub repo
3. Vercel auto-detects Next.js — leave the defaults
4. Before deploying, click **Environment Variables** and add all four from `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SECRET_KEY`
   - `ADMIN_PASSWORD`
5. Click **Deploy**

In about a minute you'll have a live URL like `<repo-name>.vercel.app`. Every future `git push` to `main` auto-deploys.

---

## How it works

### Public reads vs. admin writes

Public pages use the Supabase **publishable** key via `getSupabase()`. Row Level Security is enabled on the `restaurants` table with a policy that allows `SELECT` for everyone — so anonymous reads succeed and writes are blocked at the database level.

Admin writes use the Supabase **secret** key via `getServiceClient()`, called only from server actions in `app/admin/actions.ts`. Every admin action first runs `assertAdmin()`, which checks for a valid session cookie. The cookie holds a SHA-256 hash of `ADMIN_PASSWORD`, set on successful login via `/admin/login`.

### Data flow

```
CSV ──┐
       ├── scripts/import.ts ──► Supabase Postgres
Admin ─┘                          │
                                  ▼
                           Supabase JS client
                                  │
                   ┌──────────────┴──────────────┐
                   ▼                             ▼
           public pages (publishable)    admin pages (secret key)
```

### Rating colours

In `lib/utils.ts`, `ratingColorClass()` maps scores to Tailwind colours (emerald for 9+, lime for 7–8, amber/orange for 5–7, red for <5). Tweak the thresholds to taste.

---

## Common tasks

**Change the admin password:** edit `ADMIN_PASSWORD` in `.env.local` locally and in Vercel's env vars, then redeploy. All existing sessions become invalid.

**Re-import after editing the CSV:** `npm run db:import`. It's destructive — it clears the table first.

**Add a custom domain:** In Vercel → your project → **Domains**. Vercel walks you through the DNS records.

**Back up your data:** Supabase dashboard → **Database** → **Backups**. Free tier has daily backups for 7 days.
