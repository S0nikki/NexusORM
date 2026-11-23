import { defineConfig } from "@nexus-orm/core";

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
