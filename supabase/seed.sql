-- Services
insert into services (name, description, owner, team, tier, dependencies) values
  ('api-gateway',     'Public-facing API gateway and rate limiter',           'priya@acme.io',   'Platform',  1, '{"auth-service","user-service"}'),
  ('auth-service',    'Authentication, JWT issuance, and session management', 'marco@acme.io',   'Platform',  1, '{"user-service","postgres-primary"}'),
  ('user-service',    'User profiles, preferences, and account management',   'sara@acme.io',    'Backend',   2, '{"postgres-primary"}'),
  ('billing-service', 'Subscription billing, invoicing, and Stripe sync',     'tom@acme.io',     'Backend',   2, '{"user-service","postgres-primary"}'),
  ('notif-service',   'Email and push notification dispatch',                 'leila@acme.io',   'Backend',   3, '{"user-service"}'),
  ('postgres-primary','Primary PostgreSQL cluster',                           'devops@acme.io',  'Infra',     1, '{}');

-- Incidents
insert into incidents (service_name, title, severity, root_cause, resolution, duration_minutes, occurred_at) values
  ('api-gateway',
   'Elevated 502 error rate — upstream auth timeouts',
   'P1',
   'auth-service connection pool exhausted after a misconfigured deploy raised max_connections from 50 to 5.',
   'Rolled back auth-service to v2.3.1. Increased connection pool limit and added circuit-breaker.',
   47,
   now() - interval '6 days'),

  ('postgres-primary',
   'Replica lag exceeded 30 s, read replicas serving stale data',
   'P1',
   'Vacuum freeze job on the users table held an exclusive lock for 22 minutes during peak traffic.',
   'Killed vacuum job, redirected read traffic to primary while replica caught up. Rescheduled vacuum to 03:00 UTC.',
   91,
   now() - interval '14 days'),

  ('billing-service',
   'Stripe webhook delivery failures — invoices not marked paid',
   'P2',
   'TLS certificate on the /webhooks endpoint expired silently; Stripe retries exhausted within 24 h.',
   'Renewed certificate, replayed failed webhook events via Stripe dashboard, reconciled 38 affected invoices.',
   210,
   now() - interval '21 days'),

  ('notif-service',
   'Bulk email batch stuck — 12 k notifications delayed 4 h',
   'P3',
   'SendGrid API key rotated by security team but notif-service env var not updated.',
   'Updated SENDGRID_API_KEY secret in Vault and restarted service. Batch completed within 8 minutes.',
   245,
   now() - interval '3 days'),

  ('auth-service',
   'JWT signing key rotation caused session invalidation for ~2 % of users',
   'P2',
   'Key rotation script replaced the active key without a grace period, immediately rejecting tokens signed with the old key.',
   'Restored old key alongside new key, implemented dual-key validation with 24 h overlap window.',
   33,
   now() - interval '9 days');

-- Deployments
insert into deployments (service_name, version, deployed_by, description, status, deployed_at) values
  ('auth-service',    'v2.3.2', 'marco@acme.io',  'Fix connection pool config; set max_connections=50',                          'success',     now() - interval '6 days' + interval '2 hours'),
  ('auth-service',    'v2.3.1', 'marco@acme.io',  'Hotfix rollback — revert misconfigured max_connections change',               'rolled_back',  now() - interval '6 days' + interval '30 minutes'),
  ('billing-service', 'v4.1.0', 'tom@acme.io',    'Add idempotency keys to Stripe charge calls; renew webhook TLS cert',        'success',     now() - interval '20 days'),
  ('api-gateway',     'v1.9.5', 'priya@acme.io',  'Upgrade rate-limit library; add circuit-breaker for auth-service calls',     'success',     now() - interval '5 days'),
  ('notif-service',   'v3.0.4', 'leila@acme.io',  'Migrate API key to Vault; add health-check endpoint',                        'success',     now() - interval '2 days'),
  ('user-service',    'v5.2.0', 'sara@acme.io',   'Add soft-delete for accounts; index email column for faster lookups',        'success',     now() - interval '10 days');

-- Runbooks
insert into runbooks (service_name, scenario, steps) values
  ('api-gateway',
   'High 5xx error rate',
   $md$
## High 5xx Error Rate on api-gateway

### 1. Triage
- Check Grafana dashboard `api-gateway / error-rate` for spike shape (gradual vs sudden).
- Run `kubectl logs -n prod -l app=api-gateway --tail=200` and grep for upstream errors.

### 2. Identify upstream
- If errors are 502/504, the upstream service (auth-service or user-service) is likely the cause.
- Check `kubectl get pods -n prod` for any CrashLoopBackOff or pending pods.

### 3. Circuit breaker
- If one upstream is unhealthy, toggle the circuit breaker:
  ```
  kubectl set env deployment/api-gateway CB_AUTH_ENABLED=true -n prod
  ```
- This returns 503 with `Retry-After` instead of cascading 502s.

### 4. Rollback
- If a recent deploy correlates with the spike:
  ```
  kubectl rollout undo deployment/api-gateway -n prod
  ```

### 5. Escalate
- Page the Platform on-call if error rate > 5 % for more than 5 minutes.
$md$),

  ('postgres-primary',
   'High replication lag',
   $md$
## High Replication Lag on postgres-primary

### 1. Check lag
```sql
select client_addr, state, sent_lsn, write_lsn,
       (sent_lsn - write_lsn) as lag_bytes
from pg_stat_replication;
```

### 2. Identify blocker
```sql
select pid, wait_event_type, wait_event, query, now() - pg_stat_activity.query_start as duration
from pg_stat_activity
where state != 'idle'
order by duration desc
limit 10;
```

### 3. Kill blocking query
- If a vacuum or long-running query is blocking:
  ```sql
  select pg_cancel_backend(<pid>);
  -- escalate to pg_terminate_backend if cancel doesn't work
  ```

### 4. Redirect read traffic
- If lag > 10 s and reads are time-sensitive, update the read-replica DSN in app config to point at primary:
  ```
  kubectl set env deployment/user-service DB_READ_HOST=postgres-primary -n prod
  ```

### 5. Recovery
- Monitor `pg_stat_replication` until lag returns to < 1 s before re-enabling replica reads.
$md$),

  ('billing-service',
   'Stripe webhook delivery failures',
   $md$
## Stripe Webhook Delivery Failures

### 1. Confirm in Stripe dashboard
- Go to **Developers → Webhooks → [endpoint]** and check the "Recent deliveries" tab for HTTP errors.

### 2. Check TLS / DNS
```bash
curl -Iv https://api.acme.io/webhooks/stripe 2>&1 | grep -E "SSL|expire|issuer"
```
- If certificate is expired, renew immediately via cert-manager:
  ```
  kubectl annotate cert billing-webhook-cert cert-manager.io/issue-temporary-certificate=true -n prod
  ```

### 3. Replay failed events
- In Stripe dashboard, filter deliveries by status = `failed`, select all, click **Resend**.
- For bulk replay via CLI:
  ```
  stripe events resend <event_id>
  ```

### 4. Reconcile invoices
```sql
select id, stripe_payment_intent_id, status
from invoices
where status = 'pending' and occurred_at < now() - interval '1 hour';
```
- Cross-reference with Stripe's charge status and update manually if needed.

### 5. Post-incident
- Add certificate expiry alert in PagerDuty (threshold: 14 days before expiry).
$md$);

-- Incident Commander services (shared caching layer + payments)
insert into services (name, description, owner, team, tier, dependencies) values
  ('redis-cache',    'Shared caching layer used by multiple services',  'james.park@company.com',  'platform',  1, '{}'),
  ('payments-api',   'Handles payment processing and Stripe integration', 'sarah.chen@company.com', 'payments',  1, '{"auth-service","postgres-primary","redis-cache"}'),
  ('reporting-service', 'Async report generation and PDF export',       'lisa.nguyen@company.com', 'data',      3, '{"postgres-primary","redis-cache"}')
on conflict (name) do nothing;

-- Incident Commander runbooks
insert into runbooks (service_name, scenario, steps) values
  ('redis-cache',
   'memory_spike',
   $md$
## Redis Cache — Memory Spike Runbook

1. **Check memory usage**: `redis-cli info memory | grep used_memory_human`
2. **Identify the writing service** (do this early — do not assume the culprit):
   ```bash
   redis-cli monitor | grep -E "SET|SETEX|HSET|LPUSH|RPUSH" | head -50
   ```
   Cross-reference client IPs: `redis-cli client list`
3. **Find large keys**: `redis-cli --bigkeys`
4. **Act based on culprit service**:
   - **reporting-service**: `kubectl scale deployment/reporting-service --replicas=0 -n data`, then flush: `redis-cli --scan --pattern "report:*" | xargs redis-cli del`
   - **payments-api**: check for recent deploy first (`kubectl rollout history deployment/payments-api -n payments`), rollback if needed, then flush idempotency/pay keys — see payments-api memory_spike runbook
   - **unknown service**: flush the key namespace identified in step 3
5. **Monitor recovery**: Cache hit rate should recover within 5 mins
6. **Escalate to**: james.park@company.com | #platform-oncall

**Note (Feb 21):** Root cause was misattributed to reporting-service twice before redis-cli monitor revealed payments-api as the actual culprit. Always run step 2 before assuming.
$md$),

  ('payments-api',
   'memory_spike',
   $md$
## payments-api — Memory Spike / Redis Flood Runbook

**Owner:** sarah.chen@company.com | **Slack:** #payments-oncall

### 1. Identify the scope
```bash
# Check payments-api pod health
kubectl get pods -n payments -l app=payments-api

# Check current deploy version
kubectl get deployment payments-api -n payments -o jsonpath='{.spec.template.spec.containers[0].image}'
```

### 2. Check for a recent bad deploy (do this first)
```bash
# Cross-reference deploy time with when redis memory spiked
# A deploy that adds new Redis key namespaces is the most likely cause
```
→ If a deploy went out in the past few hours, **go to step 4 immediately**.

### 3. Identify what payments-api is writing to Redis
```bash
redis-cli monitor | grep -E "SET|SETEX|HSET" | grep -v "session:" | head -50
redis-cli --scan --pattern "idempotency:*" | wc -l
redis-cli --scan --pattern "pay:*" | wc -l
redis-cli --scan --pattern "payment:*" | wc -l
```

### 4. If a bad deploy is confirmed — rollback AND flush
```bash
# Step 1: Rollback the deploy
kubectl rollout undo deployment/payments-api -n payments

# Step 2: Verify rollback is running (do not skip)
kubectl rollout status deployment/payments-api -n payments

# Step 3: Flush ALL keys written by the bad version
# ⚠️ The rollback alone is NOT enough — stale keys persist until flushed
redis-cli --scan --pattern "idempotency:*" | xargs redis-cli del
redis-cli --scan --pattern "pay:*" | xargs redis-cli del
```

### 5. Monitor recovery
```bash
# Redis memory should drop within 2 minutes of flush
redis-cli info memory | grep used_memory_human
# Cache hit rate should recover within 5 minutes
```

### 6. Check downstream services
- **auth-service** — session lookups may have degraded; check error rate
- **api-gateway** — rate limiting state may be stale; check for 401/403 spikes

### 7. Escalate if not resolved within 10 minutes
- Page sarah.chen@company.com (payments-api owner)
- Page james.park@company.com (redis-cache / auth-service owner)
- Bridge: #payments-oncall + #platform-oncall

---

**Lessons from Feb 21 incident:**
- A rollback without a key flush left Redis at 98% for 2+ hours
- `redis-cli monitor` is the fastest way to identify the writing service — run it early
- Any deploy that introduces new Redis key namespaces must document those namespaces and include a flush step in the rollback procedure
$md$);
