# Personal Site

A Next.js + Supabase personal site with two main features: a restaurant journal and a stocks/options tracker synced from Tradier.

## Stack

- **Next.js 15** (App Router, TypeScript, Tailwind v4)
- **Postgres** via **Supabase** (hosted, free tier)
- **Tradier** brokerage API (prod + sandbox)
- **Vercel** for hosting

## Project structure

```
.
├── app/
│   ├── page.tsx                   # Homepage — restaurant + stocks summary
│   ├── restaurants/               # Filterable/sortable restaurant table
│   ├── restaurant/[id]/           # Single restaurant detail page
│   ├── city/[city]/               # All restaurants in a city
│   ├── cuisine/[cuisine]/         # All restaurants of a cuisine
│   ├── stonks/                    # Options positions + per-ticker P/L dashboard
│   ├── admin/                     # Password-gated CRUD
│   │   ├── restaurants/           # Restaurant list with edit/delete
│   │   ├── stonks/                # Sync trades from Tradier
│   │   ├── [id]/edit/             # Edit a restaurant
│   │   └── new/                   # Add a restaurant
│   └── api/
│       └── options/
│           ├── sync/              # POST — pull trades from Tradier into Supabase
│           └── export/            # GET — download trades as CSV
├── components/
│   ├── options-table.tsx          # Per-ticker positions table with P/L
│   ├── restaurants-table.tsx      # Filterable restaurant table
│   ├── source-picker.tsx          # Prod/sandbox switcher
│   └── sync-trades-button.tsx     # Admin button to trigger a Tradier sync
├── lib/
│   ├── assignment.ts              # Heuristic: link assigned options to equity trades
│   ├── pnl.ts                     # Per-ticker realized P/L (equity + options)
│   ├── positions.ts               # Build OptionsPosition records from raw trades
│   ├── quotes.ts                  # Fetch live equity + option prices from Tradier
│   ├── tradier.ts                 # Tradier API client (prod + sandbox)
│   ├── auth.ts                    # Admin session / assertAdmin()
│   ├── supabase.ts                # Supabase client helpers
│   ├── types.ts                   # Shared TypeScript types
│   └── utils.ts                   # Formatting + rating colour helpers
├── db/
│   ├── schema.sql                 # Restaurants table — run first
│   └── options_schema.sql         # options_trades + equity_trades tables
├── scripts/
│   ├── import.ts                  # One-shot CSV import for restaurants
│   └── pnl-test.ts                # Manual P/L sanity-check script
└── data/restaurants-4-21.csv      # Source data for import
```

---

## Features

### Restaurant journal

- Filterable, sortable table of every restaurant visited, with overall, food, value, service, and ambiance scores
- Per-restaurant detail pages, and index pages by city and cuisine
- Ratings colour-coded from red → emerald based on score
- Admin CRUD: add, edit, delete restaurants behind a password-gated `/admin`

### Stocks & options tracker (`/stonks`)

- Syncs options and equity orders from Tradier (production or sandbox) into Supabase via a POST to `/api/options/sync`
- Builds `OptionsPosition` records by pairing open/close trades for each contract cycle; statuses: `open`, `closed`, `expired`, `assigned`
- Heuristically links assigned options to equity settlement trades (`lib/assignment.ts`)
- Computes per-ticker realized P/L across equity sells and closed/expired/assigned options (`lib/pnl.ts`)
- Fetches live equity and option prices from Tradier to show unrealized P/L for open positions
- Tracks capital tied up: equity cost basis + cash-secured put collateral
- CSV export of all trades via `/api/options/export`
- Prod/sandbox switcher — sandbox trades are kept separate end-to-end

---

## First-time setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create a Supabase project

1. Sign up at <https://supabase.com> (free tier is plenty)
2. Click **New project** → give it a name, set a database password, pick a region
3. Wait ~1 minute for the project to provision
4. Go to **Project Settings → API Keys** and copy:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **Publishable** key → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - **Secret** key → `SUPABASE_SECRET_KEY` (keep this secret — it bypasses RLS)

### 3. Apply the schema

In Supabase **SQL Editor**, run these two files in order:

1. `db/schema.sql` — creates the `restaurants` table
2. `db/options_schema.sql` — creates `options_trades` and `equity_trades`

### 4. Fill in environment variables

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in all values:

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (safe for browser) |
| `SUPABASE_SECRET_KEY` | Supabase secret key (server-side only) |
| `ADMIN_PASSWORD` | Password for `/admin` — pick something long and random |
| `TRADIER_API_KEY` | Tradier production API token |
| `TRADIER_ACCOUNT_ID` | Tradier production account number |
| `TRADIER_SANDBOX_KEY` | Tradier sandbox API token |
| `TRADIER_SANDBOX_ACCOUNT` | Tradier sandbox account number |

Tradier tokens are available at tradier.com/user/api.

### 5. Import restaurant data (optional)

```bash
npm run db:import
```

Inserts rows from `data/restaurants-4-21.csv`. Re-running truncates and reloads, so no duplicates.

### 6. Run locally

```bash
npm run dev
```

- <http://localhost:3000> — public site
- <http://localhost:3000/stonks> — stocks/options dashboard
- <http://localhost:3000/admin> — redirects to `/admin/login` on first visit

---

## Deploying to Vercel

1. Push to GitHub
2. Import the repo at <https://vercel.com> — it auto-detects Next.js
3. Add all environment variables from `.env.local` in Vercel's **Environment Variables** settings
4. Deploy — every future push to `main` auto-deploys

---

## How it works

### Auth

Public pages use the Supabase **publishable** key (`getSupabase()`). RLS allows `SELECT` for everyone and blocks all writes at the database level.

Admin pages use the Supabase **secret** key (`getServiceClient()`), called only from server actions in `app/admin/actions.ts`. Every admin action runs `assertAdmin()`, which checks for a valid session cookie containing a SHA-256 hash of `ADMIN_PASSWORD`.

### Tradier sync

`POST /api/options/sync?sandbox=true|false` pulls the full order history from Tradier and upserts into `options_trades` and `equity_trades` in Supabase. The `source` column (`prod` / `sandbox`) keeps the two environments separate. The admin `/admin/stonks` page has a button that triggers the sync.

### P/L calculation

`lib/positions.ts` pairs `sell_to_open` and `buy_to_close` trades (and buy/sell for long options) into `OptionsPosition` records. `lib/pnl.ts` then rolls equity buys/sells (average cost method) and closed option positions into a `TickerPnL` per ticker. When live quotes are available, unrealized P/L is layered on top.

### Common tasks

**Change the admin password:** update `ADMIN_PASSWORD` in `.env.local` and in Vercel env vars, then redeploy. Existing sessions are immediately invalidated.

**Re-sync trades:** hit the sync button at `/admin/stonks`, or `POST /api/options/sync` directly.

**Re-import restaurants after editing the CSV:** `npm run db:import` — this truncates the table first.

**Add a custom domain:** Vercel → your project → **Domains**.

**Back up your data:** Supabase dashboard → **Database** → **Backups** (daily backups, 7-day retention on free tier).
