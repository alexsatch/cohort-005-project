import { describe, it, expect } from "vitest";
import { db } from "~/db";
import { users, UserRole } from "~/db/schema";
import { useTestDatabase } from "./db";

describe("useTestDatabase", () => {
  useTestDatabase();

  it("starts each test with an empty, migrated database", () => {
    expect(db.select().from(users).all()).toEqual([]);
    db.insert(users)
      .values({ name: "Ada", email: "ada@example.com", role: UserRole.Student })
      .run();
    expect(db.select().from(users).all()).toHaveLength(1);
  });

  it("does not leak rows from the previous test", () => {
    expect(db.select().from(users).all()).toEqual([]);
  });
});
