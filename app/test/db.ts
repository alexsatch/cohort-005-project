import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach } from "vitest";
import { replaceSqliteConnection } from "~/db";
import * as schema from "~/db/schema";

const migrationsFolder = path.resolve(__dirname, "../../drizzle");

/**
 * Gives every test in the file its own empty, fully-migrated in-memory
 * database, and points the app's `db` at it. Call once at the top of a test
 * file (or describe block). Tests then insert the rows they need through
 * `db` and exercise real modules, with no mocks.
 */
export function useTestDatabase() {
  beforeEach(() => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    migrate(drizzle(sqlite, { schema }), { migrationsFolder });
    replaceSqliteConnection(sqlite);
  });
}
