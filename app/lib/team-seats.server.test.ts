import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "~/db";
import {
  categories,
  coupons,
  courses,
  CourseStatus,
  purchases,
  refunds,
  RefundStatus,
  teams,
  users,
  UserRole,
} from "~/db/schema";
import { approveRefundRequest } from "~/lib/refund-requests.server";
import { useTestDatabase } from "~/test/db";
import { voidUnclaimedTeamSeats } from "./team-seats.server";

useTestDatabase();

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const now = new Date("2026-01-05T09:30:00.000Z");

function createUser(name: string, role: UserRole = UserRole.Student) {
  return db
    .insert(users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get();
}

function seedCourse() {
  const instructor = createUser("Ivy", UserRole.Instructor);
  const category = db
    .insert(categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get();
  return db
    .insert(courses)
    .values({
      title: "Introduction to TypeScript",
      slug: "introduction-to-typescript",
      description: "A course",
      salesCopy: "Buy it",
      instructorId: instructor.id,
      categoryId: category.id,
      status: CourseStatus.Published,
      price: 7900,
    })
    .returning()
    .get();
}

function createPurchase(userId: number, courseId: number, amountPaid: number) {
  return db
    .insert(purchases)
    .values({ userId, courseId, amountPaid })
    .returning()
    .get();
}

/** A team purchase with the given seats; a seat with a claimer is claimed. */
function createTeamPurchase(
  buyerId: number,
  courseId: number,
  seats: { code: string; claimedBy?: number }[]
) {
  const purchase = createPurchase(buyerId, courseId, 39500);
  const team = db.insert(teams).values({}).returning().get();
  db.insert(coupons)
    .values(
      seats.map(({ code, claimedBy }) => ({
        teamId: team.id,
        courseId,
        code,
        purchaseId: purchase.id,
        redeemedByUserId: claimedBy ?? null,
        redeemedAt: claimedBy ? "2026-01-02T10:00:00.000Z" : null,
      }))
    )
    .run();
  return purchase;
}

function voidedAtByCode() {
  return Object.fromEntries(
    db
      .select({ code: coupons.code, voidedAt: coupons.voidedAt })
      .from(coupons)
      .all()
      .map(({ code, voidedAt }) => [code, voidedAt])
  );
}

function createOpenRefundRequest(purchaseId: number) {
  return db
    .insert(refunds)
    .values({
      purchaseId,
      status: RefundStatus.Open,
      reason: "We no longer need it.",
    })
    .returning()
    .get();
}

describe("voidUnclaimedTeamSeats", () => {
  it("voids the purchase's unclaimed seats and leaves claimed ones alone", () => {
    const course = seedCourse();
    const boss = createUser("Boss");
    const liam = createUser("Liam");
    const purchase = createTeamPurchase(boss.id, course.id, [
      { code: "SEAT-1", claimedBy: liam.id },
      { code: "SEAT-2" },
      { code: "SEAT-3" },
    ]);

    const voided = voidUnclaimedTeamSeats(purchase.id, now);

    expect(voided).toBe(2);
    expect(voidedAtByCode()).toEqual({
      "SEAT-1": null,
      "SEAT-2": now.toISOString(),
      "SEAT-3": now.toISOString(),
    });
  });

  it("leaves the seats of other purchases alone", () => {
    const course = seedCourse();
    const boss = createUser("Boss");
    const other = createUser("Other");
    const purchase = createTeamPurchase(boss.id, course.id, [{ code: "A-1" }]);
    createTeamPurchase(other.id, course.id, [{ code: "B-1" }]);

    voidUnclaimedTeamSeats(purchase.id, now);

    expect(voidedAtByCode()).toEqual({
      "A-1": now.toISOString(),
      "B-1": null,
    });
  });
});

describe("approving a Refund Request", () => {
  it("voids the unclaimed seats of a team purchase, and no other purchase's", () => {
    const course = seedCourse();
    const ada = createUser("Ada", UserRole.Admin);
    const boss = createUser("Boss");
    const other = createUser("Other");
    const purchase = createTeamPurchase(boss.id, course.id, [
      { code: "A-1" },
      { code: "A-2" },
    ]);
    createTeamPurchase(other.id, course.id, [{ code: "B-1" }]);
    const request = createOpenRefundRequest(purchase.id);

    const result = approveRefundRequest(request.id, ada.id, {}, now);

    expect(result.outcome).toBe("approved");
    expect(voidedAtByCode()).toEqual({
      "A-1": now.toISOString(),
      "A-2": now.toISOString(),
      "B-1": null,
    });
  });

  it("voids no seats for an individual purchase", () => {
    const course = seedCourse();
    const ada = createUser("Ada", UserRole.Admin);
    const liam = createUser("Liam");
    const boss = createUser("Boss");
    createTeamPurchase(boss.id, course.id, [{ code: "A-1" }]);
    const request = createOpenRefundRequest(
      createPurchase(liam.id, course.id, 7900).id
    );

    const result = approveRefundRequest(request.id, ada.id, {}, now);

    expect(result.outcome).toBe("approved");
    expect(
      db.select().from(coupons).where(eq(coupons.code, "A-1")).get()?.voidedAt
    ).toBeNull();
  });
});
