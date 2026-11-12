import { and, eq, inArray, not, sql, type SQL } from "drizzle-orm";
import { db } from "~/db";
import { courseRatings, courses } from "~/db/schema";
import { onlySuspendedEnrollment } from "~/lib/enrollments.server";

// ─── Course ratings ───
// The one home for rating averages and counts, so the catalogue, the course
// page and instructor analytics agree on which ratings count.
//
// A rating from a learner whose Enrollment is suspended (their purchase was
// refunded) doesn't count. The rating is kept, and counts again when the
// Enrollment resumes.
//
// Uses positional parameters (project convention).

export type RatingSummary = {
  average: number | null;
  count: number;
};

const EMPTY_SUMMARY: RatingSummary = { average: null, count: 0 };

/** The condition a rating must meet to count toward averages and counts. */
function countedRatingsWhere(): SQL {
  return not(
    onlySuspendedEnrollment(courseRatings.userId, courseRatings.courseId)
  );
}

function toSummary(average: number | null, count: number): RatingSummary {
  if (count === 0 || average === null) return EMPTY_SUMMARY;
  return { average: Math.round(average * 10) / 10, count };
}

/** A learner's own rating of a course, whether or not it counts. */
export function findRating(userId: number, courseId: number) {
  return db
    .select()
    .from(courseRatings)
    .where(
      and(
        eq(courseRatings.userId, userId),
        eq(courseRatings.courseId, courseId)
      )
    )
    .get();
}

/** Each course's rating summary; courses with no counted ratings get an empty one. */
export function getCourseRatingSummaries(
  courseIds: number[]
): Map<number, RatingSummary> {
  const summaries = new Map<number, RatingSummary>();

  if (courseIds.length === 0) return summaries;

  const rows = db
    .select({
      courseId: courseRatings.courseId,
      average: sql<number | null>`avg(${courseRatings.rating})`,
      count: sql<number>`count(*)`,
    })
    .from(courseRatings)
    .where(
      and(inArray(courseRatings.courseId, courseIds), countedRatingsWhere())
    )
    .groupBy(courseRatings.courseId)
    .all();

  for (const row of rows) {
    summaries.set(row.courseId, toSummary(row.average, row.count));
  }

  for (const courseId of courseIds) {
    if (!summaries.has(courseId)) {
      summaries.set(courseId, EMPTY_SUMMARY);
    }
  }

  return summaries;
}

export function getCourseRatingSummary(courseId: number): RatingSummary {
  return getCourseRatingSummaries([courseId]).get(courseId) ?? EMPTY_SUMMARY;
}

/**
 * One rating summary across many courses, narrowed by `scope` — a condition
 * over `courseRatings` and `courses` (joined), such as an instructor and a
 * date range.
 */
export function getRatingSummary(scope?: SQL): RatingSummary {
  const row = db
    .select({
      average: sql<number | null>`avg(${courseRatings.rating})`,
      count: sql<number>`count(*)`,
    })
    .from(courseRatings)
    .innerJoin(courses, eq(courseRatings.courseId, courses.id))
    .where(and(scope, countedRatingsWhere()))
    .get();

  return row ? toSummary(row.average, row.count) : EMPTY_SUMMARY;
}
