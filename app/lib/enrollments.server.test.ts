import { describe, it, expect } from "vitest";
import { db } from "~/db";
import {
  categories,
  courses,
  enrollments,
  users,
  CourseStatus,
  UserRole,
} from "~/db/schema";
import { useTestDatabase } from "~/test/db";
import {
  activeEnrollments,
  countEnrollmentsForCourse,
  enroll,
  findEnrollment,
  isEnrolled,
  listEnrolledCoursesForUser,
  listEnrollmentsForCourse,
} from "./enrollments.server";

function createLearner(name: string) {
  return db
    .insert(users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: UserRole.Student,
    })
    .returning()
    .get();
}

function createCourse(slug: string) {
  const instructor = db
    .insert(users)
    .values({
      name: `Instructor of ${slug}`,
      email: `instructor-${slug}@example.com`,
      role: UserRole.Instructor,
    })
    .returning()
    .get();
  const category = db
    .insert(categories)
    .values({ name: `Category ${slug}`, slug: `category-${slug}` })
    .returning()
    .get();
  return db
    .insert(courses)
    .values({
      title: `Course ${slug}`,
      slug,
      description: `About ${slug}`,
      salesCopy: `Buy ${slug}`,
      instructorId: instructor.id,
      categoryId: category.id,
      status: CourseStatus.Published,
      coverImageUrl: `https://example.com/${slug}.png`,
    })
    .returning()
    .get();
}

function insertEnrollment(
  userId: number,
  courseId: number,
  enrolledAt: string
) {
  return db
    .insert(enrollments)
    .values({ userId, courseId, enrolledAt })
    .returning()
    .get();
}

describe("enrollments", () => {
  useTestDatabase();

  describe("findEnrollment", () => {
    it("returns the learner's Enrollment in the course", () => {
      const ada = createLearner("Ada");
      const course = createCourse("typescript");
      const enrollment = insertEnrollment(
        ada.id,
        course.id,
        "2026-01-01T00:00:00.000Z"
      );

      expect(findEnrollment(ada.id, course.id)).toEqual(enrollment);
    });

    it("returns undefined when the learner is enrolled only in another course", () => {
      const ada = createLearner("Ada");
      const typescript = createCourse("typescript");
      const react = createCourse("react");
      insertEnrollment(ada.id, react.id, "2026-01-01T00:00:00.000Z");

      expect(findEnrollment(ada.id, typescript.id)).toBeUndefined();
    });
  });

  describe("isEnrolled", () => {
    it("is true for an enrolled learner and false for another learner", () => {
      const ada = createLearner("Ada");
      const liam = createLearner("Liam");
      const course = createCourse("typescript");
      insertEnrollment(ada.id, course.id, "2026-01-01T00:00:00.000Z");

      expect([
        isEnrolled(ada.id, course.id),
        isEnrolled(liam.id, course.id),
      ]).toEqual([true, false]);
    });
  });

  describe("enroll", () => {
    it("makes the learner enrolled in the course", () => {
      const ada = createLearner("Ada");
      const course = createCourse("typescript");

      const enrollment = enroll(ada.id, course.id);

      expect(findEnrollment(ada.id, course.id)).toEqual(enrollment);
    });

    it("returns a new Enrollment that has not been completed", () => {
      const ada = createLearner("Ada");
      const course = createCourse("typescript");

      const enrollment = enroll(ada.id, course.id);

      expect(enrollment).toMatchObject({
        userId: ada.id,
        courseId: course.id,
        completedAt: null,
      });
    });
  });

  describe("listEnrolledCoursesForUser", () => {
    it("lists each of the learner's Enrollments with its course, and no one else's", () => {
      const ada = createLearner("Ada");
      const liam = createLearner("Liam");
      const typescript = createCourse("typescript");
      const react = createCourse("react");
      const adaTypescript = insertEnrollment(
        ada.id,
        typescript.id,
        "2026-01-01T00:00:00.000Z"
      );
      insertEnrollment(liam.id, react.id, "2026-01-02T00:00:00.000Z");

      expect(listEnrolledCoursesForUser(ada.id)).toEqual([
        {
          enrollmentId: adaTypescript.id,
          courseId: typescript.id,
          enrolledAt: "2026-01-01T00:00:00.000Z",
          completedAt: null,
          courseTitle: "Course typescript",
          courseSlug: "typescript",
          courseDescription: "About typescript",
          coverImageUrl: "https://example.com/typescript.png",
        },
      ]);
    });
  });

  describe("listEnrollmentsForCourse", () => {
    it("lists the learners enrolled in the course, and not in other courses", () => {
      const ada = createLearner("Ada");
      const liam = createLearner("Liam");
      const typescript = createCourse("typescript");
      const react = createCourse("react");
      const adaTypescript = insertEnrollment(
        ada.id,
        typescript.id,
        "2026-01-01T00:00:00.000Z"
      );
      const liamTypescript = insertEnrollment(
        liam.id,
        typescript.id,
        "2026-01-02T00:00:00.000Z"
      );
      insertEnrollment(ada.id, react.id, "2026-01-03T00:00:00.000Z");

      expect(listEnrollmentsForCourse(typescript.id)).toEqual([
        {
          enrollmentId: adaTypescript.id,
          userId: ada.id,
          enrolledAt: "2026-01-01T00:00:00.000Z",
          completedAt: null,
        },
        {
          enrollmentId: liamTypescript.id,
          userId: liam.id,
          enrolledAt: "2026-01-02T00:00:00.000Z",
          completedAt: null,
        },
      ]);
    });
  });

  describe("countEnrollmentsForCourse", () => {
    it("counts the course's Enrollments", () => {
      const ada = createLearner("Ada");
      const liam = createLearner("Liam");
      const typescript = createCourse("typescript");
      const react = createCourse("react");
      insertEnrollment(ada.id, typescript.id, "2026-01-01T00:00:00.000Z");
      insertEnrollment(liam.id, typescript.id, "2026-01-02T00:00:00.000Z");
      insertEnrollment(ada.id, react.id, "2026-01-03T00:00:00.000Z");

      expect(countEnrollmentsForCourse(typescript.id)).toBe(2);
    });

    it("is zero for a course nobody is enrolled in", () => {
      const course = createCourse("typescript");

      expect(countEnrollmentsForCourse(course.id)).toBe(0);
    });
  });

  describe("activeEnrollments", () => {
    it("can be queried in place of the enrollments table", () => {
      const ada = createLearner("Ada");
      const course = createCourse("typescript");
      const enrollment = insertEnrollment(
        ada.id,
        course.id,
        "2026-01-01T00:00:00.000Z"
      );

      const active = activeEnrollments();
      expect(db.select().from(active).all()).toEqual([enrollment]);
    });
  });
});
