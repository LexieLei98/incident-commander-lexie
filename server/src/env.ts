import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

if (process.env.NODE_ENV !== "production") {
  process.loadEnvFile();
}

export const env = createEnv({
  server: {
    SUPABASE_URL: z.string().min(1),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    GEMINI_API_KEY: z.string().min(1),
    ALLOWED_ORIGIN: z.string().optional(),
  },
  runtimeEnv: process.env,
});
