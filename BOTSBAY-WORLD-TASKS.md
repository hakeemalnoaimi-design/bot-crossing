# BotsBay World: agent task list

You are working inside a fork of `jarrenrocks/bot-crossing` (MIT). Goal: turn it into
**BotsBay World**, a live island map of every AI agent working for BotsBay.

Environment: Windows 11, VS Code, Node 20+, self-hosted n8n, Supabase, Vercel.

## Ground rules

- Read `.claude/skills/agent-session-world/` and `server/harnesses/README.md` before writing code.
- Do all data work before any visual work.
- New data sources go in `server/harnesses/` only. Never edit `src/` to support a source.
- Keep the server bound to `127.0.0.1` and keep the Host and Origin checks intact.
- Secrets live in `.env` only. Never in anything the browser downloads.
- After each task, run it, show me what changed, and stop for my confirmation.

---

## Task 1: make it run on Windows

The upstream project is macOS-only in one place: it shells out to `open(1)`.

1. Add an opener helper: Windows `cmd /c start "" <target>`, macOS `open`, Linux `xdg-open`.
   Use it everywhere `server/api.mjs` opens a URL, a folder or a deep link.
2. Check `server/harnesses/claude-code.mjs` for path handling. Use `path.join` and
   `os.homedir()`. Claude Code on Windows keeps sessions under `%USERPROFILE%\.claude`.
3. Run `npm install && npm run dev`, then confirm `/api/threads` returns my real threads.

Done when: my open Claude Code threads appear as buildings within one poll.

---

## Task 2: Bahrain world preset

Find where Luna, Mars and Terra are defined in `src/world/`. Add a fourth preset `Bahrain`
and make it the default (Tab still cycles):

- ground: pale sand `#E8D5A8`, light dune displacement
- water and horizon: shallow turquoise `#2BB5AE`, deep Gulf blue `#0B1F3A` at night
- sky: warm haze at noon, orange dusk, indigo night
- scatter: Terra's tree and bush models, tinted palm green, sparse
- buildings: keep the kit, default accent swatch pearl white

---

## Task 3: automatic day and night

Add a setting **Follow local clock**, default on. Derive time of day from the current time in
`Asia/Bahrain` via `Intl.DateTimeFormat`. Map: 05:30 dawn, 12:00 noon, 17:45 dusk, 19:30 night.
Update once a minute. Pressing `L` or dragging the scrubber turns the setting off until I
re-enable it in Settings.

---

## Task 4: n8n adapter (the important one)

Create `server/harnesses/n8n.mjs` and register it in `server/harnesses/index.mjs`.

`.env`:

```
N8N_BASE_URL=https://n8n.botsbay.app
N8N_API_KEY=...
N8N_POLL_SECONDS=15
```

Behaviour:

- Poll `GET /api/v1/workflows?limit=250` and `GET /api/v1/executions?limit=250` with the
  `X-N8N-API-KEY` header. Verify the real field names against my running instance and adjust.
- One thread per workflow. `zone` = the workflow's first tag (client name), fallback `Internal`.
  `title` = workflow name. `id` = `n8n:<workflowId>`.
- Status from the newest execution:

  | n8n | colony |
  |---|---|
  | running | hammering |
  | error, crashed | slumped, `!` badge |
  | waiting | `?` badge |
  | success under 1 hour old | cheering |
  | success older | pottering |
  | workflow inactive, or nothing for 3 days | sitting, asleep |

- **Open** deep-links to `<base>/workflow/<id>/executions/<execId>`.
- **Retry** appears only for a failed last execution and POSTs
  `/api/v1/executions/<execId>/retry`.
- **Archive** hides the thread in `data/colony.json`. Never write to n8n.

Done when: every active workflow is a building in its client's zone, a forced failure shows the
`!` badge, Retry works, and the API key appears nowhere in the browser Network tab.

---

## Task 5: hosted mode (only after Task 4 passes)

Supabase, existing AutoFlow project, new schema `world`:

```sql
create schema if not exists world;

create table world.agent_status (
  agent_id      text primary key,
  source        text not null,
  zone          text not null,
  title         text not null,
  status        text not null check (status in ('running','error','waiting','merged','idle','asleep')),
  last_activity timestamptz not null default now(),
  open_url      text,
  demo_slug     text
);

alter publication supabase_realtime add table world.agent_status;
alter table world.agent_status enable row level security;

create policy "team read" on world.agent_status
  for select to authenticated using (true);

create policy "demo read" on world.agent_status
  for select to anon
  using (demo_slug = current_setting('request.headers', true)::json->>'x-demo-slug');
```

Then:

1. Add `server/harnesses/supabase.mjs` reading `world.agent_status` in the standard thread shape.
2. Add a build mode `hosted`: the browser reads Supabase directly with `supabase-js` and the anon
   key, subscribing to realtime changes, with no Node API in the loop.
3. Routes: `/` shows everything and requires login. `/demo/<slug>` sets the `x-demo-slug` header
   and shows only that client's rows.
4. Build for Vercel: framework Vite, output `dist/`. Env vars `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`, `VITE_MODE=hosted`. Domain `world.botsbay.app`.

I will build the n8n side myself: one sub-workflow that upserts a row per agent, called at the
start and end of each production workflow plus from an Error Trigger.
