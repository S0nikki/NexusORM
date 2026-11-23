#!/usr/bin/env bun
// setup-bun.mjs
// Links @nexus-orm/core and @nexus-orm/cli for Bun and creates a ready-to-run playground project.
// Run with: bun setup-bun.mjs

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function run(cmd, cwd = ROOT) {
  console.log(`\n> (${path.relative(ROOT, cwd) || "."}) ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

// 1. Add root convenience scripts for Bun to package.json
const rootPkgPath = path.join(ROOT, "package.json");
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
rootPkg.scripts = {
  ...rootPkg.scripts,
  "nexus": "bun packages/cli/bin/nexus.mjs",
  "playground": "bun run playground/index.ts",
};
fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n", "utf8");
console.log("[UPDATED] package.json with 'bun run nexus' and 'bun run playground'");

// 2. Register @nexus-orm/core and @nexus-orm/cli globally with Bun
run("bun link", path.join(ROOT, "packages/core"));
run("bun link", path.join(ROOT, "packages/cli"));

// 3. Create a local Bun playground project in ./playground
const playgroundDir = path.join(ROOT, "playground");
const modelsDir = path.join(playgroundDir, "src/models");
const migrationsDir = path.join(playgroundDir, "migrations");

fs.mkdirSync(modelsDir, { recursive: true });
fs.mkdirSync(migrationsDir, { recursive: true });

// playground/nexus.config.ts
fs.writeFileSync(
  path.join(playgroundDir, "nexus.config.ts"),
  `import { defineConfig } from "@nexus-orm/core";

export default defineConfig({
  dialect: "sqlite",
  connection: {
    url: "file:./playground.db",
    pool: { min: 1, max: 5 },
  },
  models: "./src/models",
  migrations: "./migrations",
  logging: {
    enabled: true,
    level: "info",
  },
});
`,
  "utf8"
);

// playground/src/models/schema.ts
fs.writeFileSync(
  path.join(modelsDir, "schema.ts"),
  `import { defineModel, field, relation } from "@nexus-orm/core";

export const User = defineModel("User", {
  id: field.uuid().primaryKey().defaultRandom(),
  username: field.string({ maxLength: 64 }).unique().index(),
  email: field.string().unique(),
  active: field.boolean().default(true),
  createdAt: field.date().defaultNow(),
});

export const Post = defineModel("Post", {
  id: field.uuid().primaryKey().defaultRandom(),
  title: field.string(),
  views: field.integer().default(0),
  authorId: field.uuid().references(() => User, "id", { onDelete: "CASCADE" }),
  createdAt: field.date().defaultNow(),
});

relation.define(User, ({ hasMany }) => ({
  posts: hasMany(() => Post, { foreignKey: "authorId" }),
}));

relation.define(Post, ({ belongsTo }) => ({
  author: belongsTo(() => User, { foreignKey: "authorId" }),
}));
`,
  "utf8"
);

// playground/index.ts
fs.writeFileSync(
  path.join(playgroundDir, "index.ts"),
  `import { createClient, loadConfig } from "@nexus-orm/core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Post, User } from "./src/models/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = await loadConfig(__dirname);
  const db = createClient({
    config,
    models: { User, Post },
  });

  // Sync tables to playground.db
  await db.$pushSchema();

  // Clean previous demo runs
  await db.post.deleteMany();
  await db.user.deleteMany();

  // 1. Create a user inside a transaction along with two posts
  const createdUser = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        username: "barre",
        email: "barre@nexus.local",
      },
    });

    await tx.post.createMany({
      data: [
        { title: "Running Nexus on Bun", views: 120, authorId: user.id },
        { title: "Go + TypeScript IPC Architecture", views: 85, authorId: user.id },
      ],
    });

    return user;
  });

  console.log("Created user:", createdUser);

  // 2. Query back with eager-loaded relations
  const users = await db.user.findMany({
    where: { active: true },
    include: {
      posts: {
        orderBy: { views: "desc" },
      },
    },
  });

  console.log("\\nUsers with eager-loaded posts:");
  console.dir(users, { depth: null });

  await db.$disconnect();
}

main().catch(console.error);
`,
  "utf8"
);

console.log("\n=== Bun Local Environment Setup Complete ===");
console.log("Try running the playground right now:");
console.log("  bun run playground");
