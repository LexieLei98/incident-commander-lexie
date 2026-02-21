import cors from "cors";
import express from "express";
import { z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { widgetsDevServer } from "skybridge/server";
import { mcp } from "./middleware.js";
import server from "./server.js";
import { supabase } from "./supabase.js";
import { env } from "./env.js";

const app = express();

app.use(express.json());

const nodeEnv = process.env.NODE_ENV || "development";

if (nodeEnv !== "production") {
  const { devtoolsStaticServer } = await import("@skybridge/devtools");
  app.use(await devtoolsStaticServer());
  app.use(await widgetsDevServer());
}

// Fix 12 — CORS restricted in production using ALLOWED_ORIGIN env var
if (nodeEnv === "production") {
  app.use(
    "/assets",
    cors(
      env.ALLOWED_ORIGIN ? { origin: env.ALLOWED_ORIGIN } : {}
    )
  );
  app.use("/assets", express.static("dist/assets"));
}

app.use(
  cors(
    nodeEnv === "production" && env.ALLOWED_ORIGIN
      ? { origin: env.ALLOWED_ORIGIN }
      : {}
  )
);
app.use(mcp(server));

app.listen(3000, () => {
  console.log("Server listening on http://localhost:3000");
});

// ─── Embedding helper ─────────────────────────────────────────────────────────
// Uses Gemini gemini-embedding-001 (768 dimensions) via the official SDK

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });

// Fix 7 — pass outputDimensionality: 768 natively, no .slice()
// Fix 8 — retry up to 3 times with exponential backoff
async function embedText(text: string): Promise<number[]> {
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await embeddingModel.embedContent({
        content: { parts: [{ text }], role: "user" },
        outputDimensionality: 768,
      } as Parameters<typeof embeddingModel.embedContent>[0]);
      return result.embedding.values;
    } catch (err) {
      if (attempt === maxAttempts - 1) {
        throw err;
      }
      const backoffMs = 500 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  // Unreachable, but TypeScript needs a return
  throw new Error("embedText: exceeded max attempts");
}

// ─── Chunk-parallel helper ─────────────────────────────────────────────────────
// Fix 9 — process items in parallel batches instead of sequentially
async function processInChunks<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

// ─── Startup backfill ─────────────────────────────────────────────────────────
// Generates and stores embeddings for any rows that don't have one yet.
// Runs once at startup; safe to re-run (skips already-embedded rows).

async function ensureEmbeddings() {
  // Services — Fix 9: parallel chunks
  const { data: services } = await supabase
    .from("services")
    .select("id, name, description, owner, team, tier, dependencies")
    .is("embedding", null);

  await processInChunks(services ?? [], 5, async (svc) => {
    const text = [
      `${svc.name}: ${svc.description}`,
      `Team: ${svc.team}`,
      `Owner: ${svc.owner}`,
      `Tier: ${svc.tier}`,
      `Dependencies: ${(svc.dependencies as string[] ?? []).join(", ") || "none"}`,
    ].join(". ");
    const embedding = await embedText(text);
    await supabase.from("services").update({ embedding }).eq("id", svc.id);
    console.log(`[embeddings] seeded service: ${svc.name}`);
  });

  // Incidents — Fix 9: parallel chunks
  const { data: incidents } = await supabase
    .from("incidents")
    .select("id, service_name, title, severity, root_cause, resolution")
    .is("embedding", null);

  await processInChunks(incidents ?? [], 5, async (inc) => {
    const text = [
      inc.title,
      `Service: ${inc.service_name}`,
      `Severity: ${inc.severity}`,
      `Root cause: ${inc.root_cause}`,
      `Resolution: ${inc.resolution}`,
    ].join(". ");
    const embedding = await embedText(text);
    await supabase.from("incidents").update({ embedding }).eq("id", inc.id);
    console.log(`[embeddings] seeded incident: ${inc.title}`);
  });
}

ensureEmbeddings().catch((err) =>
  console.error("[embeddings] backfill failed:", err)
);

// ─── Incident start time tracker ──────────────────────────────────────────────
// Fix 10 — persist start times in Supabase instead of in-memory Map so they
// survive server restarts.

async function recordIncidentStart(service_name: string) {
  // Only insert if no row already exists (upsert ignores conflict on PK)
  await supabase
    .from("incident_investigations")
    .upsert({ service_name, started_at: new Date().toISOString() }, { onConflict: "service_name", ignoreDuplicates: true });
}

async function getIncidentStart(service_name: string): Promise<number | null> {
  const { data } = await supabase
    .from("incident_investigations")
    .select("started_at")
    .eq("service_name", service_name)
    .maybeSingle();
  if (!data) return null;
  return new Date(data.started_at).getTime();
}

async function deleteIncidentStart(service_name: string) {
  await supabase
    .from("incident_investigations")
    .delete()
    .eq("service_name", service_name);
}

// ─── Shared vector-resolve helper ─────────────────────────────────────────────
// Fix 6 — apply a 0.4 similarity threshold after match_services calls.
// Returns the canonical service name or null if nothing passes the threshold.
async function resolveServiceName(query: string): Promise<string | null> {
  const embedding = await embedText(query);
  const { data: services } = await supabase.rpc("match_services", {
    query_embedding: embedding,
    match_count: 1,
  });

  const top = (services as { name: string; similarity: number }[] | null)?.[0];
  if (!top || top.similarity < 0.4) {
    return null;
  }
  return top.name;
}

// ─── TOOL 1: Get service metadata ─────────────────────────────────────────────
server.registerTool(
  "get_service_info",
  {
    description: "Look up a service in the infrastructure catalogue — accepts plain-English descriptions like 'the thing that handles login' and uses semantic search to find the right service",
    inputSchema: {
      service_name: z.string().describe(
        "Name or plain-English description of the service, e.g. 'auth service', 'payment processing', 'the login system'"
      ),
    },
  },
  async ({ service_name }) => {
    const embedding = await embedText(service_name);
    const { data, error } = await supabase.rpc("match_services", {
      query_embedding: embedding,
      match_count: 3,
    });

    // Fix 6 — threshold filter
    const results = (data as { name: string; similarity: number }[] | null)?.filter(
      (r) => r.similarity >= 0.4
    ) ?? [];

    if (error || !results.length) {
      return {
        content: [{ type: "text", text: `No service found matching "${service_name}"` }],
      };
    }

    // Fix 2 — record start time with the canonical (resolved) name
    await recordIncidentStart(results[0].name);

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

// ─── TOOL 2: Get recent incidents ─────────────────────────────────────────────
server.registerTool(
  "get_recent_incidents",
  {
    description: "Fetch historical incidents for a service — describe the service in plain English and semantic search resolves the exact service name before querying",
    inputSchema: {
      service_name: z.string().describe("Name or plain-English description of the service"),
      limit: z.number().optional().default(5).describe("How many recent incidents to return"),
    },
  },
  async ({ service_name, limit }) => {
    // Fix 3 — resolve canonical name via vector search
    // Fix 6 — 0.4 threshold applied inside resolveServiceName
    const resolvedName = await resolveServiceName(service_name);

    if (!resolvedName) {
      return {
        content: [{ type: "text", text: `No service found matching "${service_name}"` }],
      };
    }

    // Fix 2 — use resolved name for start-time tracking
    await recordIncidentStart(resolvedName);

    const { data, error } = await supabase
      .from("incidents")
      .select("*")
      .eq("service_name", resolvedName)
      .order("occurred_at", { ascending: false })
      .limit(limit);

    if (error || !data?.length) {
      return {
        content: [{ type: "text", text: `No incident history found for "${service_name}"` }],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ─── TOOL 3: Get recent deployments ───────────────────────────────────────────
server.registerTool(
  "get_recent_deploys",
  {
    description: "Check recent deployments for a service — critical for identifying if a bad deploy caused the incident",
    inputSchema: {
      service_name: z.string().describe("Name of the service"),
      hours: z.number().optional().default(24).describe("Look back window in hours"),
    },
  },
  async ({ service_name, hours }) => {
    // Fix 3 — resolve canonical name via vector search instead of ilike
    // Fix 6 — 0.4 threshold applied inside resolveServiceName
    const resolvedName = await resolveServiceName(service_name);

    if (!resolvedName) {
      return {
        content: [
          {
            type: "text",
            text: `No service found matching "${service_name}"`,
          },
        ],
      };
    }

    // Fix 2 — use resolved name for start-time tracking
    await recordIncidentStart(resolvedName);

    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("deployments")
      .select("*")
      .eq("service_name", resolvedName)
      .gte("deployed_at", since)
      .order("deployed_at", { ascending: false });

    if (error || !data?.length) {
      return {
        content: [
          {
            type: "text",
            text: `No recent deploys found for "${service_name}" in the last ${hours}h`,
          },
        ],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ─── TOOL 4: Get runbook ───────────────────────────────────────────────────────
server.registerTool(
  "get_runbook",
  {
    description: "Fetch the step-by-step runbook for a service and failure scenario",
    inputSchema: {
      service_name: z.string().describe("Name of the service"),
      scenario: z
        .string()
        .optional()
        .describe(
          "Failure scenario e.g. 'high_error_rate', 'memory_spike', 'login_failures'"
        ),
    },
  },
  async ({ service_name, scenario }) => {
    // Fix 3 — resolve canonical name via vector search instead of ilike
    // Fix 6 — 0.4 threshold applied inside resolveServiceName
    const resolvedName = await resolveServiceName(service_name);

    if (!resolvedName) {
      return {
        content: [
          {
            type: "text",
            text: `No service found matching "${service_name}"`,
          },
        ],
      };
    }

    // Fix 2 — use resolved name for start-time tracking
    await recordIncidentStart(resolvedName);

    // Service name resolved via vector search; scenario still uses ilike
    let query = supabase
      .from("runbooks")
      .select("*")
      .eq("service_name", resolvedName);

    if (scenario) {
      query = query.ilike("scenario", `%${scenario}%`);
    }

    const { data, error } = await query.limit(2);

    if (error || !data?.length) {
      return {
        content: [
          {
            type: "text",
            text: `No runbook found for "${service_name}"${scenario ? ` / ${scenario}` : ""}`,
          },
        ],
      };
    }
    return {
      content: [{ type: "text", text: data.map((r) => r.steps).join("\n\n---\n\n") }],
    };
  }
);

// ─── TOOL 5: Semantic incident search ─────────────────────────────────────────
server.registerTool(
  "search_incidents",
  {
    description: "Semantically search all historical incidents by describing a problem in plain English — finds similar past failures across all services without needing to know exact service names",
    inputSchema: {
      problem_description: z.string().describe(
        "Plain-English description of the current problem, e.g. 'users cannot log in', 'checkout is failing', 'database queries are slow', 'emails not being sent'"
      ),
      limit: z.number().optional().default(5).describe("How many similar past incidents to return"),
    },
  },
  async ({ problem_description, limit }) => {
    const embedding = await embedText(problem_description);
    const { data, error } = await supabase.rpc("match_incidents", {
      query_embedding: embedding,
      match_count: limit,
    });

    // Fix 6 — apply similarity threshold
    const results = (data as { similarity: number }[] | null)?.filter(
      (r) => r.similarity >= 0.4
    ) ?? [];

    if (error || !results.length) {
      return {
        content: [
          {
            type: "text",
            text: `No similar incidents found for: "${problem_description}"`,
          },
        ],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

// ─── TOOL 6: Get all active incidents (last 24h, all services) ────────────────
server.registerTool(
  "get_all_active_incidents",
  {
    description: "Return all incidents that occurred in the last 24 hours across every service, ordered by severity (P1 first) then most-recent first. Use this to get a broad view of what is currently on fire.",
    inputSchema: {},
  },
  async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("incidents")
      .select("*")
      .gte("occurred_at", since);

    if (error) {
      return {
        content: [{ type: "text", text: `Failed to fetch active incidents: ${error.message}` }],
      };
    }

    if (!data?.length) {
      return {
        content: [{ type: "text", text: "No incidents in the last 24 hours." }],
      };
    }

    const severityRank: Record<string, number> = { P1: 0, P2: 1, P3: 2 };
    const sorted = data.sort((a, b) => {
      const rankDiff = (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9);
      if (rankDiff !== 0) return rankDiff;
      return new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime();
    });

    return { content: [{ type: "text", text: JSON.stringify(sorted, null, 2) }] };
  }
);

// ─── TOOL 7: Save incident resolution back to the knowledge base ───────────────
server.registerTool(
  "save_incident_resolution",
  {
    description: "Save a resolved incident back to the knowledge base for future reference",
    inputSchema: {
      service_name: z.string().describe("Name of the affected service"),
      title: z.string().describe("Short incident title"),
      severity: z.enum(["P1", "P2", "P3"]).describe("Incident severity"),
      root_cause: z.string().describe("What caused the incident"),
      resolution: z.string().describe("What steps fixed it"),
      worked: z.boolean().describe("Whether the fix actually resolved the incident"),
    },
  },
  async ({ service_name, title, severity, root_cause, resolution, worked }) => {
    // Fix 4 — resolve canonical service name before inserting (avoids FK errors)
    const resolvedName = await resolveServiceName(service_name);
    const canonicalName = resolvedName ?? service_name;

    // Fix 10 — retrieve start time from Supabase, then clean up
    const startTime = await getIncidentStart(canonicalName);
    const duration_minutes = startTime
      ? Math.round((Date.now() - startTime) / 60_000)
      : null;
    await deleteIncidentStart(canonicalName);

    // Fix 1 — always embed and insert regardless of whether worked is true or false
    const embeddingText = [
      title,
      `Service: ${canonicalName}`,
      `Severity: ${severity}`,
      `Root cause: ${root_cause}`,
      `Resolution: ${resolution}`,
    ].join(". ");
    const embedding = await embedText(embeddingText);

    const { error } = await supabase
      .from("incidents")
      .insert({
        service_name: canonicalName,
        title,
        severity,
        root_cause,
        resolution,
        worked,
        duration_minutes,
        occurred_at: new Date().toISOString(),
        embedding,
      });

    if (error) {
      return {
        content: [{
          type: "text",
          text: `Failed to save resolution: ${error.message}`
        }]
      };
    }

    // Fix 1 — conditional success message based on worked
    const message = worked
      ? `Saved to knowledge base. Next time ${canonicalName} has a similar incident, I'll reference this resolution automatically.`
      : `Logged failed resolution attempt for ${canonicalName} so the team knows this approach didn't work.`;

    return {
      content: [{
        type: "text",
        text: message
      }]
    };
  }
);
