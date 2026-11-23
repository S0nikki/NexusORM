import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { z } from "zod";
import { NexusError, scrubCredentials } from "../errors/index.js";

export const PoolConfigSchema = z
  .object({
    min: z.number().int().nonnegative().default(2),
    max: z.number().int().positive().default(10),
    idleTimeoutMs: z.number().int().positive().default(30_000),
  })
  .refine((p) => p.max >= p.min, {
    message: "Connection pool 'max' must be greater than or equal to 'min'",
  });

export const ConnectionConfigSchema = z.object({
  url: z.string().min(1, "Database connection URL is required"),
  pool: PoolConfigSchema.default({ min: 2, max: 10, idleTimeoutMs: 30_000 }),
});

export const LoggingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  level: z.enum(["debug", "info", "warn", "error"]).default("warn"),
});

export const NexusConfigSchema = z.object({
  dialect: z.enum(["postgres", "sqlite", "mysql"]),
  env: z.enum(["development", "production", "test"]).default("development"),
  connection: ConnectionConfigSchema,
  models: z.string().default("./src/models"),
  migrations: z.string().default("./migrations"),
  logging: LoggingConfigSchema.default({ enabled: true, level: "warn" }),
  engineBinaryPath: z.string().optional(),
});

export type NexusConfigInput = z.input<typeof NexusConfigSchema>;
export type NexusConfig = z.output<typeof NexusConfigSchema>;

export function defineConfig<T extends NexusConfigInput>(config: T): NexusConfig {
  const parsed = NexusConfigSchema.safeParse(config);
  if (!parsed.success) {
    const issue = parsed.error.issues
      .map((i) => `${i.path.join(".") || "config"}: ${i.message}`)
      .join("; ");
    throw new NexusError({
      code: "NEXUS_CONFIG_INVALID",
      message: `Invalid Nexus configuration: ${scrubCredentials(issue)}`,
      retryable: false,
    });
  }
  return parsed.data;
}

export async function loadConfig(cwd: string = process.cwd(), explicitFile?: string): Promise<NexusConfig> {
  const candidates = explicitFile
    ? [explicitFile]
    : ["nexus.config.ts", "nexus.config.mts", "nexus.config.mjs", "nexus.config.js"];

  let foundPath: string | undefined;
  for (const candidate of candidates) {
    const abs = path.resolve(cwd, candidate);
    if (fs.existsSync(abs)) {
      foundPath = abs;
      break;
    }
  }

  if (!foundPath) {
    throw new NexusError({
      code: "NEXUS_CONFIG_INVALID",
      message: `Could not locate nexus.config.ts in ${cwd}. Run 'nexus init' to create one.`,
      retryable: false,
    });
  }

  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const mod = (await jiti.import(foundPath)) as Record<string, unknown> | NexusConfigInput;
  const rawConfig =
    mod && typeof mod === "object" && "default" in mod
      ? (mod.default as NexusConfigInput)
      : mod && typeof mod === "object" && "config" in mod
        ? (mod.config as NexusConfigInput)
        : (mod as NexusConfigInput);

  return defineConfig(rawConfig);
}
