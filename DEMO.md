# Incident Commander — Demo Guide

**Live MCP endpoint:** `https://incident-commander-l-2e58fd9f.alpic.live/mcp`

## Connect in 30 seconds

1. Open [claude.ai](https://claude.ai) (Pro, Team, or Max account required)
2. Go to **Settings → Integrations → Add MCP server**
3. Paste: `https://incident-commander-l-2e58fd9f.alpic.live/mcp`
4. Start a new conversation — you're live

---

## What to expect

Every time you paste an alert, Claude automatically calls all five investigation tools in parallel before responding:

- `search_incidents` — semantic search across all past incidents
- `get_service_info` — owner, tier, dependency graph
- `get_recent_deploys` — flags bad deploys in the last 24h
- `get_recent_incidents` — historical failure patterns
- `get_runbook` — step-by-step recovery playbook

The response is always a structured war-room brief: severity, probable cause, blast radius, step-by-step fix, rollback option, historical match, and a ready-to-paste Slack message.

---

## Demo scenarios

Work through these in order — they build on each other and show progressively more capability.

---

### 1. Basic incident triage

Paste this alert exactly as-is:

```
ALERT: auth-service error rate spiked to 18% in the last 5 minutes.
Users reporting login failures.
```

**What to look for:**
- Claude identifies the JWT signing key rotation as a historical match
- Blast radius calls out api-gateway and any service behind auth
- Runbook steps appear verbatim from the DB
- Draft Slack message is ready to paste

---

### 2. Semantic search — no exact service name needed

The real power: you don't need to know the service name.

```
Users are complaining that emails aren't being delivered.
Started about 2 hours ago, affects bulk sends.
```

**What to look for:**
- Claude resolves "email delivery" → `notif-service` via vector similarity, no exact name given
- Surfaces the SendGrid API key rotation incident as a historical match
- Gives the exact env var update + restart resolution

---

### 3. Deploy-correlated incident

```
ALERT: payments-api 500 error rate at 12%. Started ~30 minutes ago.
```

**What to look for:**
- Claude spots the v4.2.1 deploy (idempotency key cache) in the deploy history
- Identifies it as the probable root cause before you say anything
- Recommends a rollback to v4.2.0 with the exact kubectl command
- Blast radius flags auth-service and api-gateway as downstream risks

---

### 4. Cross-service blast radius

```
ALERT: redis-cache memory at 98%, cache miss rate elevated across multiple services.
```

**What to look for:**
- Multiple services surfaced in blast radius (auth-service sessions, payments-api, reporting-service)
- Historical pattern match to the Feb 16 reporting-service bulk query incident
- Claude recommends `redis-cli monitor` early to identify the actual writing service — not just assuming reporting-service

---

### 5. Resolution tracking + knowledge base

After scenario 4 resolves, reply:

```
YES
```

**What to look for:**
- Claude calls `save_incident_resolution` and persists the outcome with embedding to Supabase
- Future incidents will now surface this resolution as a historical match
- Reply `NO` instead to see it log a failed attempt — that also gets saved so the team knows what didn't work

---

### 6. Runbook management

```
Show me the runbook for payments-api memory spikes.
```

Then:

```
Add a step to also check for high GC pause times in the payments-api logs
before scaling down.
```

**What to look for:**
- Claude retrieves the runbook drafted during this session
- Offers to update it in the DB so it's available for the next incident

---

### 7. Stretch — plain English, no alert format

Skip the alert format entirely:

```
Something is wrong with the database. Queries are really slow and
some reads seem to be returning stale data.
```

**What to look for:**
- Semantic search resolves to `postgres-main` (replica lag scenario)
- Surfaces the vacuum freeze lock incident from the history
- Full runbook with the `pg_stat_replication` query and read-redirect steps

---

## Under the hood

| Feature | Implementation |
|---|---|
| Semantic service resolution | Gemini `gemini-embedding-001`, 768-dim vectors, HNSW index in pgvector |
| Plain-English incident search | `match_incidents` RPC, cosine similarity, 0.4 threshold |
| Persistent knowledge base | Every resolved incident is embedded and inserted — the system gets smarter with use |
| Restart-safe timing | Incident start times persisted in the `incident_investigations` table in Supabase (not in-memory), so duration tracking survives server restarts |
| Failed resolution tracking | `worked: false` incidents are saved too — teams can see what didn't work |
| Deploy correlation | Automatic 24h deploy window check on every investigation |

---

## Data in the DB

Six services with realistic dependency graphs:

```
api-gateway (T1) → auth-service (T1) → redis-cache (T1)
                                     → postgres-main (T1)
payments-api (T1) → auth-service, postgres-main, redis-cache
reporting-service (T3) → postgres-main, redis-cache
notif-service (T3)
```

Pre-loaded incidents: auth JWT rotation, payments bad deploy, redis memory spikes (×3), postgres replica lag, Stripe webhook TLS expiry, bulk email SendGrid key rotation.
