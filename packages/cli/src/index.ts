import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { createJiti } from "jiti";
import {
  CLIENT_VERSION,
  EngineBridge,
  NexusError,
  loadConfig,
  serializeSchema,
  type AnyModelDefinition,
  type NexusConfig,
} from "@nexus-orm/core";

async function confirmAction(promptText: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(`${promptText} [y/N]: `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function discoverModels(cwd: string, modelsPath: string): Promise<AnyModelDefinition[]> {
  const fullPath = path.resolve(cwd, modelsPath);
  if (!fs.existsSync(fullPath)) return [];

  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const files: string[] = [];

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(fullPath)) {
      if (/\.(ts|mts|js|mjs)$/.test(entry) && !entry.endsWith(".d.ts")) {
        files.push(path.join(fullPath, entry));
      }
    }
  } else {
    files.push(fullPath);
  }

  const models: AnyModelDefinition[] = [];
  for (const file of files) {
    const mod = (await jiti.import(file)) as Record<string, any>;
    for (const exported of Object.values(mod)) {
      if (
        exported &&
        typeof exported === "object" &&
        typeof exported.name === "string" &&
        typeof exported.tableName === "string" &&
        typeof exported.fields === "object"
      ) {
        models.push(exported as AnyModelDefinition);
      }
    }
  }
  return models;
}

async function createConnectedBridge(config: NexusConfig, models: AnyModelDefinition[]) {
  const bridge = new EngineBridge({ binaryPath: config.engineBinaryPath });
  await bridge.start();
  await bridge.request("engine.connect", {
    dialect: config.dialect,
    url: config.connection.url,
    pool: config.connection.pool,
    logLevel: config.logging.level,
  });
  await bridge.request("schema.register", serializeSchema(models));
  return bridge;
}

export async function runCli(args: string[], cwd: string = process.cwd()): Promise<void> {
  const cmd = args[0] ?? "help";

  switch (cmd) {
    case "version":
    case "--version":
    case "-v": {
      console.log(`@nexus-orm/cli v${CLIENT_VERSION}`);
      console.log(`@nexus-orm/core v${CLIENT_VERSION}`);
      console.log(`Node.js ${process.version}`);
      return;
    }

    case "init": {
      const configPath = path.join(cwd, "nexus.config.ts");
      const modelsDir = path.join(cwd, "src/models");
      const migrationsDir = path.join(cwd, "migrations");

      fs.mkdirSync(modelsDir, { recursive: true });
      fs.mkdirSync(migrationsDir, { recursive: true });

      if (!fs.existsSync(configPath)) {
        fs.writeFileSync(
          configPath,
          [
            'import { defineConfig } from "@nexus-orm/core";',
            "",
            "export default defineConfig({",
            '  dialect: "sqlite",',
            "  connection: {",
            '    url: process.env.DATABASE_URL ?? "file:./dev.db",',
            "    pool: { min: 1, max: 5 },",
            "  },",
            '  models: "./src/models",',
            '  migrations: "./migrations",',
            '  logging: { enabled: true, level: "warn" },',
            "});",
            "",
          ].join("\n"),
          "utf8"
        );
      }

      const sampleModelPath = path.join(modelsDir, "user.ts");
      if (!fs.existsSync(sampleModelPath)) {
        fs.writeFileSync(
          sampleModelPath,
          [
            'import { defineModel, field } from "@nexus-orm/core";',
            "",
            'export const User = defineModel("User", {',
            "  id: field.uuid().primaryKey().defaultRandom(),",
            "  username: field.string().unique(),",
            "  email: field.string().unique(),",
            "  active: field.boolean().default(true),",
            "  createdAt: field.date().defaultNow(),",
            "});",
            "",
          ].join("\n"),
          "utf8"
        );
      }

      console.log("Initialized Nexus project structure:");
      console.log("  - nexus.config.ts");
      console.log("  - src/models/user.ts");
      console.log("  - migrations/");
      return;
    }

    case "generate": {
      const config = await loadConfig(cwd);
      const models = await discoverModels(cwd, config.models);
      const manifest = serializeSchema(models);
      const outDir = path.join(cwd, ".nexus");
      fs.mkdirSync(outDir, { recursive: true });
      const manifestPath = path.join(outDir, "schema-manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      console.log(`Generated Nexus schema manifest (${models.length} models) -> .nexus/schema-manifest.json`);
      return;
    }

    case "migrate:generate": {
      const config = await loadConfig(cwd);
      const models = await discoverModels(cwd, config.models);
      const nameArg = args[1] ?? "migration";
      const bridge = await createConnectedBridge(config, models);
      try {
        const res = await bridge.request<{ filePath: string }>("migrate.generate", {
          dir: path.resolve(cwd, config.migrations),
          name: nameArg,
        });
        console.log(`Generated migration file: ${res.filePath}`);
      } finally {
        await bridge.stop();
      }
      return;
    }

    case "migrate": {
      const config = await loadConfig(cwd);
      const models = await discoverModels(cwd, config.models);
      const bridge = await createConnectedBridge(config, models);
      try {
        const res = await bridge.request<{ applied: string[] }>("migrate.up", {
          dir: path.resolve(cwd, config.migrations),
        });
        if (!res.applied || res.applied.length === 0) {
          console.log("Database is up to date. No pending migrations.");
        } else {
          console.log(`Applied ${res.applied.length} migration(s):`);
          for (const m of res.applied) console.log(`  + ${m}`);
        }
      } finally {
        await bridge.stop();
      }
      return;
    }

    case "migrate:rollback": {
      const config = await loadConfig(cwd);
      const models = await discoverModels(cwd, config.models);
      const bridge = await createConnectedBridge(config, models);
      try {
        const res = await bridge.request<{ reverted: string }>("migrate.rollback", {
          dir: path.resolve(cwd, config.migrations),
        });
        if (!res.reverted) {
          console.log("No applied migrations to roll back.");
        } else {
          console.log(`Rolled back migration: ${res.reverted}`);
        }
      } finally {
        await bridge.stop();
      }
      return;
    }

    case "migrate:status": {
      const config = await loadConfig(cwd);
      const models = await discoverModels(cwd, config.models);
      const bridge = await createConnectedBridge(config, models);
      try {
        const res = await bridge.request<{
          migrations: Array<{ name: string; status: string; appliedAt?: string }>;
        }>("migrate.status", {
          dir: path.resolve(cwd, config.migrations),
        });
        if (!res.migrations || res.migrations.length === 0) {
          console.log("No migration files found.");
        } else {
          for (const m of res.migrations) {
            console.log(`[${m.status.toUpperCase()}] ${m.name} ${m.appliedAt ? `(${m.appliedAt})` : ""}`);
          }
        }
      } finally {
        await bridge.stop();
      }
      return;
    }

    case "migrate:reset": {
      const config = await loadConfig(cwd);
      const isProd = config.env === "production" || process.env.NODE_ENV === "production";
      const forceFlag = args.includes("--force") || args.includes("--yes");

      if (isProd && !args.includes("--force-production")) {
        throw new NexusError({
          code: "NEXUS_VALIDATION_ERROR",
          message:
            "Refusing to run 'nexus migrate:reset' in production environment without --force-production.",
          retryable: false,
        });
      }

      const confirmed =
        forceFlag ||
        (await confirmAction("WARNING: This will roll back and reset all database migrations. Continue?"));
      if (!confirmed) {
        console.log("Migration reset cancelled.");
        return;
      }

      const models = await discoverModels(cwd, config.models);
      const bridge = await createConnectedBridge(config, models);
      try {
        const res = await bridge.request<{ applied: string[] }>("migrate.reset", {
          dir: path.resolve(cwd, config.migrations),
          confirmed: true,
        });
        console.log(`Database reset complete. Re-applied ${res.applied?.length ?? 0} migration(s).`);
      } finally {
        await bridge.stop();
      }
      return;
    }

    case "db:push": {
      const config = await loadConfig(cwd);
      const models = await discoverModels(cwd, config.models);
      const bridge = await createConnectedBridge(config, models);
      try {
        await bridge.request("schema.push", {});
        console.log(`Pushed schema for ${models.length} model(s) directly to database.`);
      } finally {
        await bridge.stop();
      }
      return;
    }

    case "db:pull": {
      const config = await loadConfig(cwd);
      const bridge = await createConnectedBridge(config, []);
      try {
        const manifest = await bridge.request<{
          models: Array<{
            name: string;
            tableName: string;
            fields: Array<{ name: string; type: string; primaryKey: boolean; unique: boolean; nullable: boolean }>;
          }>;
        }>("schema.introspect", {});

        const lines: string[] = ['import { defineModel, field } from "@nexus-orm/core";', ""];
        for (const m of manifest.models ?? []) {
          lines.push(`export const ${m.name} = defineModel("${m.name}", {`);
          for (const f of m.fields) {
            let chain = `field.${f.type}()`;
            if (f.primaryKey) chain += ".primaryKey()";
            if (f.unique) chain += ".unique()";
            if (f.nullable) chain += ".nullable()";
            lines.push(`  ${f.name}: ${chain},`);
          }
          lines.push("});", "");
        }

        const outFile = path.resolve(cwd, config.models, "introspected.ts");
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, lines.join("\n"), "utf8");
        console.log(`Introspected ${manifest.models?.length ?? 0} model(s) -> ${outFile}`);
      } finally {
        await bridge.stop();
      }
      return;
    }

    case "studio": {
      const config = await loadConfig(cwd);
      const models = await discoverModels(cwd, config.models);
      const bridge = await createConnectedBridge(config, models);
      const res = await bridge.request<{ url: string }>("studio.start", { port: 4983 });
      console.log(`Nexus Studio is running at ${res.url} (Press Ctrl+C to stop)`);
      return;
    }

    default: {
      console.log("Nexus ORM CLI");
      console.log("Commands:");
      console.log("  nexus init               Initialize nexus.config.ts and directories");
      console.log("  nexus generate           Validate models and emit schema manifest");
      console.log("  nexus migrate            Apply pending database migrations");
      console.log("  nexus migrate:rollback   Roll back the last applied migration");
      console.log("  nexus migrate:status     Show applied, pending, and conflicting migrations");
      console.log("  nexus migrate:generate   Generate a new Up/Down SQL migration from models");
      console.log("  nexus migrate:reset      Reset and re-apply all migrations (requires confirmation)");
      console.log("  nexus db:push            Push model schema directly to the database");
      console.log("  nexus db:pull            Introspect existing database into TypeScript models");
      console.log("  nexus studio             Launch local Nexus Studio data browser");
      console.log("  nexus version            Display Nexus CLI and Core versions");
    }
  }
}
