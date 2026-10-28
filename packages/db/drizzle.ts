import "dotenv/config";

import path from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import serverConfig from "@karakeep/shared/config";

import dbConfig from "./drizzle.config";
import { instrumentDatabase } from "./instrumentation";
import * as schema from "./schema";
import { openSqliteDatabase } from "./sqlite";

const databaseGlobal = globalThis as typeof globalThis & {
  __karakeepSqlite?: Database.Database;
};
const sqlite = (databaseGlobal.__karakeepSqlite ??= openSqliteDatabase(
  dbConfig.dbCredentials.url,
  {
    readOnly: serverConfig.degradedMode,
    walMode: serverConfig.database.walMode,
  },
));

if (
  !(sqlite as Database.Database & { __karakeepInstrumented?: boolean })
    .__karakeepInstrumented
) {
  instrumentDatabase(sqlite);
  (
    sqlite as Database.Database & { __karakeepInstrumented?: boolean }
  ).__karakeepInstrumented = true;
}

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;

export function getInMemoryDB(runMigrations: boolean) {
  const mem = new Database(":memory:");
  const db = drizzle(mem, { schema, logger: false });
  if (runMigrations) {
    migrate(db, { migrationsFolder: path.resolve(__dirname, "./drizzle") });
  }
  return db;
}
