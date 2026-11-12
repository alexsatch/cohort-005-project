import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "~/db";
import { courses, enrollments } from "~/db/schema";

// ─── Enrollments ───
// The one home for questions about Enrollments: "is this learner enrolled?",
// "who is enrolled in this course?", "enroll this learner".
//
// Every read goes through `activeEnrollmentsWhere`, so when an Enrollment can
// be suspended (docs/adr/0001-refunds-suspend-enrollments-and-keep-progress.md)
// tightening that one condition stops it granting access, showing on the
// dashboard and counting in instructor numbers.
//
// Uses positional parameters (project convention).

export type Enrollment = typeof enrollments.$inferSelect;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The condition an Enrollment must meet to count: to give access, to show on
 * the learner's dashboard and to count in instructor numbers. A Suspended
 * Enrollment does not count.
 */
function activeEnrollmentsWhere() {
  return isNull(enrollments.suspendedAt);
}

/**
 * The Enrollments that count, as a subquery for analytics that join
 * Enrollments inside a larger query. Select from it or join it in place of the
 * `enrollments` table; its columns carry the same names.
 */
export function activeEnrollments() {
  return db
    .select()
    .from(enrollments)
    .where(activeEnrollmentsWhere())
    .as("active_enrollments");
}

export function findEnrollment(
  userId: number,
  courseId: number
): Enrollment | undefined {
  return db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, courseId),
        activeEnrollmentsWhere()
      )
    )
    .get();
}

export function isEnrolled(userId: number, courseId: number): boolean {
  return findEnrollment(userId, courseId) !== undefined;
}

/** A learner's Enrollments, each with the course it is for. */
export function listEnrolledCoursesForUser(userId: number) {
  return db
    .select({
      enrollmentId: enrollments.id,
      courseId: enrollments.courseId,
      enrolledAt: enrollments.enrolledAt,
      completedAt: enrollments.completedAt,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      courseDescription: courses.description,
      coverImageUrl: courses.coverImageUrl,
    })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(and(eq(enrollments.userId, userId), activeEnrollmentsWhere()))
    .all();
}

/** The learners enrolled in a course. */
export function listEnrollmentsForCourse(courseId: number) {
  return db
    .select({
      enrollmentId: enrollments.id,
      userId: enrollments.userId,
      enrolledAt: enrollments.enrolledAt,
      completedAt: enrollments.completedAt,
    })
    .from(enrollments)
    .where(and(eq(enrollments.courseId, courseId), activeEnrollmentsWhere()))
    .all();
}

export function countEnrollmentsForCourse(courseId: number): number {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(enrollments)
    .where(and(eq(enrollments.courseId, courseId), activeEnrollmentsWhere()))
    .get();

  return result?.count ?? 0;
}

/**
 * Enroll a learner in a course. Callers check they aren't enrolled first.
 *
 * A learner with a Suspended Enrollment gets that same Enrollment back,
 * resumed with its original enrolment date and all their progress — getting
 * the course again never creates a second Enrollment (ADR 0001).
 */
export function enroll(userId: number, courseId: number): Enrollment {
  const suspended = findSuspendedEnrollment(userId, courseId);

  if (suspended) {
    return db
      .update(enrollments)
      .set({ suspendedAt: null })
      .where(eq(enrollments.id, suspended.id))
      .returning()
      .get();
  }

  return db.insert(enrollments).values({ userId, courseId }).returning().get();
}

/**
 * The learner's Suspended Enrollment in a course, if they have one: the
 * purchase behind it was refunded, and their progress is waiting for them.
 */
export function findSuspendedEnrollment(
  userId: number,
  courseId: number
): Enrollment | undefined {
  return db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, courseId),
        isNotNull(enrollments.suspendedAt)
      )
    )
    .get();
}

/**
 * Suspends a learner's Enrollment in a course, because the purchase behind it
 * was refunded. Nothing is deleted — progress stays (ADR 0001). Pass the
 * transaction when suspending is part of a larger change, so it commits or
 * rolls back with it. Returns whether an Enrollment was suspended.
 */
export function suspendEnrollment(
  userId: number,
  courseId: number,
  now: Date = new Date(),
  tx: Transaction | typeof db = db
): boolean {
  const result = tx
    .update(enrollments)
    .set({ suspendedAt: now.toISOString() })
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, courseId),
        activeEnrollmentsWhere()
      )
    )
    .run();

  return result.changes > 0;
}
