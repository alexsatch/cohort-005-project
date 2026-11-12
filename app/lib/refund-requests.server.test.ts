import { afterEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "~/db";
import {
  categories,
  coupons,
  courses,
  CourseStatus,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  purchases,
  RefundMoneyStatus,
  refunds,
  RefundRequestEventType,
  RefundStatus,
  teams,
  users,
  UserRole,
  videoWatchEvents,
} from "~/db/schema";
import {
  countEnrollmentsForCourse,
  enroll,
  findSuspendedEnrollment,
  isEnrolled,
  listEnrolledCoursesForUser,
} from "~/lib/enrollments.server";
import { useTestDatabase } from "~/test/db";
import {
  approveRefundRequest,
  countOpenRefundRequests,
  declineRefundRequest,
  getRefundRequestAuditTrail,
  getRefundRequestDetail,
  listRefundRequests,
  markRefundFailed,
  markRefundIssued,
  parseRefundRequestFilter,
  retryRefund,
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

describe("declineRefundRequest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const decidedAt = new Date("2026-01-05T09:30:00.000Z");

  function setUp() {
    const { liam, course } = seedBasics();
    const ada = createUser("Ada", UserRole.Admin);
    const request = createRefundRequest(
      createPurchase(liam.id, course.id, 7900).id
    );
    return { liam, course, ada, request };
  }

  function silenceEmailLog() {
    return vi.spyOn(console, "log").mockImplementation(() => {});
  }

  it("declines an Open Refund Request and records who declined it, when, and why", () => {
    silenceEmailLog();
    const { ada, request } = setUp();

    const result = declineRefundRequest(
      request.id,
      ada.id,
      { reason: "  You have watched most of the course.  " },
      decidedAt
    );

    expect(result.outcome).toBe("declined");
    expect(getRefundRequestDetail(request.id)).toMatchObject({
      status: RefundStatus.Declined,
      resolvedAt: "2026-01-05T09:30:00.000Z",
    });
    expect(getRefundRequestAuditTrail(request.id)).toEqual([
      {
        id: expect.any(Number),
        type: RefundRequestEventType.Declined,
        note: "You have watched most of the course.",
        createdAt: "2026-01-05T09:30:00.000Z",
        actor: { id: ada.id, name: "Ada" },
      },
    ]);
  });

  it("shows the audit trail on the detail", () => {
    silenceEmailLog();
    const { ada, request } = setUp();
    declineRefundRequest(request.id, ada.id, { reason: "Too late." }, decidedAt);

    expect(getRefundRequestDetail(request.id)?.auditTrail).toMatchObject([
      { type: RefundRequestEventType.Declined, note: "Too late." },
    ]);
  });

  it("emails the buyer the course and the reason", () => {
    const log = silenceEmailLog();
    const { ada, request } = setUp();

    const result = declineRefundRequest(
      request.id,
      ada.id,
      { reason: "You have watched most of the course." },
      decidedAt
    );

    if (result.outcome !== "declined") throw new Error(result.outcome);
    expect(result.email.to).toBe("liam@example.com");
    expect(result.email.subject).toContain("Introduction to TypeScript");
    expect(result.email.body).toContain("You have watched most of the course.");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("You have watched most of the course.")
    );
  });

  it.each([[""], ["   "], [null]])(
    "rejects a missing reason (%j) with a field error and changes nothing",
    (reason) => {
      const log = silenceEmailLog();
      const { ada, request } = setUp();

      const result = declineRefundRequest(
        request.id,
        ada.id,
        { reason },
        decidedAt
      );

      expect(result).toEqual({
        outcome: "invalid",
        errors: { reason: expect.any(String) },
      });
      expect(getRefundRequestDetail(request.id)).toMatchObject({
        status: RefundStatus.Open,
        resolvedAt: null,
      });
      expect(getRefundRequestAuditTrail(request.id)).toEqual([]);
      expect(log).not.toHaveBeenCalled();
    }
  );

  it("first decision wins: a second decline is rejected with who decided it and how, and changes nothing", () => {
    const log = silenceEmailLog();
    const { ada, request } = setUp();
    const bob = createUser("Bob", UserRole.Admin);
    declineRefundRequest(request.id, ada.id, { reason: "First." }, decidedAt);
    log.mockClear();

    const result = declineRefundRequest(
      request.id,
      bob.id,
      { reason: "Second." },
      new Date("2026-01-06T09:30:00.000Z")
    );

    expect(result).toEqual({
      outcome: "already-decided",
      alreadyDecided: {
        status: RefundStatus.Declined,
        decidedBy: { id: ada.id, name: "Ada" },
        message: "Already declined by Ada.",
      },
    });
    expect(getRefundRequestDetail(request.id)?.resolvedAt).toBe(
      "2026-01-05T09:30:00.000Z"
    );
    expect(getRefundRequestAuditTrail(request.id)).toMatchObject([
      { note: "First.", actor: { id: ada.id } },
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  it("says how a request was decided when it was approved by someone else", () => {
    silenceEmailLog();
    const { ada, request } = setUp();
    const bob = createUser("Bob", UserRole.Admin);
    db.update(refunds)
      .set({
        status: RefundStatus.Approved,
        resolvedAt: "2026-01-04T10:00:00.000Z",
        resolvedByUserId: bob.id,
      })
      .where(eq(refunds.id, request.id))
      .run();

    const result = declineRefundRequest(
      request.id,
      ada.id,
      { reason: "Nope." },
      decidedAt
    );

    expect(result).toMatchObject({
      outcome: "already-decided",
      alreadyDecided: { message: "Already approved by Bob." },
    });
    expect(getRefundRequestDetail(request.id)?.status).toBe(
      RefundStatus.Approved
    );
    expect(getRefundRequestAuditTrail(request.id)).toEqual([]);
  });

  it("throws a 404 for a Refund Request that does not exist", () => {
    const ada = createUser("Ada", UserRole.Admin);
    expect(() =>
      declineRefundRequest(999, ada.id, { reason: "Why not." }, decidedAt)
    ).toThrow(expect.objectContaining({ init: { status: 404 } }));
  });
});

describe("approveRefundRequest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const decidedAt = new Date("2026-01-05T09:30:00.000Z");

  function setUp() {
    const { liam, course } = seedBasics();
    const ada = createUser("Ada", UserRole.Admin);
    enroll(liam.id, course.id);
    const purchase = createPurchase(liam.id, course.id, 7900);
    const request = createRefundRequest(purchase.id);
    return { liam, course, ada, purchase, request };
  }

  function silenceEmailLog() {
    return vi.spyOn(console, "log").mockImplementation(() => {});
  }

  it("approves an Open Refund Request with a Pending Refund for the full amount paid, and records who approved it", () => {
    silenceEmailLog();
    const { ada, request } = setUp();

    const result = approveRefundRequest(
      request.id,
      ada.id,
      { note: "  Fair enough.  " },
      decidedAt
    );

    expect(result.outcome).toBe("approved");
    expect(getRefundRequestDetail(request.id)).toMatchObject({
      status: RefundStatus.Approved,
      resolvedAt: "2026-01-05T09:30:00.000Z",
      refund: { status: RefundMoneyStatus.Pending, amount: 7900 },
    });
    expect(getRefundRequestAuditTrail(request.id)).toEqual([
      {
        id: expect.any(Number),
        type: RefundRequestEventType.Approved,
        note: "Fair enough.",
        createdAt: "2026-01-05T09:30:00.000Z",
        actor: { id: ada.id, name: "Ada" },
      },
    ]);
  });

  it("needs no note", () => {
    silenceEmailLog();
    const { ada, request } = setUp();

    expect(
      approveRefundRequest(request.id, ada.id, { note: "" }, decidedAt)
    ).toMatchObject({ outcome: "approved" });
    expect(getRefundRequestAuditTrail(request.id)).toMatchObject([
      { type: RefundRequestEventType.Approved, note: null },
    ]);
  });

  it("has no Refund before it is approved", () => {
    const { request } = setUp();
    expect(getRefundRequestDetail(request.id)?.refund).toBeNull();
  });

  it("emails the buyer that their money is on its way, with the amount and course", () => {
    const log = silenceEmailLog();
    const { ada, request } = setUp();

    const result = approveRefundRequest(request.id, ada.id, {}, decidedAt);

    if (result.outcome !== "approved") throw new Error(result.outcome);
    expect(result.email.to).toBe("liam@example.com");
    expect(result.email.subject).toContain("Introduction to TypeScript");
    expect(result.email.body).toContain("on its way");
    expect(result.email.body).toContain("$79");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Introduction to TypeScript")
    );
  });

  it("suspends the buyer's Enrollment and keeps their progress", () => {
    silenceEmailLog();
    const { ada, liam, course, request } = setUp();
    const courseLessons = createLessons(course.id, 3);
    db.insert(lessonProgress)
      .values(
        courseLessons.slice(0, 2).map((lesson) => ({
          userId: liam.id,
          lessonId: lesson.id,
          status: LessonProgressStatus.Completed,
          completedAt: "2026-01-02T10:00:00.000Z",
        }))
      )
      .run();

    approveRefundRequest(request.id, ada.id, {}, decidedAt);

    expect(isEnrolled(liam.id, course.id)).toBe(false);
    expect(findSuspendedEnrollment(liam.id, course.id)).toMatchObject({
      userId: liam.id,
      courseId: course.id,
      suspendedAt: "2026-01-05T09:30:00.000Z",
    });
    expect(getRefundRequestDetail(request.id)?.lessonCompletion).toEqual({
      completedLessons: 2,
      totalLessons: 3,
    });
  });

  it("takes the course off the learner's dashboard and out of the course's learner count", () => {
    silenceEmailLog();
    const { ada, liam, course, request } = setUp();
    const olivia = createUser("Olivia");
    enroll(olivia.id, course.id);

    approveRefundRequest(request.id, ada.id, {}, decidedAt);

    expect(listEnrolledCoursesForUser(liam.id)).toEqual([]);
    expect(countEnrollmentsForCourse(course.id)).toBe(1);
  });

  it("is allowed after the fourteen-day window has closed", () => {
    silenceEmailLog();
    const { ada, request } = setUp();

    const result = approveRefundRequest(
      request.id,
      ada.id,
      {},
      new Date("2026-03-01T10:00:00.000Z")
    );

    expect(result.outcome).toBe("approved");
    expect(getRefundRequestDetail(request.id)?.status).toBe(
      RefundStatus.Approved
    );
  });

  it("is rejected for an already-decided request, and changes nothing", () => {
    const log = silenceEmailLog();
    const { ada, liam, course, request } = setUp();
    const bob = createUser("Bob", UserRole.Admin);
    declineRefundRequest(request.id, bob.id, { reason: "No." }, decidedAt);
    log.mockClear();

    const result = approveRefundRequest(request.id, ada.id, {}, decidedAt);

    expect(result).toMatchObject({
      outcome: "already-decided",
      alreadyDecided: { message: "Already declined by Bob." },
    });
    expect(getRefundRequestDetail(request.id)).toMatchObject({
      status: RefundStatus.Declined,
      refund: null,
    });
    expect(getRefundRequestAuditTrail(request.id)).toHaveLength(1);
    expect(isEnrolled(liam.id, course.id)).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it("suspends no Enrollment for a team purchase", () => {
    silenceEmailLog();
    const { liam, course } = seedBasics();
    const ada = createUser("Ada", UserRole.Admin);
    const boss = createUser("Boss");
    const purchase = createPurchase(boss.id, course.id, 39500);
    const team = db.insert(teams).values({}).returning().get();
    db.insert(coupons)
      .values([
        {
          teamId: team.id,
          courseId: course.id,
          code: "SEAT-1",
          purchaseId: purchase.id,
          redeemedByUserId: liam.id,
          redeemedAt: "2026-01-02T10:00:00.000Z",
        },
        {
          teamId: team.id,
          courseId: course.id,
          code: "SEAT-2",
          purchaseId: purchase.id,
        },
      ])
      .run();
    enroll(liam.id, course.id);
    enroll(boss.id, course.id);
    const request = createRefundRequest(purchase.id);

    const result = approveRefundRequest(request.id, ada.id, {}, decidedAt);

    expect(result.outcome).toBe("approved");
    expect(getRefundRequestDetail(request.id)?.refund).toEqual({
      status: RefundMoneyStatus.Pending,
      amount: 39500,
    });
    expect(isEnrolled(liam.id, course.id)).toBe(true);
    expect(isEnrolled(boss.id, course.id)).toBe(true);
  });

  it("throws a 404 for a Refund Request that does not exist", () => {
    const ada = createUser("Ada", UserRole.Admin);
    expect(() => approveRefundRequest(999, ada.id, {}, decidedAt)).toThrow(
      expect.objectContaining({ init: { status: 404 } })
    );
  });
});

describe("tracking the money of a Refund", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const approvedAt = new Date("2026-01-05T09:30:00.000Z");
  const stepAt = new Date("2026-01-06T11:00:00.000Z");

  function setUpApproved() {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { liam, course } = seedBasics();
    const ada = createUser("Ada", UserRole.Admin);
    enroll(liam.id, course.id);
    const purchase = createPurchase(liam.id, course.id, 7900);
    const request = createRefundRequest(purchase.id);
    approveRefundRequest(request.id, ada.id, {}, approvedAt);
    const log = vi.mocked(console.log);
    log.mockClear();
    return { liam, course, ada, request, log };
  }

  function moneyStatus(id: number) {
    return getRefundRequestDetail(id)?.refund?.status;
  }

  function expectStillApprovedAndSuspended(
    id: number,
    liamId: number,
    courseId: number
  ) {
    expect(getRefundRequestDetail(id)?.status).toBe(RefundStatus.Approved);
    expect(isEnrolled(liamId, courseId)).toBe(false);
    expect(findSuspendedEnrollment(liamId, courseId)).toBeDefined();
  }

  describe("markRefundIssued", () => {
    it("moves a Pending Refund to Issued and records the step with its note", () => {
      const { ada, request } = setUpApproved();

      const result = markRefundIssued(
        request.id,
        ada.id,
        { note: "  Bank ref 12345  " },
        stepAt
      );

      expect(result.outcome).toBe("issued");
      expect(moneyStatus(request.id)).toBe(RefundMoneyStatus.Issued);
      expect(getRefundRequestAuditTrail(request.id).at(-1)).toEqual({
        id: expect.any(Number),
        type: RefundRequestEventType.RefundIssued,
        note: "Bank ref 12345",
        createdAt: "2026-01-06T11:00:00.000Z",
        actor: { id: ada.id, name: "Ada" },
      });
    });

    it("emails the buyer that the money was sent, with the amount and course", () => {
      const { ada, request, log } = setUpApproved();

      const result = markRefundIssued(request.id, ada.id, {}, stepAt);

      if (result.outcome !== "issued") throw new Error(result.outcome);
      expect(result.email.to).toBe("liam@example.com");
      expect(result.email.subject).toContain("Introduction to TypeScript");
      expect(result.email.body).toContain("sent");
      expect(result.email.body).toContain("$79");
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("liam@example.com")
      );
    });

    it("needs no note", () => {
      const { ada, request } = setUpApproved();

      markRefundIssued(request.id, ada.id, { note: "" }, stepAt);

      expect(getRefundRequestAuditTrail(request.id).at(-1)).toMatchObject({
        type: RefundRequestEventType.RefundIssued,
        note: null,
      });
    });

    it("returns a field error for an overlong note and changes nothing", () => {
      const { ada, request } = setUpApproved();

      const result = markRefundIssued(
        request.id,
        ada.id,
        { note: "x".repeat(1001) },
        stepAt
      );

      expect(result).toMatchObject({
        outcome: "invalid",
        errors: { note: expect.any(String) },
      });
      expect(moneyStatus(request.id)).toBe(RefundMoneyStatus.Pending);
      expect(getRefundRequestAuditTrail(request.id)).toHaveLength(1);
    });

    it("throws a 404 for a Refund Request that does not exist", () => {
      const ada = createUser("Ada", UserRole.Admin);
      expect(() => markRefundIssued(999, ada.id, {}, stepAt)).toThrow(
        expect.objectContaining({ init: { status: 404 } })
      );
    });
  });

  describe("markRefundFailed", () => {
    it("moves a Pending Refund to Failed, records the step and emails no one", () => {
      const { ada, request, log } = setUpApproved();

      const result = markRefundFailed(
        request.id,
        ada.id,
        { note: "Account closed." },
        stepAt
      );

      expect(result).toEqual({ outcome: "failed" });
      expect(moneyStatus(request.id)).toBe(RefundMoneyStatus.Failed);
      expect(getRefundRequestAuditTrail(request.id).at(-1)).toMatchObject({
        type: RefundRequestEventType.RefundFailed,
        note: "Account closed.",
        actor: { id: ada.id },
      });
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe("retryRefund", () => {
    it("moves a Failed Refund back to Pending, records the step and emails no one", () => {
      const { ada, request, log } = setUpApproved();
      markRefundFailed(request.id, ada.id, {}, stepAt);

      const result = retryRefund(
        request.id,
        ada.id,
        { note: "New account details." },
        stepAt
      );

      expect(result).toEqual({ outcome: "retried" });
      expect(moneyStatus(request.id)).toBe(RefundMoneyStatus.Pending);
      expect(getRefundRequestAuditTrail(request.id).at(-1)).toMatchObject({
        type: RefundRequestEventType.RefundRetried,
        note: "New account details.",
      });
      expect(log).not.toHaveBeenCalled();
    });

    it("lets the money be sent after a retry", () => {
      const { ada, request } = setUpApproved();
      markRefundFailed(request.id, ada.id, {}, stepAt);
      retryRefund(request.id, ada.id, {}, stepAt);

      expect(markRefundIssued(request.id, ada.id, {}, stepAt).outcome).toBe(
        "issued"
      );
      expect(
        getRefundRequestAuditTrail(request.id).map((entry) => entry.type)
      ).toEqual([
        RefundRequestEventType.Approved,
        RefundRequestEventType.RefundFailed,
        RefundRequestEventType.RefundRetried,
        RefundRequestEventType.RefundIssued,
      ]);
    });
  });

  describe("illegal steps", () => {
    const steps = {
      markRefundIssued,
      markRefundFailed,
      retryRefund,
    } as const;

    it.each([
      ["Issued", "markRefundIssued", "issued"],
      ["Issued", "markRefundFailed", "issued"],
      ["Issued", "retryRefund", "issued"],
      ["Failed", "markRefundIssued", "failed"],
      ["Failed", "markRefundFailed", "failed"],
      ["Pending", "retryRefund", "pending"],
    ] as const)(
      "rejects %s → %s and changes nothing",
      (from, stepName, current) => {
        const { ada, request, log } = setUpApproved();
        if (from === "Issued") markRefundIssued(request.id, ada.id, {}, stepAt);
        if (from === "Failed") markRefundFailed(request.id, ada.id, {}, stepAt);
        const trailBefore = getRefundRequestAuditTrail(request.id);
        const statusBefore = moneyStatus(request.id);
        log.mockClear();

        const result = steps[stepName](request.id, ada.id, {}, stepAt);

        expect(result).toEqual({
          outcome: "not-allowed",
          notAllowed: {
            moneyStatus: current,
            message: `The Refund is already marked ${current}.`,
          },
        });
        expect(moneyStatus(request.id)).toBe(statusBefore);
        expect(getRefundRequestAuditTrail(request.id)).toEqual(trailBefore);
        expect(log).not.toHaveBeenCalled();
      }
    );

    it.each([RefundStatus.Open, RefundStatus.Declined])(
      "rejects any step on a %s Refund Request, which has no Refund",
      (status) => {
        const { liam, course } = seedBasics();
        const ada = createUser("Ada", UserRole.Admin);
        const purchase = createPurchase(liam.id, course.id, 7900);
        const request = createRefundRequest(purchase.id, status);

        for (const step of Object.values(steps)) {
          expect(step(request.id, ada.id, {}, stepAt)).toMatchObject({
            outcome: "not-allowed",
            notAllowed: { moneyStatus: null },
          });
        }
        expect(getRefundRequestDetail(request.id)).toMatchObject({
          status,
          refund: null,
        });
        expect(getRefundRequestAuditTrail(request.id)).toEqual([]);
      }
    );
  });

  describe("concurrent steps", () => {
    it("first wins: the second admin is told it is already marked, and nothing is written for them", () => {
      const { ada, request, log } = setUpApproved();
      const bob = createUser("Bob", UserRole.Admin);
      // Both admins saw a Pending Refund; Ada's click lands first.
      markRefundIssued(request.id, ada.id, { note: "Ref A" }, stepAt);
      log.mockClear();

      const result = markRefundFailed(
        request.id,
        bob.id,
        { note: "Ref B" },
        stepAt
      );

      expect(result).toMatchObject({
        outcome: "not-allowed",
        notAllowed: { message: "The Refund is already marked issued." },
      });
      expect(moneyStatus(request.id)).toBe(RefundMoneyStatus.Issued);
      expect(getRefundRequestAuditTrail(request.id)).toMatchObject([
        { type: RefundRequestEventType.Approved },
        { type: RefundRequestEventType.RefundIssued, actor: { id: ada.id } },
      ]);
      expect(log).not.toHaveBeenCalled();
    });

    it("sends the Issued email only once when two admins mark it sent", () => {
      const { ada, request, log } = setUpApproved();
      const bob = createUser("Bob", UserRole.Admin);

      markRefundIssued(request.id, ada.id, {}, stepAt);
      const second = markRefundIssued(request.id, bob.id, {}, stepAt);

      expect(second.outcome).toBe("not-allowed");
      expect(log).toHaveBeenCalledTimes(1);
      expect(getRefundRequestAuditTrail(request.id)).toHaveLength(2);
    });
  });

  it("keeps the Refund Request Approved and the Enrollment suspended through every money state", () => {
    const { ada, liam, course, request } = setUpApproved();
    expectStillApprovedAndSuspended(request.id, liam.id, course.id);

    markRefundFailed(request.id, ada.id, {}, stepAt);
    expectStillApprovedAndSuspended(request.id, liam.id, course.id);

    retryRefund(request.id, ada.id, {}, stepAt);
    expectStillApprovedAndSuspended(request.id, liam.id, course.id);

    markRefundIssued(request.id, ada.id, {}, stepAt);
    expectStillApprovedAndSuspended(request.id, liam.id, course.id);
    expect(findSuspendedEnrollment(liam.id, course.id)?.suspendedAt).toBe(
      "2026-01-05T09:30:00.000Z"
    );
  });
});
