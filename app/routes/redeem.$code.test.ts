import { describe, it, expect } from "vitest";
import { RouterContextProvider } from "react-router";
import { eq } from "drizzle-orm";
import { db } from "~/db";
import {
  categories,
  coupons,
  courses,
  CourseStatus,
  purchases,
  teams,
  users,
  UserRole,
} from "~/db/schema";
import { isEnrolled } from "~/lib/enrollments.server";
import { setCurrentUserId } from "~/lib/session";
import { voidUnclaimedTeamSeats } from "~/lib/team-seats.server";
import { useTestDatabase } from "~/test/db";
import { action as redeemAction } from "./redeem.$code";

useTestDatabase();

function createUser(name: string, role: UserRole = UserRole.Student) {
  return db
    .insert(users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get();
}

/** Two team purchases of one course, each with one unclaimed seat: A-1 and B-1. */
function seedTeamSeats() {
  const instructor = createUser("Ivy", UserRole.Instructor);
  const boss = createUser("Boss");
  const other = createUser("Other");
  const liam = createUser("Liam");
  const category = db
    .insert(categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get();
  const course = db
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

  function teamPurchase(buyerId: number, code: string) {
    const purchase = db
      .insert(purchases)
      .values({ userId: buyerId, courseId: course.id, amountPaid: 39500 })
      .returning()
      .get();
    const team = db.insert(teams).values({}).returning().get();
    db.insert(coupons)
      .values({
        teamId: team.id,
        courseId: course.id,
        code,
        purchaseId: purchase.id,
      })
      .run();
    return purchase;
  }

  const refunded = teamPurchase(boss.id, "A-1");
  teamPurchase(other.id, "B-1");
  return { course, liam, refunded };
}

async function redeem(userId: number, code: string) {
  const url = `http://localhost/redeem/${code}`;
  const setCookie = await setCurrentUserId(new Request(url), userId);
  const request = new Request(url, {
    method: "POST",
    // A fixed country, so resolving it never goes to the network.
    headers: { Cookie: setCookie.split(";")[0], "CF-IPCountry": "US" },
    body: new URLSearchParams({ intent: "confirm-redeem" }),
  });
  return redeemAction({
    request,
    params: { code },
    context: new RouterContextProvider(),
    url: new URL(url),
    pattern: "/redeem/:code",
  });
}

describe("redeeming a Coupon", () => {
  it("turns away a Voided Team Seat's Coupon and creates no Enrollment", async () => {
    const { course, liam, refunded } = seedTeamSeats();
    voidUnclaimedTeamSeats(refunded.id);

    const result = await redeem(liam.id, "A-1");

    expect(result).toMatchObject({
      init: { status: 400 },
      data: {
        error: "This Team Seat was refunded and can no longer be claimed.",
      },
    });
    expect(isEnrolled(liam.id, course.id)).toBe(false);
    expect(
      db.select().from(coupons).where(eq(coupons.code, "A-1")).get()
    ).toMatchObject({ redeemedByUserId: null, redeemedAt: null });
  });

  it("still redeems a seat of another purchase", async () => {
    const { course, liam, refunded } = seedTeamSeats();
    voidUnclaimedTeamSeats(refunded.id);

    await expect(redeem(liam.id, "B-1")).rejects.toMatchObject({
      status: 302,
    });
    expect(isEnrolled(liam.id, course.id)).toBe(true);
  });
});
