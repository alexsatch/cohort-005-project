import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { db } from "~/db";
import {
  categories,
  coupons,
  courses,
  CourseStatus,
  lessons,
  modules,
  purchases,
  teams,
  users,
  UserRole,
  videoWatchEvents,
} from "~/db/schema";
import {
  enroll,
  findSuspendedEnrollment,
  isEnrolled,
  listEnrollmentsForCourse,
  suspendEnrollment,
} from "~/lib/enrollments.server";
import { setCurrentUserId } from "~/lib/session";
import { useTestDatabase } from "~/test/db";
import { action as purchaseAction } from "./courses.$slug.purchase";
import { action as redeemAction } from "./redeem.$code";
import { action as requestRefundAction } from "./courses.$slug.refund";
import { loader as courseLoader } from "./courses.$slug";

useTestDatabase();

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SIXTY_DAYS_AGO = new Date(
  Date.now() - 60 * 24 * 60 * 60 * 1000
).toISOString();
const THREE_HOURS = 3 * 60 * 60;

function createUser(name: string, role: UserRole) {
  return db
    .insert(users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get();
}

/**
 * Liam bought the course sixty days ago, watched three hours of it, and was
 * refunded — so his Enrollment is suspended.
 */
function seedSuspendedLearner() {
  const instructor = createUser("Ivy", UserRole.Instructor);
  const liam = createUser("Liam", UserRole.Student);
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
  const module = db
    .insert(modules)
    .values({ courseId: course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  const lesson = db
    .insert(lessons)
    .values({ moduleId: module.id, title: "Types", position: 1 })
    .returning()
    .get();
  db.insert(purchases)
    .values({
      userId: liam.id,
      courseId: course.id,
      amountPaid: 7900,
      createdAt: SIXTY_DAYS_AGO,
    })
    .run();
  const original = enroll(liam.id, course.id);
  db.insert(videoWatchEvents)
    .values({
      userId: liam.id,
      lessonId: lesson.id,
      eventType: "progress",
      positionSeconds: THREE_HOURS,
      createdAt: SIXTY_DAYS_AGO,
    })
    .run();
  suspendEnrollment(liam.id, course.id);
  return { instructor, liam, course, lesson, original };
}

function seedTeamSeat(buyerId: number, courseId: number, code: string) {
  const team = db.insert(teams).values({}).returning().get();
  const purchase = db
    .insert(purchases)
    .values({ userId: buyerId, courseId, amountPaid: 7900 * 5 })
    .returning()
    .get();
  db.insert(coupons)
    .values({ teamId: team.id, courseId, code, purchaseId: purchase.id })
    .run();
}

async function postAs(
  userId: number,
  url: string,
  fields: Record<string, string>
) {
  const setCookie = await setCurrentUserId(new Request(url), userId);
  return new Request(url, {
    method: "POST",
    headers: { Cookie: setCookie.split(";")[0], "CF-IPCountry": "US" },
    body: new URLSearchParams(fields),
  });
}

async function getAs(userId: number, url: string) {
  const setCookie = await setCurrentUserId(new Request(url), userId);
  return new Request(url, {
    headers: { Cookie: setCookie.split(";")[0], "CF-IPCountry": "US" },
  });
}

async function buy(userId: number, slug: string) {
  const url = `http://localhost/courses/${slug}/purchase`;
  return purchaseAction({
    request: await postAs(userId, url, { intent: "confirm-purchase" }),
    params: { slug },
    context: new RouterContextProvider(),
    url: new URL(url),
    pattern: "/courses/:slug/purchase",
  });
}

async function redeem(userId: number, code: string) {
  const url = `http://localhost/redeem/${code}`;
  return redeemAction({
    request: await postAs(userId, url, { intent: "confirm-redeem" }),
    params: { code },
    context: new RouterContextProvider(),
    url: new URL(url),
    pattern: "/redeem/:code",
  });
}

async function requestRefund(userId: number, slug: string) {
  const url = `http://localhost/courses/${slug}/refund`;
  return requestRefundAction({
    request: await postAs(userId, url, {
      reason: "Bought it again by mistake, sorry.",
    }),
    params: { slug },
    context: new RouterContextProvider(),
    url: new URL(url),
    pattern: "/courses/:slug/refund",
  });
}

async function viewCourse(userId: number, slug: string) {
  const url = `http://localhost/courses/${slug}`;
  return courseLoader({
    request: await getAs(userId, url),
    params: { slug },
    context: new RouterContextProvider(),
    url: new URL(url),
    pattern: "/courses/:slug",
  });
}

function expectResumed(
  userId: number,
  courseId: number,
  original: { id: number; enrolledAt: string }
) {
  expect(isEnrolled(userId, courseId)).toBe(true);
  expect(findSuspendedEnrollment(userId, courseId)).toBeUndefined();
  expect(listEnrollmentsForCourse(courseId)).toMatchObject([
    { enrollmentId: original.id, userId, enrolledAt: original.enrolledAt },
  ]);
}

describe("buying the course again", () => {
  it("resumes the Suspended Enrollment instead of creating another", async () => {
    const { liam, course, original } = seedSuspendedLearner();

    await expect(buy(liam.id, course.slug)).rejects.toBeInstanceOf(Response);

    expectResumed(liam.id, course.id, original);
  });

  it("still sends an already-enrolled learner back to the course", async () => {
    const { liam, course, original } = seedSuspendedLearner();
    await buy(liam.id, course.slug).catch(() => {});

    await expect(buy(liam.id, course.slug)).rejects.toSatisfy(
      (thrown) =>
        thrown instanceof Response &&
        thrown.headers.get("Location") === `/courses/${course.slug}`
    );
    expectResumed(liam.id, course.id, original);
  });
});

describe("claiming a Team Seat for the course", () => {
  it("resumes the Suspended Enrollment instead of creating another", async () => {
    const { liam, course, original } = seedSuspendedLearner();
    const buyer = createUser("Bea", UserRole.Student);
    seedTeamSeat(buyer.id, course.id, "SEAT-1");

    await expect(redeem(liam.id, "SEAT-1")).rejects.toBeInstanceOf(Response);

    expectResumed(liam.id, course.id, original);
  });
});

describe("refunds on the new purchase", () => {
  it("are counted from the new purchase date, ignoring earlier watching", async () => {
    const { liam, course } = seedSuspendedLearner();
    await buy(liam.id, course.slug).catch(() => {});

    const page = await viewCourse(liam.id, course.slug);
    expect(page).toMatchObject({
      enrolled: true,
      refundOffer: { amount: 7900 },
    });

    const response = await requestRefund(liam.id, course.slug);
    expect(response).toBeInstanceOf(Response);
  });

  it("count watching done since the new purchase", async () => {
    const { liam, course, lesson } = seedSuspendedLearner();
    await buy(liam.id, course.slug).catch(() => {});
    db.insert(videoWatchEvents)
      .values({
        userId: liam.id,
        lessonId: lesson.id,
        eventType: "progress",
        positionSeconds: THREE_HOURS,
      })
      .run();

    const page = await viewCourse(liam.id, course.slug);
    expect(page).toMatchObject({ enrolled: true, refundOffer: null });

    await expect(requestRefund(liam.id, course.slug)).rejects.toMatchObject({
      init: { status: 403 },
    });
  });
});
