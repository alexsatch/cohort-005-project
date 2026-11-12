import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "~/db";
import {
  categories,
  coupons,
  courses,
  CourseStatus,
  enrollments,
  purchases,
  RefundMoneyStatus,
  refunds,
  RefundStatus,
  teams,
  users,
  UserRole,
} from "~/db/schema";
import { useTestDatabase } from "~/test/db";
import {
  getBuyerCount,
  getCourseRevenue,
  getCourseRevenueByCountry,
  getRevenueOverTime,
  getRevenueSummary,
  getStudentRevenue,
  getTopBuyers,
} from "./revenue.server";

useTestDatabase();

function createUser(name: string, role: UserRole = UserRole.Student) {
  return db
    .insert(users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get();
}

function createCourse(title: string, instructorId: number) {
  const category = db
    .insert(categories)
    .values({ name: `Category ${title}`, slug: `category-${title}` })
    .returning()
    .get();

  return db
    .insert(courses)
    .values({
      title,
      slug: title.toLowerCase(),
      description: "A course",
      salesCopy: "Buy it",
      instructorId,
      categoryId: category.id,
      status: CourseStatus.Published,
      price: 7900,
    })
    .returning()
    .get();
}

function buy(userId: number, courseId: number, amountPaid: number) {
  db.insert(enrollments).values({ userId, courseId }).run();
  return db
    .insert(purchases)
    .values({ userId, courseId, amountPaid, country: "US" })
    .returning()
    .get();
}

function raiseRefundRequest(
  purchaseId: number,
  status: RefundStatus,
  moneyStatus: RefundMoneyStatus | null = null
) {
  db.insert(refunds)
    .values({
      purchaseId,
      status,
      reason: "Not for me",
      amountRefunded: status === RefundStatus.Approved ? 7900 : null,
      moneyStatus,
    })
    .run();
}

/** Two buyers of one course, paying 7900 and 5999. */
function twoPurchases() {
  const instructor = createUser("Ines", UserRole.Instructor);
  const course = createCourse("TypeScript", instructor.id);
  const ada = createUser("Ada");
  const liam = createUser("Liam");
  const refunded = buy(ada.id, course.id, 7900);
  buy(liam.id, course.id, 5999);
  return { instructor, course, ada, liam, refunded };
}

function grossOverTime(instructorId: number) {
  return getRevenueOverTime(instructorId, "all").points.reduce(
    (total, point) => total + point.grossCents,
    0
  );
}

describe("revenue", () => {
  describe.each([
    RefundMoneyStatus.Pending,
    RefundMoneyStatus.Issued,
    RefundMoneyStatus.Failed,
  ])("a purchase with an Approved Refund Request whose Refund is %s", (moneyStatus) => {
    it("leaves the revenue summary", () => {
      const { instructor, refunded } = twoPurchases();
      raiseRefundRequest(refunded.id, RefundStatus.Approved, moneyStatus);

      expect(getRevenueSummary(instructor.id, "all")).toEqual({
        grossCents: 5999,
        feeCents: 1200,
        netCents: 4799,
        purchaseCount: 1,
      });
    });

    it("leaves the per-course revenue", () => {
      const { instructor, course, refunded } = twoPurchases();
      raiseRefundRequest(refunded.id, RefundStatus.Approved, moneyStatus);

      expect(getCourseRevenue(instructor.id, "all")).toEqual([
        {
          courseId: course.id,
          title: "TypeScript",
          grossCents: 5999,
          feeCents: 1200,
          netCents: 4799,
          purchaseCount: 1,
        },
      ]);
    });

    it("leaves the buyer count, top buyers and revenue over time", () => {
      const { instructor, liam, refunded } = twoPurchases();
      raiseRefundRequest(refunded.id, RefundStatus.Approved, moneyStatus);

      expect(getBuyerCount(instructor.id, "all")).toBe(1);
      expect(
        getTopBuyers(instructor.id, "all").map((buyer) => ({
          userId: buyer.userId,
          spendCents: buyer.spendCents,
          purchaseCount: buyer.purchaseCount,
        }))
      ).toEqual([{ userId: liam.id, spendCents: 5999, purchaseCount: 1 }]);
      expect(grossOverTime(instructor.id)).toBe(5999);
    });

    it("leaves the revenue by country", () => {
      const { course, refunded } = twoPurchases();
      raiseRefundRequest(refunded.id, RefundStatus.Approved, moneyStatus);

      const byCountry = getCourseRevenueByCountry(course.id, "all");
      expect(byCountry.grossCents).toBe(5999);
      expect(byCountry.purchaseCount).toBe(1);
      expect(byCountry.rows).toEqual([
        expect.objectContaining({
          country: "US",
          grossCents: 5999,
          purchaseCount: 1,
        }),
      ]);
    });

    it("leaves the per-student spend", () => {
      const { instructor, ada, liam, refunded } = twoPurchases();
      raiseRefundRequest(refunded.id, RefundStatus.Approved, moneyStatus);

      expect(getStudentRevenue(instructor.id, "all")).toEqual([
        { userId: ada.id, name: "Ada", revenueCents: 0 },
        { userId: liam.id, name: "Liam", revenueCents: 5999 },
      ]);
    });
  });

  describe.each([RefundStatus.Open, RefundStatus.Declined])(
    "a purchase with a %s Refund Request",
    (status) => {
      it("still counts in every revenue figure", () => {
        const { instructor, course, refunded } = twoPurchases();
        raiseRefundRequest(refunded.id, status);

        expect(getRevenueSummary(instructor.id, "all")).toEqual({
          grossCents: 13899,
          feeCents: 2780,
          netCents: 11119,
          purchaseCount: 2,
        });
        expect(getCourseRevenue(instructor.id, "all")[0].grossCents).toBe(
          13899
        );
        expect(getBuyerCount(instructor.id, "all")).toBe(2);
        expect(
          getTopBuyers(instructor.id, "all").map((buyer) => buyer.spendCents)
        ).toEqual([7900, 5999]);
        expect(grossOverTime(instructor.id)).toBe(13899);
        expect(getCourseRevenueByCountry(course.id, "all").grossCents).toBe(
          13899
        );
        expect(
          getStudentRevenue(instructor.id, "all").map(
            (student) => student.revenueCents
          )
        ).toEqual([7900, 5999]);
      });
    }
  );

  it("drops a refunded team purchase from the share of a learner who redeemed its seat", () => {
    const instructor = createUser("Ines", UserRole.Instructor);
    const course = createCourse("TypeScript", instructor.id);
    const buyer = createUser("Bea");
    const learner = createUser("Lou");
    const team = db.insert(teams).values({}).returning().get();
    const purchase = db
      .insert(purchases)
      .values({ userId: buyer.id, courseId: course.id, amountPaid: 15800 })
      .returning()
      .get();
    db.insert(coupons)
      .values([
        {
          teamId: team.id,
          courseId: course.id,
          code: "SEAT-1",
          purchaseId: purchase.id,
          redeemedByUserId: learner.id,
        },
        {
          teamId: team.id,
          courseId: course.id,
          code: "SEAT-2",
          purchaseId: purchase.id,
        },
      ])
      .run();
    db.insert(enrollments)
      .values({ userId: learner.id, courseId: course.id })
      .run();

    expect(getStudentRevenue(instructor.id, "all")).toEqual([
      { userId: learner.id, name: "Lou", revenueCents: 7900 },
    ]);

    raiseRefundRequest(
      purchase.id,
      RefundStatus.Approved,
      RefundMoneyStatus.Pending
    );

    expect(getStudentRevenue(instructor.id, "all")).toEqual([
      { userId: learner.id, name: "Lou", revenueCents: 0 },
    ]);
  });

  it("leaves a Suspended Enrollment out of the students counted", () => {
    const { instructor, ada, liam } = twoPurchases();
    db.update(enrollments)
      .set({ suspendedAt: "2026-01-05T00:00:00.000Z" })
      .where(eq(enrollments.userId, ada.id))
      .run();

    expect(
      getStudentRevenue(instructor.id, "all").map((student) => student.userId)
    ).toEqual([liam.id]);
  });
});
