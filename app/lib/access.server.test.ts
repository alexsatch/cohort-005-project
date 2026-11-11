import { describe, it, expect } from "vitest";
import { db } from "~/db";
import {
  categories,
  courses,
  CourseStatus,
  users,
  UserRole,
} from "~/db/schema";
import { setCurrentUserId } from "~/lib/session";
import { useTestDatabase } from "~/test/db";
import { requireAdmin } from "./access.server";

useTestDatabase();

function createUser(name: string, role: UserRole) {
  return db
    .insert(users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get();
}

async function requestAs(userId: number | null) {
  const bare = new Request("http://localhost/admin/refunds");
  if (userId === null) return bare;
  const setCookie = await setCurrentUserId(bare, userId);
  return new Request(bare.url, {
    headers: { Cookie: setCookie.split(";")[0] },
  });
}

describe("requireAdmin", () => {
  it("lets an admin through", async () => {
    const admin = createUser("Ada", UserRole.Admin);
    const result = await requireAdmin(await requestAs(admin.id));
    expect(result.userId).toBe(admin.id);
  });

  it("rejects a student with 403", async () => {
    const student = createUser("Liam", UserRole.Student);
    await expect(requireAdmin(await requestAs(student.id))).rejects.toMatchObject({
      init: { status: 403 },
    });
  });

  it("rejects a course's owning instructor with 403", async () => {
    const instructor = createUser("Ivy", UserRole.Instructor);
    const category = db
      .insert(categories)
      .values({ name: "Programming", slug: "programming" })
      .returning()
      .get();
    db.insert(courses)
      .values({
        title: "Introduction to TypeScript",
        slug: "introduction-to-typescript",
        description: "A course",
        salesCopy: "Buy it",
        instructorId: instructor.id,
        categoryId: category.id,
        status: CourseStatus.Published,
      })
      .run();

    await expect(requireAdmin(await requestAs(instructor.id))).rejects.toMatchObject({
      init: { status: 403 },
    });
  });

  it("rejects a signed-out visitor with 401", async () => {
    await expect(requireAdmin(await requestAs(null))).rejects.toMatchObject({
      init: { status: 401 },
    });
  });
});
