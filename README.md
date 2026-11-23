# Project Nexus ORM

Nexus is a Go-powered ORM and database management toolkit with a TypeScript-first developer experience for Node.js applications.

> [!IMPORTANT]
> The SQL in this project was made with AI, and some of the javascript was too so I would say this is 79% human made. The model used with some of this was Gemini Argon 4

## Architecture

- **TypeScript Layer (`@nexus-orm/core`, `@nexus-orm/cli`)**: Provides `defineConfig()`, `defineModel()`, `field.*`, `relation.define()`, static `$InferSelect` / `$InferInsert` type inference, query AST construction, and the CLI.
- **Go Execution Engine (`engine/cmd/nexus-engine`)**: Persistent child process communicating with Node.js via multiplexed Newline-Delimited JSON-RPC (NDJSON-RPC) over `stdin`/`stdout` with structured `stderr` logging, powered by a pluggable GORM backend supporting PostgreSQL, SQLite, and MySQL.

## Quickstart

```bash
# 1. Install TypeScript workspace dependencies
npm install

# 2. Fetch Go module dependencies & compile the Go engine + TypeScript packages
cd engine && go mod tidy && cd ..
npm run build

# 3. Run both Go and TypeScript (Vitest) test suites
npm test
```

## Defining Configuration (`nexus.config.ts`)

```ts
import { defineConfig } from "@nexus-orm/core";

export default defineConfig({
  dialect: "postgres",
  connection: {
    url: process.env.DATABASE_URL!,
    pool: { min: 2, max: 10 },
  },
  models: "./src/models",
  migrations: "./migrations",
  logging: { enabled: true, level: "warn" },
});
```

## Defining Models & Relations

```ts
import { defineModel, field, relation } from "@nexus-orm/core";

export const User = defineModel("User", {
  id: field.uuid().primaryKey().defaultRandom(),
  username: field.string().unique(),
  email: field.string().unique(),
  active: field.boolean().default(true),
  createdAt: field.date().defaultNow(),
});

export const Post = defineModel("Post", {
  id: field.uuid().primaryKey().defaultRandom(),
  title: field.string(),
  authorId: field.uuid().references(() => User, "id", { onDelete: "CASCADE" }),
});

relation.define(User, ({ hasMany }) => ({
  posts: hasMany(() => Post, { foreignKey: "authorId" }),
}));
```

## Querying

```ts
import { createClient } from "@nexus-orm/core";
import config from "./nexus.config.js";
import { User, Post } from "./src/models/index.js";

const db = createClient({ config, models: { User, Post } });

const activeUsers = await db.user.findMany({
  where: { active: true },
  include: { posts: true },
  orderBy: { createdAt: "desc" },
  limit: 20,
});
```

## CLI Commands

- `nexus init` — Scaffold `nexus.config.ts`, `src/models/`, and `migrations/`
- `nexus generate` — Validate models and emit `.nexus/schema-manifest.json`
- `nexus migrate:generate <name>` — Generate a timestamped Up/Down SQL migration file
- `nexus migrate` — Apply pending migrations with SHA-256 checksum validation
- `nexus migrate:rollback` — Revert the most recent migration
- `nexus migrate:status` — List applied, pending, and conflicting migrations
- `nexus migrate:reset` — Roll back and re-apply all migrations (protected by confirmation prompt)
- `nexus db:push` — Push model schema directly to the database
- `nexus db:pull` — Introspect an existing database into TypeScript models
- `nexus studio` — Launch the local Nexus Studio web server
- `nexus version` — Print CLI, Core, and runtime versions
