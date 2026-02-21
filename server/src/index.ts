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

if (nodeEnv === "production") {
  app.use("/assets", cors());
  app.use("/assets", express.static("dist/assets"));
}

app.use(cors());
app.use(mcp(server));

app.listen(3000, () => {
  console.log("Server listening on http://localhost:3000");
});

// ─── Embedding helper ─────────────────────────────────────────────────────────
// Uses Gemini text-embedding-004 (768 dimensions) via the official SDK

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });

async function embedText(text: string): Promise<number[]> {
  const result = await embeddingModel.embedContent(text);
  return result.embedding.values.slice(0, 768);
}

// ─── Startup backfill ─────────────────────────────────────────────────────────
// Generates and stores embeddings for any rows that don't have one yet.
// Runs once at startup; safe to re-run (skips already-embedded rows).

async function ensureEmbeddings() {
  // Services
  const { data: services } = await supabase
    .from("services")
    .select("id, name, description, owner, team, tier, dependencies")
    .is("embedding", null);

  for (const svc of services ?? []) {
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
  }

  // Incidents
  const { data: incidents } = await supabase
    .from("incidents")
    .select("id, service_name, title, severity, root_cause, resolution")
    .is("embedding", null);

  for (const inc of incidents ?? []) {
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
  }
}

ensureEmbeddings().catch((err) =>
  console.error("[embeddings] backfill failed:", err)
);

// ─── Incident start time tracker ──────────────────────────────────────────────
// Records the timestamp of the first tool call per service so save_incident_resolution
// can auto-calculate duration_minutes without the LLM needing to track time.
const incidentStartTimes = new Map<string, number>();

function recordIncidentStart(service_name: string) {
  if (!incidentStartTimes.has(service_name)) {
    incidentStartTimes.set(service_name, Date.now());
  }
}

// ─── TOOL 1: Get service metadata ─────────────────────────────────────────────
server.tool(
  "get_service_info",
  "Look up a service in the infrastructure catalogue — accepts plain-English descriptions like 'the thing that handles login' and uses semantic search to find the right service",
  {
    service_name: z.string().describe(
      "Name or plain-English description of the service, e.g. 'auth service', 'payment processing', 'the login system'"
    ),
  },
  async ({ service_name }) => {
    recordIncidentStart(service_name);
    const embedding = await embedText(service_name);
    const { data, error } = await supabase.rpc("match_services", {
      query_embedding: embedding,
      match_count: 3,
    });

    if (error || !data?.length) {
      return {
        content: [{ type: "text", text: `No service found matching "${service_name}"` }],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ─── TOOL 2: Get recent incidents ─────────────────────────────────────────────
server.tool(
  "get_recent_incidents",
  "Fetch historical incidents for a service — describe the service in plain English and semantic search resolves the exact service name before querying",
  {
    service_name: z.string().describe("Name or plain-English description of the service"),
    limit: z.number().optional().default(5).describe("How many recent incidents to return"),
  },
  async ({ service_name, limit }) => {
    recordIncidentStart(service_name);
    // Semantically resolve the service name to an exact DB value
    const embedding = await embedText(service_name);
    const { data: services } = await supabase.rpc("match_services", {
      query_embedding: embedding,
      match_count: 1,
    });

    const exactName = (services as { name: string }[] | null)?.[0]?.name ?? service_name;

    const { data, error } = await supabase
      .from("incidents")
      .select("*")
      .eq("service_name", exactName)
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
server.tool(
  "get_recent_deploys",
  "Check recent deployments for a service — critical for identifying if a bad deploy caused the incident",
  {
    service_name: z.string().describe("Name of the service"),
    hours: z.number().optional().default(24).describe("Look back window in hours"),
  },
  async ({ service_name, hours }) => {
    recordIncidentStart(service_name);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("deployments")
      .select("*")
      .ilike("service_name", `%${service_name}%`)
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
server.tool(
  "get_runbook",
  "Fetch the step-by-step runbook for a service and failure scenario",
  {
    service_name: z.string().describe("Name of the service"),
    scenario: z
      .string()
      .optional()
      .describe(
        "Failure scenario e.g. 'high_error_rate', 'memory_spike', 'login_failures'"
      ),
  },
  async ({ service_name, scenario }) => {
    recordIncidentStart(service_name);
    let query = supabase
      .from("runbooks")
      .select("*")
      .ilike("service_name", `%${service_name}%`);

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
server.tool(
  "search_incidents",
  "Semantically search all historical incidents by describing a problem in plain English — finds similar past failures across all services without needing to know exact service names",
  {
    problem_description: z.string().describe(
      "Plain-English description of the current problem, e.g. 'users cannot log in', 'checkout is failing', 'database queries are slow', 'emails not being sent'"
    ),
    limit: z.number().optional().default(5).describe("How many similar past incidents to return"),
  },
  async ({ problem_description, limit }) => {
    const embedding = await embedText(problem_description);
    const { data, error } = await supabase.rpc("match_incidents", {
      query_embedding: embedding,
      match_count: limit,
    });

    if (error || !data?.length) {
      return {
        content: [
          {
            type: "text",
            text: `No similar incidents found for: "${problem_description}"`,
          },
        ],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// TOOL 6: Save incident resolution back to the knowledge base
server.tool(
  "save_incident_resolution",
  "Save a resolved incident back to the knowledge base for future reference",
  {
    service_name: z.string().describe("Name of the affected service"),
    title: z.string().describe("Short incident title"),
    severity: z.enum(["P1", "P2", "P3"]).describe("Incident severity"),
    root_cause: z.string().describe("What caused the incident"),
    resolution: z.string().describe("What steps fixed it"),
    worked: z.boolean().describe("Whether the fix actually resolved the incident")
  },
  async ({ service_name, title, severity, root_cause, resolution, worked }) => {
    // Auto-calculate duration from when the first investigation tool was called
    const startTime = incidentStartTimes.get(service_name);
    const duration_minutes = startTime
      ? Math.round((Date.now() - startTime) / 60_000)
      : null;
    incidentStartTimes.delete(service_name);

    if (!worked) {
      return {
        content: [{
          type: "text",
          text: `Noted — logging failed resolution attempt for ${service_name} so the team knows this approach didn't work.`
        }]
      };
    }

    const embeddingText = [
      title,
      `Service: ${service_name}`,
      `Severity: ${severity}`,
      `Root cause: ${root_cause}`,
      `Resolution: ${resolution}`,
    ].join(". ");
    const embedding = await embedText(embeddingText);

    const { error } = await supabase
      .from('incidents')
      .insert({
        service_name,
        title,
        severity,
        root_cause,
        resolution,
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

    return {
      content: [{
        type: "text",
        text: `✅ Saved to knowledge base. Next time ${service_name} has a similar incident, I'll reference this resolution automatically.`
      }]
    };
  }
);