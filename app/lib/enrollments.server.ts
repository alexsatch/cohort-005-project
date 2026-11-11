import { and, eq, sql } from "drizzle-orm";
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

/**
 * The condition an Enrollment must meet to count: to give access, to show on
 * the learner's dashboard and to count in instructor numbers. Every Enrollment
 * counts today.
 */
function activeEnrollmentsWhere() {
  return sql`1 = 1`;
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

/** Enroll a learner in a course. Callers check they aren't enrolled first. */
export function enroll(userId: number, courseId: number): Enrollment {
  return db.insert(enrollments).values({ userId, courseId }).returning().get();
}
