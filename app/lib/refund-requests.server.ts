import { data } from "react-router";
import { z } from "zod";
import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "~/db";
import { formatPrice } from "~/lib/utils";
import { suspendEnrollment } from "~/lib/enrollments.server";
import { voidUnclaimedTeamSeats } from "~/lib/team-seats.server";
import {
  coupons,
  courses,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  purchases,
  refundRequestEvents,
  RefundRequestEventType,
  RefundMoneyStatus,
  refunds,
  RefundStatus,
  users,
  videoWatchEvents,
} from "~/db/schema";

// ─── Refund Requests ───
// Each row of the `refunds` table is a Refund Request (see GLOSSARY.md): a
// buyer's ask to get back what they paid for one purchase. This module is the
// admin side of them: listing, reading the details, and deciding them.

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
      amountRefunded: refunds.amountRefunded,
      moneyStatus: refunds.moneyStatus,
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
    // The Refund, once the request is approved; null while Open or Declined.
    refund:
      row.moneyStatus != null && row.amountRefunded != null
        ? { status: row.moneyStatus, amount: row.amountRefunded }
        : null,
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
    auditTrail: getRefundRequestAuditTrail(row.id),
  };
}

export type RefundRequestDetail = NonNullable<
  ReturnType<typeof getRefundRequestDetail>
>;

// ─── Audit trail ───

/** Every step taken on a Refund Request, oldest first. */
export function getRefundRequestAuditTrail(refundRequestId: number) {
  return db
    .select({
      id: refundRequestEvents.id,
      type: refundRequestEvents.type,
      note: refundRequestEvents.note,
      createdAt: refundRequestEvents.createdAt,
      actorId: users.id,
      actorName: users.name,
    })
    .from(refundRequestEvents)
    .innerJoin(users, eq(refundRequestEvents.actorUserId, users.id))
    .where(eq(refundRequestEvents.refundRequestId, refundRequestId))
    .orderBy(asc(refundRequestEvents.createdAt), asc(refundRequestEvents.id))
    .all()
    .map((row) => ({
      id: row.id,
      type: row.type,
      note: row.note,
      createdAt: row.createdAt,
      actor: { id: row.actorId, name: row.actorName },
    }));
}

export type RefundRequestAuditEntry = ReturnType<
  typeof getRefundRequestAuditTrail
>[number];

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Appends one step to a Refund Request's audit trail. */
function recordRefundRequestEvent(
  tx: Transaction,
  refundRequestId: number,
  type: RefundRequestEventType,
  actorUserId: number,
  note: string | null,
  now: Date
) {
  tx.insert(refundRequestEvents)
    .values({
      refundRequestId,
      type,
      actorUserId,
      note,
      createdAt: now.toISOString(),
    })
    .run();
}

// ─── Deciding ───

type Decision = RefundStatus.Approved | RefundStatus.Declined;

const DECISION_EVENT: Record<Decision, RefundRequestEventType> = {
  [RefundStatus.Approved]: RefundRequestEventType.Approved,
  [RefundStatus.Declined]: RefundRequestEventType.Declined,
};

export type AlreadyDecided = {
  status: RefundStatus;
  decidedBy: { id: number; name: string } | null;
  message: string;
};

function describeAlreadyDecided(refundRequestId: number): AlreadyDecided {
  const row = db
    .select({
      status: refunds.status,
      deciderId: users.id,
      deciderName: users.name,
    })
    .from(refunds)
    .leftJoin(users, eq(refunds.resolvedByUserId, users.id))
    .where(eq(refunds.id, refundRequestId))
    .get();

  const status = row?.status ?? RefundStatus.Open;
  const decidedBy =
    row?.deciderId != null && row.deciderName != null
      ? { id: row.deciderId, name: row.deciderName }
      : null;

  return {
    status,
    decidedBy,
    message: decidedBy
      ? `Already ${status} by ${decidedBy.name}.`
      : `Already ${status}.`,
  };
}

/**
 * First decision wins. Moves a Refund Request from Open to the decision and
 * records the step in its audit trail — but only if it is still Open. The
 * status change is a conditional update, so of two admins deciding at once
 * exactly one succeeds; the other gets back who decided it and how, and
 * nothing is written for them.
 *
 * Call inside `db.transaction`, so whatever else the decision does (a Refund,
 * suspending an Enrollment) commits or rolls back with it.
 */
function decideIfStillOpen(
  tx: Transaction,
  refundRequestId: number,
  decision: Decision,
  actorUserId: number,
  note: string | null,
  now: Date
): { decided: true } | { decided: false; alreadyDecided: AlreadyDecided } {
  const result = tx
    .update(refunds)
    .set({
      status: decision,
      resolvedAt: now.toISOString(),
      resolvedByUserId: actorUserId,
    })
    .where(
      and(eq(refunds.id, refundRequestId), eq(refunds.status, RefundStatus.Open))
    )
    .run();

  if (result.changes === 0) {
    return {
      decided: false,
      alreadyDecided: describeAlreadyDecided(refundRequestId),
    };
  }

  recordRefundRequestEvent(
    tx,
    refundRequestId,
    DECISION_EVENT[decision],
    actorUserId,
    note,
    now
  );

  return { decided: true };
}

const declineSchema = z.object({
  reason: z
    .string({
      required_error: "Tell the buyer why their request is declined.",
      invalid_type_error: "Tell the buyer why their request is declined.",
    })
    .trim()
    .min(1, "Tell the buyer why their request is declined.")
    .max(1000, "Please keep the reason under 1000 characters."),
});

/**
 * The email the buyer gets when their Refund Request is declined. There is no
 * mail transport wired up yet, so the built message goes to the server log.
 */
function buildRefundRequestDeclinedEmail(input: {
  buyerName: string;
  buyerEmail: string;
  courseTitle: string;
  amountPaid: number;
  reason: string;
}) {
  return {
    to: input.buyerEmail,
    subject: `Refund request declined — ${input.courseTitle}`,
    body: [
      `Hi ${input.buyerName},`,
      "",
      `We have reviewed your refund request for "${input.courseTitle}" (${formatPrice(input.amountPaid)}), and we are not able to approve it.`,
      "",
      "Our reason:",
      input.reason,
      "",
      "If something has changed, you are welcome to raise a new refund request from the course page.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export type DeclineRefundRequestResult =
  | { outcome: "declined"; email: { to: string; subject: string; body: string } }
  | { outcome: "invalid"; errors: Record<string, string> }
  | { outcome: "already-decided"; alreadyDecided: AlreadyDecided };

/**
 * An admin declines an Open Refund Request with a reason, which is required.
 * The reason is the note on the `declined` step of the audit trail, and the
 * buyer is emailed it. Throws 404 when there is no such Refund Request.
 */
export function declineRefundRequest(
  refundRequestId: number,
  actorUserId: number,
  input: { reason: unknown },
  now: Date = new Date()
): DeclineRefundRequestResult {
  const parsed = declineSchema.safeParse(input);

  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const [key, messages] of Object.entries(
      parsed.error.flatten().fieldErrors
    )) {
      if (messages && messages.length > 0) errors[key] = messages[0];
    }
    return { outcome: "invalid", errors };
  }

  const request = db
    .select({
      amountPaid: purchases.amountPaid,
      buyerName: users.name,
      buyerEmail: users.email,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, refundRequestId))
    .get();

  if (!request) {
    throw data("Refund Request not found", { status: 404 });
  }

  const { reason } = parsed.data;
  const result = db.transaction((tx) =>
    decideIfStillOpen(
      tx,
      refundRequestId,
      RefundStatus.Declined,
      actorUserId,
      reason,
      now
    )
  );

  if (!result.decided) {
    return { outcome: "already-decided", alreadyDecided: result.alreadyDecided };
  }

  const email = buildRefundRequestDeclinedEmail({
    buyerName: request.buyerName,
    buyerEmail: request.buyerEmail,
    courseTitle: request.courseTitle,
    amountPaid: request.amountPaid,
    reason,
  });

  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return { outcome: "declined", email };
}

const approveSchema = z.object({
  note: z
    .string({ invalid_type_error: "The note must be text." })
    .trim()
    .max(1000, "Please keep the note under 1000 characters.")
    .nullish()
    .transform((note) => (note ? note : null)),
});

/**
 * The email the buyer gets when their Refund Request is approved. There is no
 * mail transport wired up yet, so the built message goes to the server log.
 */
function buildRefundRequestApprovedEmail(input: {
  buyerName: string;
  buyerEmail: string;
  courseTitle: string;
  amountRefunded: number;
}) {
  return {
    to: input.buyerEmail,
    subject: `Refund approved — ${input.courseTitle}`,
    body: [
      `Hi ${input.buyerName},`,
      "",
      `Your refund request for "${input.courseTitle}" has been approved. Your money is on its way: ${formatPrice(input.amountRefunded)} is being sent back to you.`,
      "",
      "Your progress in the course is saved, and will be back if you buy it again.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export type ApproveRefundRequestResult =
  | {
      outcome: "approved";
      email: { to: string; subject: string; body: string };
    }
  | { outcome: "invalid"; errors: Record<string, string> }
  | { outcome: "already-decided"; alreadyDecided: AlreadyDecided };

/**
 * An admin approves an Open Refund Request, with an optional note for the
 * audit trail. In one transaction it creates a Pending Refund for the full
 * amount paid and suspends the buyer's Enrollment in the course (ADR 0001:
 * suspended, never deleted — progress is kept). Nothing about the 14-day
 * window or watch time is checked: those inform the decision, not gate it.
 * The buyer is emailed only when this call is the one that approved it.
 * Throws 404 when there is no such Refund Request.
 */
export function approveRefundRequest(
  refundRequestId: number,
  actorUserId: number,
  input: { note?: unknown },
  now: Date = new Date()
): ApproveRefundRequestResult {
  const parsed = approveSchema.safeParse(input);

  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const [key, messages] of Object.entries(
      parsed.error.flatten().fieldErrors
    )) {
      if (messages && messages.length > 0) errors[key] = messages[0];
    }
    return { outcome: "invalid", errors };
  }

  const request = db
    .select({
      purchaseId: purchases.id,
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
    .where(eq(refunds.id, refundRequestId))
    .get();

  if (!request) {
    throw data("Refund Request not found", { status: 404 });
  }

  const { note } = parsed.data;
  const result = db.transaction((tx) => {
    const decision = decideIfStillOpen(
      tx,
      refundRequestId,
      RefundStatus.Approved,
      actorUserId,
      note,
      now
    );
    if (!decision.decided) return decision;

    // A Refund is always the full amount paid.
    tx.update(refunds)
      .set({
        moneyStatus: RefundMoneyStatus.Pending,
        amountRefunded: request.amountPaid,
      })
      .where(eq(refunds.id, refundRequestId))
      .run();

    if (isTeamPurchase(tx, request.purchaseId)) {
      // A team purchase paid for Team Seats, not the buyer's own Enrollment,
      // so no Enrollment is suspended; its unclaimed Team Seats are voided.
      voidUnclaimedTeamSeats(request.purchaseId, now, tx);
    } else {
      suspendEnrollment(request.buyerId, request.courseId, now, tx);
    }

    return decision;
  });

  if (!result.decided) {
    return {
      outcome: "already-decided",
      alreadyDecided: result.alreadyDecided,
    };
  }

  const email = buildRefundRequestApprovedEmail({
    buyerName: request.buyerName,
    buyerEmail: request.buyerEmail,
    courseTitle: request.courseTitle,
    amountRefunded: request.amountPaid,
  });

  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return { outcome: "approved", email };
}

/** A team purchase is one that bought Team Seats (each seat has a coupon). */
function isTeamPurchase(tx: Transaction, purchaseId: number): boolean {
  const seat = tx
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchaseId))
    .limit(1)
    .get();

  return seat !== undefined;
}

// ─── Tracking the money ───
// There is no payment provider yet, so admins move a Refund through its money
// states by hand. Each step is its own function, so a provider can call the
// same ones later. The Refund Request stays Approved and the Enrollment stays
// suspended throughout: only the money state moves.
//
//   Pending ──issued──▶ Issued
//   Pending ──failed──▶ Failed ──retried──▶ Pending

type RefundMoneyTransition = {
  from: RefundMoneyStatus;
  to: RefundMoneyStatus;
  event: RefundRequestEventType;
};

const MARK_ISSUED: RefundMoneyTransition = {
  from: RefundMoneyStatus.Pending,
  to: RefundMoneyStatus.Issued,
  event: RefundRequestEventType.RefundIssued,
};

const MARK_FAILED: RefundMoneyTransition = {
  from: RefundMoneyStatus.Pending,
  to: RefundMoneyStatus.Failed,
  event: RefundRequestEventType.RefundFailed,
};

const RETRY: RefundMoneyTransition = {
  from: RefundMoneyStatus.Failed,
  to: RefundMoneyStatus.Pending,
  event: RefundRequestEventType.RefundRetried,
};

export type RefundNotAllowed = {
  /** Where the Refund's money stands now; null when there is no Refund. */
  moneyStatus: RefundMoneyStatus | null;
  message: string;
};

function describeRefundMoney(refundRequestId: number): RefundNotAllowed {
  const row = db
    .select({ moneyStatus: refunds.moneyStatus })
    .from(refunds)
    .where(eq(refunds.id, refundRequestId))
    .get();

  const moneyStatus = row?.moneyStatus ?? null;

  return {
    moneyStatus,
    message:
      moneyStatus == null
        ? "This Refund Request has no Refund: it has not been approved."
        : `The Refund is already marked ${moneyStatus}.`,
  };
}

const refundStepSchema = z.object({
  note: z
    .string({ invalid_type_error: "The note must be text." })
    .trim()
    .max(1000, "Please keep the note under 1000 characters.")
    .nullish()
    .transform((note) => (note ? note : null)),
});

/** Why a money step didn't happen. Nothing is written in either case. */
export type RefundStepRejection =
  | { outcome: "invalid"; errors: Record<string, string> }
  | { outcome: "not-allowed"; notAllowed: RefundNotAllowed };

/**
 * Moves a Refund's money state along one transition and records the step in
 * the audit trail, but only if the Refund is still in the transition's
 * `from` state. The change is a conditional update on the expected state, so
 * of two admins clicking at once exactly one succeeds; the other is told
 * where the Refund already is, and nothing is written for them. The same
 * check rejects any step the state machine doesn't allow, including acting
 * on a Refund Request that has no Refund. Throws 404 when there is no such
 * Refund Request.
 */
function moveRefundMoney(
  refundRequestId: number,
  actorUserId: number,
  transition: RefundMoneyTransition,
  input: { note?: unknown },
  now: Date
): { outcome: "moved" } | RefundStepRejection {
  const parsed = refundStepSchema.safeParse(input);

  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const [key, messages] of Object.entries(
      parsed.error.flatten().fieldErrors
    )) {
      if (messages && messages.length > 0) errors[key] = messages[0];
    }
    return { outcome: "invalid", errors };
  }

  const exists = db
    .select({ id: refunds.id })
    .from(refunds)
    .where(eq(refunds.id, refundRequestId))
    .get();

  if (!exists) {
    throw data("Refund Request not found", { status: 404 });
  }

  const moved = db.transaction((tx) => {
    const result = tx
      .update(refunds)
      .set({ moneyStatus: transition.to })
      .where(
        and(
          eq(refunds.id, refundRequestId),
          eq(refunds.status, RefundStatus.Approved),
          eq(refunds.moneyStatus, transition.from)
        )
      )
      .run();

    if (result.changes === 0) return false;

    recordRefundRequestEvent(
      tx,
      refundRequestId,
      transition.event,
      actorUserId,
      parsed.data.note,
      now
    );
    return true;
  });

  if (!moved) {
    return {
      outcome: "not-allowed",
      notAllowed: describeRefundMoney(refundRequestId),
    };
  }

  return { outcome: "moved" };
}

/**
 * The email the buyer gets when their Refund is Issued. There is no mail
 * transport wired up yet, so the built message goes to the server log.
 */
function buildRefundIssuedEmail(input: {
  buyerName: string;
  buyerEmail: string;
  courseTitle: string;
  amountRefunded: number;
}) {
  return {
    to: input.buyerEmail,
    subject: `Refund sent — ${input.courseTitle}`,
    body: [
      `Hi ${input.buyerName},`,
      "",
      `Your refund for "${input.courseTitle}" has been sent: ${formatPrice(input.amountRefunded)} is on its way back to you. Depending on your bank, it can take a few days to arrive.`,
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export type MarkRefundIssuedResult =
  | { outcome: "issued"; email: { to: string; subject: string; body: string } }
  | RefundStepRejection;

/**
 * An admin confirms the money of a Pending Refund was sent: Pending → Issued,
 * with an optional note such as a bank transfer reference. The buyer is
 * emailed only when this call is the one that moved it. From any other state
 * it is `not-allowed`. Throws 404 when there is no such Refund Request.
 */
export function markRefundIssued(
  refundRequestId: number,
  actorUserId: number,
  input: { note?: unknown },
  now: Date = new Date()
): MarkRefundIssuedResult {
  const step = moveRefundMoney(
    refundRequestId,
    actorUserId,
    MARK_ISSUED,
    input,
    now
  );
  if (step.outcome !== "moved") return step;

  const request = db
    .select({
      amountRefunded: refunds.amountRefunded,
      amountPaid: purchases.amountPaid,
      buyerName: users.name,
      buyerEmail: users.email,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, refundRequestId))
    .get();

  if (!request) {
    throw data("Refund Request not found", { status: 404 });
  }

  const email = buildRefundIssuedEmail({
    buyerName: request.buyerName,
    buyerEmail: request.buyerEmail,
    courseTitle: request.courseTitle,
    amountRefunded: request.amountRefunded ?? request.amountPaid,
  });

  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return { outcome: "issued", email };
}

export type MarkRefundFailedResult =
  { outcome: "failed" } | RefundStepRejection;

/**
 * An admin records that the money of a Pending Refund couldn't be sent:
 * Pending → Failed, with an optional note. The buyer is not emailed. From
 * any other state it is `not-allowed`. Throws 404 when there is no such
 * Refund Request.
 */
export function markRefundFailed(
  refundRequestId: number,
  actorUserId: number,
  input: { note?: unknown },
  now: Date = new Date()
): MarkRefundFailedResult {
  const step = moveRefundMoney(
    refundRequestId,
    actorUserId,
    MARK_FAILED,
    input,
    now
  );
  return step.outcome === "moved" ? { outcome: "failed" } : step;
}

export type RetryRefundResult = { outcome: "retried" } | RefundStepRejection;

/**
 * An admin puts a Failed Refund back to Pending so the money can be sent
 * again, with an optional note. The buyer is not emailed. From any other
 * state it is `not-allowed`. Throws 404 when there is no such Refund Request.
 */
export function retryRefund(
  refundRequestId: number,
  actorUserId: number,
  input: { note?: unknown },
  now: Date = new Date()
): RetryRefundResult {
  const step = moveRefundMoney(refundRequestId, actorUserId, RETRY, input, now);
  return step.outcome === "moved" ? { outcome: "retried" } : step;
}
