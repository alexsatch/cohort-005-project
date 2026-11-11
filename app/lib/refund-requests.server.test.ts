import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "~/db";
import {
  categories,
  courses,
  CourseStatus,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  purchases,
  refunds,
  RefundStatus,
  users,
  UserRole,
  videoWatchEvents,
} from "~/db/schema";
import { useTestDatabase } from "~/test/db";
import {
  countOpenRefundRequests,
  getRefundRequestDetail,
  listRefundRequests,
  parseRefundRequestFilter,
} from "./refund-requests.server";

useTestDatabase();

function createUser(name: string, role: UserRole = UserRole.Student) {
  return db
    .insert(users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get();
}

function createCourse(title: string, instructorId: number) {
  const category =
    db.select().from(categories).get() ??
    db
      .insert(categories)
      .values({ name: "Programming", slug: "programming" })
      .returning()
      .get();

  return db
    .insert(courses)
    .values({
      title,
      slug: title.toLowerCase().replace(/\s+/g, "-"),
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

function createLessons(courseId: number, count: number) {
  const mod = db
    .insert(modules)
    .values({ courseId, title: "Module", position: 1 })
    .returning()
    .get();

  return Array.from({ length: count }, (_, i) =>
    db
      .insert(lessons)
      .values({ moduleId: mod.id, title: `Lesson ${i + 1}`, position: i + 1 })
      .returning()
      .get()
  );
}

function createPurchase(
  userId: number,
  courseId: number,
  amountPaid: number,
  createdAt = "2026-01-01T10:00:00.000Z"
) {
  return db
    .insert(purchases)
    .values({ userId, courseId, amountPaid, createdAt })
    .returning()
    .get();
}

function createRefundRequest(
  purchaseId: number,
  status: RefundStatus = RefundStatus.Open,
  requestedAt = "2026-01-03T10:00:00.000Z",
  reason = "The course was not what I expected."
) {
  return db
    .insert(refunds)
    .values({ purchaseId, status, reason, requestedAt })
    .returning()
    .get();
}

function seedBasics() {
  const instructor = createUser("Ivy", UserRole.Instructor);
  const liam = createUser("Liam");
  const course = createCourse("Introduction to TypeScript", instructor.id);
  return { instructor, liam, course };
}

describe("listRefundRequests", () => {
  it("lists Open Refund Requests with buyer, course, amount paid and requested date", () => {
    const { liam, course } = seedBasics();
    const purchase = createPurchase(liam.id, course.id, 7900);
    const request = createRefundRequest(purchase.id);

    expect(listRefundRequests(RefundStatus.Open)).toEqual([
      {
        id: request.id,
        status: RefundStatus.Open,
        requestedAt: "2026-01-03T10:00:00.000Z",
        amountPaid: 7900,
        buyer: { id: liam.id, name: "Liam", email: "liam@example.com" },
        course: { id: course.id, title: "Introduction to TypeScript" },
      },
    ]);
  });

  it("shows only the Refund Requests with the chosen status", () => {
    const { liam, course } = seedBasics();
    const first = createPurchase(liam.id, course.id, 7900);
    const second = createPurchase(liam.id, course.id, 7900);
    const third = createPurchase(liam.id, course.id, 7900);
    const open = createRefundRequest(first.id, RefundStatus.Open);
    const approved = createRefundRequest(second.id, RefundStatus.Approved);
    const declined = createRefundRequest(third.id, RefundStatus.Declined);

    expect(listRefundRequests(RefundStatus.Open).map((r) => r.id)).toEqual([
      open.id,
    ]);
    expect(listRefundRequests(RefundStatus.Approved).map((r) => r.id)).toEqual(
      [approved.id]
    );
    expect(listRefundRequests(RefundStatus.Declined).map((r) => r.id)).toEqual(
      [declined.id]
    );
  });

  it("lists the oldest request first, so nothing waits longest unseen", () => {
    const { liam, course } = seedBasics();
    const newer = createRefundRequest(
      createPurchase(liam.id, course.id, 7900).id,
      RefundStatus.Open,
      "2026-02-10T10:00:00.000Z"
    );
    const older = createRefundRequest(
      createPurchase(liam.id, course.id, 7900).id,
      RefundStatus.Open,
      "2026-02-01T10:00:00.000Z"
    );

    expect(listRefundRequests(RefundStatus.Open).map((r) => r.id)).toEqual([
      older.id,
      newer.id,
    ]);
  });
});

describe("parseRefundRequestFilter", () => {
  it("shows Open Refund Requests when no filter is given", () => {
    expect(parseRefundRequestFilter(new URLSearchParams())).toBe(
      RefundStatus.Open
    );
  });

  it("accepts Approved and Declined", () => {
    expect(
      parseRefundRequestFilter(new URLSearchParams("status=approved"))
    ).toBe(RefundStatus.Approved);
    expect(
      parseRefundRequestFilter(new URLSearchParams("status=declined"))
    ).toBe(RefundStatus.Declined);
  });

  it("rejects an unknown status with a 400", () => {
    let thrown: unknown;
    try {
      parseRefundRequestFilter(new URLSearchParams("status=pending"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ init: { status: 400 } });
  });
});

describe("countOpenRefundRequests", () => {
  it("counts only Open Refund Requests", () => {
    const { liam, course } = seedBasics();
    createRefundRequest(createPurchase(liam.id, course.id, 7900).id);
    createRefundRequest(createPurchase(liam.id, course.id, 7900).id);
    createRefundRequest(
      createPurchase(liam.id, course.id, 7900).id,
      RefundStatus.Declined
    );

    expect(countOpenRefundRequests()).toBe(2);
  });

  it("is zero when there are none", () => {
    expect(countOpenRefundRequests()).toBe(0);
  });
});

describe("getRefundRequestDetail", () => {
  const now = new Date("2026-01-11T12:00:00.000Z");

  it("is null for a Refund Request that does not exist", () => {
    expect(getRefundRequestDetail(999, now)).toBeNull();
  });

  it("shows the buyer, course, amount paid, dates and reason", () => {
    const { liam, course } = seedBasics();
    const purchase = createPurchase(
      liam.id,
      course.id,
      5500,
      "2026-01-01T10:00:00.000Z"
    );
    const request = createRefundRequest(
      purchase.id,
      RefundStatus.Open,
      "2026-01-03T10:00:00.000Z",
      "I bought the wrong course by mistake."
    );

    expect(getRefundRequestDetail(request.id, now)).toMatchObject({
      id: request.id,
      status: RefundStatus.Open,
      reason: "I bought the wrong course by mistake.",
      requestedAt: "2026-01-03T10:00:00.000Z",
      purchasedAt: "2026-01-01T10:00:00.000Z",
      amountPaid: 5500,
      buyer: { id: liam.id, name: "Liam", email: "liam@example.com" },
      course: { id: course.id, title: "Introduction to TypeScript" },
    });
  });

  it("counts whole days since purchase", () => {
    const { liam, course } = seedBasics();
    const purchase = createPurchase(
      liam.id,
      course.id,
      7900,
      "2026-01-01T10:00:00.000Z"
    );
    const request = createRefundRequest(purchase.id);

    expect(getRefundRequestDetail(request.id, now)?.daysSincePurchase).toBe(10);
  });

  it("sums the furthest position reached in each of the course's lessons as watch time", () => {
    const { liam, course, instructor } = seedBasics();
    const [first, second] = createLessons(course.id, 2);
    const otherCourse = createCourse("Advanced Rust", instructor.id);
    const [otherLesson] = createLessons(otherCourse.id, 1);
    const watch = (lessonId: number, positionSeconds: number) =>
      db
        .insert(videoWatchEvents)
        .values({
          userId: liam.id,
          lessonId,
          eventType: "progress",
          positionSeconds,
        })
        .run();
    watch(first.id, 100);
    watch(first.id, 300);
    watch(first.id, 200);
    watch(second.id, 60);
    watch(otherLesson.id, 5000);

    const request = createRefundRequest(
      createPurchase(liam.id, course.id, 7900).id
    );

    expect(getRefundRequestDetail(request.id, now)?.watchedSeconds).toBe(360);
  });

  it("does not count other learners' watch time", () => {
    const { liam, course } = seedBasics();
    const [lesson] = createLessons(course.id, 1);
    const mia = createUser("Mia");
    db.insert(videoWatchEvents)
      .values({
        userId: mia.id,
        lessonId: lesson.id,
        eventType: "progress",
        positionSeconds: 900,
      })
      .run();
    const request = createRefundRequest(
      createPurchase(liam.id, course.id, 7900).id
    );

    expect(getRefundRequestDetail(request.id, now)?.watchedSeconds).toBe(0);
  });

  it("shows completed lessons out of the course's total", () => {
    const { liam, course } = seedBasics();
    const [first, second, third] = createLessons(course.id, 4);
    db.insert(lessonProgress)
      .values([
        {
          userId: liam.id,
          lessonId: first.id,
          status: LessonProgressStatus.Completed,
        },
        {
          userId: liam.id,
          lessonId: second.id,
          status: LessonProgressStatus.Completed,
        },
        {
          userId: liam.id,
          lessonId: third.id,
          status: LessonProgressStatus.InProgress,
        },
      ])
      .run();
    const request = createRefundRequest(
      createPurchase(liam.id, course.id, 7900).id
    );

    expect(getRefundRequestDetail(request.id, now)?.lessonCompletion).toEqual({
      completedLessons: 2,
      totalLessons: 4,
    });
  });

  it("lists the buyer's other Refund Requests on any purchase, newest first, with status and dates", () => {
    const { liam, course, instructor } = seedBasics();
    const otherCourse = createCourse("Advanced Rust", instructor.id);
    const mia = createUser("Mia");

    const declinedEarlier = createRefundRequest(
      createPurchase(liam.id, course.id, 7900).id,
      RefundStatus.Declined,
      "2025-11-01T10:00:00.000Z"
    );
    db.update(refunds)
      .set({ resolvedAt: "2025-11-02T10:00:00.000Z" })
      .where(eq(refunds.id, declinedEarlier.id))
      .run();
    const approvedOtherCourse = createRefundRequest(
      createPurchase(liam.id, otherCourse.id, 4900).id,
      RefundStatus.Approved,
      "2025-12-01T10:00:00.000Z"
    );
    createRefundRequest(
      createPurchase(mia.id, course.id, 7900).id,
      RefundStatus.Open
    );
    const current = createRefundRequest(
      createPurchase(liam.id, course.id, 7900).id
    );

    expect(getRefundRequestDetail(current.id, now)?.otherRefundRequests).toEqual(
      [
        {
          id: approvedOtherCourse.id,
          status: RefundStatus.Approved,
          requestedAt: "2025-12-01T10:00:00.000Z",
          resolvedAt: null,
          course: { id: otherCourse.id, title: "Advanced Rust" },
        },
        {
          id: declinedEarlier.id,
          status: RefundStatus.Declined,
          requestedAt: "2025-11-01T10:00:00.000Z",
          resolvedAt: "2025-11-02T10:00:00.000Z",
          course: { id: course.id, title: "Introduction to TypeScript" },
        },
      ]
    );
  });
});
