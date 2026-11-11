import { data } from "react-router";
import { z } from "zod";
import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  purchases,
  refunds,
  RefundStatus,
  users,
  videoWatchEvents,
} from "~/db/schema";

// ─── Refund Requests ───
// Each row of the `refunds` table is a Refund Request (see GLOSSARY.md): a
// buyer's ask to get back what they paid for one purchase. This module is the
// admin side of them: listing, reading the details, and (later) deciding them.

const refundRequestFilterSchema = z.object({
  status: z.nativeEnum(RefundStatus).default(RefundStatus.Open),
});

/**
 * Reads the list filter from the URL. No `status` means Open Refund Requests;
 * an unknown one is a 400.
 */
export function parseRefundRequestFilter(
  searchParams: URLSearchParams
): RefundStatus {
  const result = refundRequestFilterSchema.safeParse({
    status: searchParams.get("status") ?? undefined,
  });

  if (!result.success) {
    throw data("Unknown Refund Request status", { status: 400 });
  }

  return result.data.status;
}

/** Refund Requests with the given status, oldest request first. */
export function listRefundRequests(status: RefundStatus) {
  const rows = db
    .select({
      id: refunds.id,
      status: refunds.status,
      requestedAt: refunds.requestedAt,
      amountPaid: purchases.amountPaid,
      buyerId: users.id,
      buyerName: users.name,
      buyerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.status, status))
    .orderBy(asc(refunds.requestedAt), asc(refunds.id))
    .all();

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    requestedAt: row.requestedAt,
    amountPaid: row.amountPaid,
    buyer: { id: row.buyerId, name: row.buyerName, email: row.buyerEmail },
    course: { id: row.courseId, title: row.courseTitle },
  }));
}

/** How many Refund Requests are waiting for a decision. */
export function countOpenRefundRequests(): number {
  const row = db
    .select({ value: count() })
    .from(refunds)
    .where(eq(refunds.status, RefundStatus.Open))
    .get();

  return row?.value ?? 0;
}

function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

// Same measure the buyer's refund action uses: the furthest position reached
// in each lesson of the course, summed.
function getWatchedSeconds(userId: number, lessonIds: number[]): number {
  if (lessonIds.length === 0) return 0;

  return db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]): number {
  if (lessonIds.length === 0) return 0;

  const row = db
    .select({ value: count() })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return row?.value ?? 0;
}

function wholeDaysBetween(fromIso: string, to: Date): number {
  const elapsed = to.getTime() - new Date(fromIso).getTime();
  return Math.max(0, Math.floor(elapsed / 86_400_000));
}

function getOtherRefundRequests(buyerId: number, excludeId: number) {
  return db
    .select({
      id: refunds.id,
      status: refunds.status,
      requestedAt: refunds.requestedAt,
      resolvedAt: refunds.resolvedAt,
      courseId: courses.id,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(and(eq(purchases.userId, buyerId), ne(refunds.id, excludeId)))
    .orderBy(desc(refunds.requestedAt), desc(refunds.id))
    .all()
    .map((row) => ({
      id: row.id,
      status: row.status,
      requestedAt: row.requestedAt,
      resolvedAt: row.resolvedAt,
      course: { id: row.courseId, title: row.courseTitle },
    }));
}

/**
 * Everything an admin reads before deciding a Refund Request. Watch time,
 * lesson completion, days since purchase and the buyer's other Refund
 * Requests are information only — none of them block a decision.
 *
 * Returns null when there is no such Refund Request.
 */
export function getRefundRequestDetail(id: number, now: Date = new Date()) {
  const row = db
    .select({
      id: refunds.id,
      status: refunds.status,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      resolvedAt: refunds.resolvedAt,
      purchasedAt: purchases.createdAt,
      amountPaid: purchases.amountPaid,
      buyerId: users.id,
      buyerName: users.name,
      buyerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, id))
    .get();

  if (!row) return null;

  const lessonIds = getLessonIdsForCourse(row.courseId);

  return {
    id: row.id,
    status: row.status,
    reason: row.reason,
    requestedAt: row.requestedAt,
    resolvedAt: row.resolvedAt,
    purchasedAt: row.purchasedAt,
    amountPaid: row.amountPaid,
    buyer: { id: row.buyerId, name: row.buyerName, email: row.buyerEmail },
    course: { id: row.courseId, title: row.courseTitle },
    watchedSeconds: getWatchedSeconds(row.buyerId, lessonIds),
    lessonCompletion: {
      completedLessons: getCompletedLessonCount(row.buyerId, lessonIds),
      totalLessons: lessonIds.length,
    },
    daysSincePurchase: wholeDaysBetween(row.purchasedAt, now),
    otherRefundRequests: getOtherRefundRequests(row.buyerId, row.id),
  };
}

export type RefundRequestDetail = NonNullable<
  ReturnType<typeof getRefundRequestDetail>
>;
