import "dotenv/config";
import { z } from "zod";

// Empty is allowed so the bot can boot and answer /chatid before approvers are configured.
const csvNumbers = z
  .string()
  .default("")
  .transform((value) => value.split(",").map((part) => part.trim()).filter(Boolean).map(Number))
  .refine((ids) => ids.every((id) => Number.isInteger(id)), "must be comma-separated integers");

const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default("127.0.0.1"),
  LOG_LEVEL: z.string().default("info"),
  ADMIN_API_KEY: z.string().min(16, "use at least 16 characters"),
  PUBLIC_BASE_URL: z.url().transform((url) => url.replace(/\/+$/, "")),
  PRODUCTS_DIR: z.string().default("./products"),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_USER_IDS: csvNumbers,
  THREADS_APP_ID: z.string().min(1),
  THREADS_APP_SECRET: z.string().min(1),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat empty strings from .env as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
