# Incident Commander

An AI-powered incident response assistant built with [Skybridge](https://docs.skybridge.tech). Drop a service name into Claude and get an instant structured incident brief — probable cause, blast radius, deploy risk, historical patterns, and a draft Slack message — all synthesized from your live infrastructure knowledge base.

## How It Works

When you report an incident, Claude automatically calls all four MCP tools in parallel, then synthesizes the results into a war-room-ready brief:

1. **`get_service_info`** — service catalog lookup: owner, team, tier, and dependency graph
2. **`get_recent_deploys`** — checks for bad deploys in the last 24h that may have caused the issue
3. **`get_recent_incidents`** — surfaces historical failure patterns for the service
4. **`get_runbook`** — retrieves the step-by-step recovery playbook for the failure scenario

Claude's response always includes:
- **Probable cause** — based on deploy history and incident patterns
- **Blast radius** — downstream services at risk from the dependency graph
- **Deploy risk** — flags any deploy in the last 24h
- **Historical pattern** — has this happened before, and how was it resolved?
- **Immediate actions** — top 3 steps from the runbook
- **Draft Slack message** — ready to paste to your team

## Database Schema

Four tables in Supabase, with RLS enabled:

| Table | Purpose |
|---|---|
| `services` | Infrastructure catalog — name, owner, team, tier (1/2/3), dependencies |
| `incidents` | Incident history — severity (P1/P2/P3), root cause, resolution, duration |
| `deployments` | Deploy log — version, status (success/failed/rolled_back), timestamp |
| `runbooks` | Recovery playbooks — Markdown steps keyed by service + scenario |
| `incident_investigations` | Active investigation tracker — records investigation start time per service, persisted across server restarts for accurate duration calculation |

## Prerequisites

### Node.js (v24.13+)

- macOS: `brew install node`
- Linux / other: [nodejs.org/en/download](https://nodejs.org/en/download)

### pnpm

```bash
npm install -g pnpm
```

### Supabase CLI

- macOS: `brew install supabase/tap/supabase`
- Linux / other: [supabase.com/docs/guides/cli/getting-started](https://supabase.com/docs/guides/cli/getting-started)

### Supabase Project

Create a project at [supabase.com/dashboard](https://supabase.com/dashboard). You'll need:

- **Project URL** (`SUPABASE_URL`)
- **Service Role Key** (`SUPABASE_SERVICE_ROLE_KEY`) — found in Settings > API

## Setup

**1. Install dependencies**

```bash
pnpm i
```

**2. Configure environment variables**

```bash
cp .env.example .env
```

Fill in your keys:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
GEMINI_API_KEY=your-gemini-api-key
```

**3. Link your Supabase project and push migrations**

```bash
supabase link
supabase db push
```

This creates the `services`, `incidents`, `deployments`, `runbooks`, and `incident_investigations` tables.

**4. Seed the database**

```bash
supabase db reset --linked
```

Or apply the seed file manually from `supabase/seed.sql` to populate realistic example data.

**5. Start the dev server**

```bash
pnpm dev
```

The server runs at `http://localhost:3000`. Use the Skybridge devtools at [http://localhost:3000](http://localhost:3000) to inspect tool calls.

## Connecting to Claude

Tunnel your local server with [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) to expose the MCP endpoint:

```bash
cloudflared tunnel --url http://localhost:3000
```

Then add your tunnel URL with `/mcp` appended (e.g. `https://xxx.trycloudflare.com/mcp`) as a remote MCP server in Claude settings. 

Local test with claude.ai

```bash
claude mcp remove incident-commander
claude mcp add incident-commander `https://xxx.trycloudflare.com/mcp`
```

## Supabase Commands

```bash
supabase link                        # Link to remote project (run once)
supabase db push                     # Apply migrations to remote DB
supabase db reset --linked           # Reset remote DB (drops all data)
supabase migration new <name>        # Create a new migration file
supabase migration list              # Check migration status
```

Migrations live in `supabase/migrations/`. After editing or adding a migration, run `supabase db push` to apply it.

## Deploy to Production

```bash
pnpm deploy
```

Uses [Alpic](https://alpic.ai/) to deploy. Then add your deployed URL with `/mcp` appended (e.g. `https://your-app-name.alpic.live/mcp`) as a remote MCP server in Claude settings.

## Resources

- [Skybridge Documentation](https://docs.skybridge.tech/)
- [Model Context Protocol Documentation](https://modelcontextprotocol.io/)
- [Alpic Documentation](https://docs.alpic.ai/)
