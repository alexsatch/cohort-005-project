import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "~/db";
import {
  categories,
  courseRatings,
  courses,
  CourseStatus,
  enrollments,
  users,
  UserRole,
} from "~/db/schema";
import { enroll, suspendEnrollment } from "~/lib/enrollments.server";
import { useTestDatabase } from "~/test/db";
import {
  findRating,
  getCourseRatingSummaries,
  getRatingSummary,
} from "./ratings.server";

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

function rate(userId: number, courseId: number, rating: number) {
  db.insert(courseRatings).values({ userId, courseId, rating }).run();
}

// No public way to resume an Enrollment yet, so clear the suspension directly.
function resumeEnrollment(userId: number, courseId: number) {
  db.update(enrollments)
    .set({ suspendedAt: null })
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .run();
}

function setUp() {
  const instructor = createUser("Ivy", UserRole.Instructor);
  const course = createCourse("Introduction to TypeScript", instructor.id);
  const liam = createUser("Liam");
  const maya = createUser("Maya");
  enroll(liam.id, course.id);
  enroll(maya.id, course.id);
  rate(liam.id, course.id, 4);
  rate(maya.id, course.id, 2);
  return { course, liam, maya };
}

/**
 * The summary the catalogue and course page show (per course), and the one
 * instructor analytics shows (over a scope).
 */
function everyRatingSummary(courseId: number) {
  return {
    perCourse: getCourseRatingSummaries([courseId]).get(courseId),
    scoped: getRatingSummary(eq(courseRatings.courseId, courseId)),
  };
}

describe("rating summaries", () => {
  it("count every rating from learners with an active Enrollment", () => {
    const { course } = setUp();

    expect(everyRatingSummary(course.id)).toEqual({
      perCourse: { average: 3, count: 2 },
      scoped: { average: 3, count: 2 },
    });
  });

  it("leave out a refunded learner's rating while their Enrollment is suspended, keeping the rating", () => {
    const { course, liam } = setUp();

    suspendEnrollment(liam.id, course.id);

    expect(everyRatingSummary(course.id)).toEqual({
      perCourse: { average: 2, count: 1 },
      scoped: { average: 2, count: 1 },
    });
    expect(findRating(liam.id, course.id)?.rating).toBe(4);
  });

  it("count the rating again once the Enrollment resumes", () => {
    const { course, liam } = setUp();

    suspendEnrollment(liam.id, course.id);
    resumeEnrollment(liam.id, course.id);

    expect(everyRatingSummary(course.id)).toEqual({
      perCourse: { average: 3, count: 2 },
      scoped: { average: 3, count: 2 },
    });
  });

  it("show no rating when every rater's Enrollment is suspended", () => {
    const { course, liam, maya } = setUp();

    suspendEnrollment(liam.id, course.id);
    suspendEnrollment(maya.id, course.id);

    expect(everyRatingSummary(course.id)).toEqual({
      perCourse: { average: null, count: 0 },
      scoped: { average: null, count: 0 },
    });
  });

  it("keep counting a rating when the learner also has an active Enrollment", () => {
    const { course, liam } = setUp();

    suspendEnrollment(liam.id, course.id);
    enroll(liam.id, course.id);

    expect(everyRatingSummary(course.id)).toEqual({
      perCourse: { average: 3, count: 2 },
      scoped: { average: 3, count: 2 },
    });
  });

  it("keep counting ratings from people with no Enrollment", () => {
    const { course } = setUp();
    const staff = createUser("Sam", UserRole.Admin);
    rate(staff.id, course.id, 5);

    expect(everyRatingSummary(course.id)).toEqual({
      perCourse: { average: 3.7, count: 3 },
      scoped: { average: 3.7, count: 3 },
    });
  });
});
