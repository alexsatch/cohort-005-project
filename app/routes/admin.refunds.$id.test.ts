import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { db } from "~/db";
import {
  categories,
  courses,
  CourseStatus,
  purchases,
  RefundMoneyStatus,
  RefundRequestEventType,
  refunds,
  RefundStatus,
  users,
  UserRole,
} from "~/db/schema";
import {
  getRefundRequestAuditTrail,
  getRefundRequestDetail,
  listRefundRequests,
} from "~/lib/refund-requests.server";
import { getAccess } from "~/lib/access.server";
import {
  enroll,
  findSuspendedEnrollment,
  isEnrolled,
} from "~/lib/enrollments.server";
import { setCurrentUserId } from "~/lib/session";
import { useTestDatabase } from "~/test/db";
import { action as refundRequestAction } from "./admin.refunds.$id";
import { action as requestRefundAction } from "./courses.$slug.refund";
import { loader as courseLoader } from "./courses.$slug";

useTestDatabase();

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function createUser(name: string, role: UserRole) {
  return db
    .insert(users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get();
}

function seedOpenRefundRequest() {
  const instructor = createUser("Ivy", UserRole.Instructor);
  const liam = createUser("Liam", UserRole.Student);
  const ada = createUser("Ada", UserRole.Admin);
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
  // Bought today, so the fourteen-day window is open for a new request.
  const purchase = db
    .insert(purchases)
    .values({ userId: liam.id, courseId: course.id, amountPaid: 7900 })
    .returning()
    .get();
  const request = db
    .insert(refunds)
    .values({
      purchaseId: purchase.id,
      status: RefundStatus.Open,
      reason: "Bought the wrong one.",
    })
    .returning()
    .get();
  return { instructor, liam, ada, course, request };
}

async function postAs(
  userId: number,
  url: string,
  fields: Record<string, string>
) {
  const setCookie = await setCurrentUserId(new Request(url), userId);
  return new Request(url, {
    method: "POST",
    headers: { Cookie: setCookie.split(";")[0] },
    body: new URLSearchParams(fields),
  });
}

function decline(userId: number, id: number, reason: string) {
  const url = `http://localhost/admin/refunds/${id}`;
  return postAs(userId, url, { intent: "decline", reason }).then((request) =>
    refundRequestAction({
      request,
      params: { id: String(id) },
      context: new RouterContextProvider(),
      url: new URL(url),
      pattern: "/admin/refunds/:id",
    })
  );
}

function approve(userId: number, id: number, note = "") {
  const url = `http://localhost/admin/refunds/${id}`;
  return postAs(userId, url, { intent: "approve", note }).then((request) =>
    refundRequestAction({
      request,
      params: { id: String(id) },
      context: new RouterContextProvider(),
      url: new URL(url),
      pattern: "/admin/refunds/:id",
    })
  );
}

function moneyStep(
  userId: number,
  id: number,
  intent: "mark-issued" | "mark-failed" | "retry",
  note = ""
) {
  const url = `http://localhost/admin/refunds/${id}`;
  return postAs(userId, url, { intent, note }).then((request) =>
    refundRequestAction({
      request,
      params: { id: String(id) },
      context: new RouterContextProvider(),
      url: new URL(url),
      pattern: "/admin/refunds/:id",
    })
  );
}

async function getAs(userId: number, url: string) {
  const setCookie = await setCurrentUserId(new Request(url), userId);
  return new Request(url, {
    // A fixed country, so resolving it never goes to the network.
    headers: { Cookie: setCookie.split(";")[0], "CF-IPCountry": "US" },
  });
}

describe("approving from the admin detail page", () => {
  it("approves an Open Refund Request for an admin, with a Pending Refund", async () => {
    const { ada, liam, course, request } = seedOpenRefundRequest();
    enroll(liam.id, course.id);

    const result = await approve(ada.id, request.id, "Fine by me.");

    expect(result).toMatchObject({ ok: true });
    expect(getRefundRequestDetail(request.id)).toMatchObject({
      status: RefundStatus.Approved,
      refund: { status: RefundMoneyStatus.Pending, amount: 7900 },
    });
    expect(getRefundRequestAuditTrail(request.id)).toMatchObject([
      { note: "Fine by me.", actor: { id: ada.id } },
    ]);
  });

  it("rejects approving an already-decided request with 409 and changes nothing", async () => {
    const { ada, request } = seedOpenRefundRequest();
    const bob = createUser("Bob", UserRole.Admin);
    await decline(bob.id, request.id, "No.");
    const log = vi.mocked(console.log);
    log.mockClear();

    const result = await approve(ada.id, request.id);

    expect(result).toMatchObject({
      init: { status: 409 },
      data: { message: "Already declined by Bob." },
    });
    expect(getRefundRequestDetail(request.id)).toMatchObject({
      status: RefundStatus.Declined,
      refund: null,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["the buyer", "liam"],
    ["the course's owning instructor", "instructor"],
  ] as const)("rejects %s with 403", async (_label, who) => {
    const seeded = seedOpenRefundRequest();
    const userId = who === "liam" ? seeded.liam.id : seeded.instructor.id;

    await expect(approve(userId, seeded.request.id)).rejects.toMatchObject({
      init: { status: 403 },
    });
    expect(getRefundRequestDetail(seeded.request.id)?.status).toBe(
      RefundStatus.Open
    );
  });
});

describe("after an approval", () => {
  it("the learner can no longer view the course content", async () => {
    const { ada, liam, course, request } = seedOpenRefundRequest();
    enroll(liam.id, course.id);
    const url = `http://localhost/courses/${course.slug}`;
    expect(
      (await getAccess(await getAs(liam.id, url), course.id)).canViewContent
    ).toBe(true);

    await approve(ada.id, request.id);

    const access = await getAccess(await getAs(liam.id, url), course.id);
    expect(access).toMatchObject({ enrolled: false, canViewContent: false });
  });

  it("the course page offers the buy button again and says their progress is saved", async () => {
    const { ada, liam, course, request } = seedOpenRefundRequest();
    enroll(liam.id, course.id);
    await approve(ada.id, request.id);

    const url = `http://localhost/courses/${course.slug}`;
    const page = await courseLoader({
      request: await getAs(liam.id, url),
      params: { slug: course.slug },
      context: new RouterContextProvider(),
      url: new URL(url),
      pattern: "/courses/:slug",
    });

    expect(page).toMatchObject({ enrolled: false, suspended: true });
  });

  it("a learner who was never enrolled is not told their progress is saved", async () => {
    const { course } = seedOpenRefundRequest();
    const newcomer = createUser("Nina", UserRole.Student);

    const url = `http://localhost/courses/${course.slug}`;
    const page = await courseLoader({
      request: await getAs(newcomer.id, url),
      params: { slug: course.slug },
      context: new RouterContextProvider(),
      url: new URL(url),
      pattern: "/courses/:slug",
    });

    expect(page).toMatchObject({ enrolled: false, suspended: false });
  });
});

describe("declining from the admin detail page", () => {
  it("declines an Open Refund Request for an admin", async () => {
    const { ada, request } = seedOpenRefundRequest();

    const result = await decline(ada.id, request.id, "Outside our policy.");

    expect(result).toMatchObject({ ok: true });
    expect(getRefundRequestDetail(request.id)?.status).toBe(
      RefundStatus.Declined
    );
  });

  it("returns a field error for an empty reason and changes nothing", async () => {
    const { ada, request } = seedOpenRefundRequest();

    const result = await decline(ada.id, request.id, "   ");

    expect(result).toMatchObject({
      init: { status: 400 },
      data: { errors: { reason: expect.any(String) } },
    });
    expect(getRefundRequestDetail(request.id)?.status).toBe(RefundStatus.Open);
  });

  it("tells the second admin who already decided it", async () => {
    const { ada, request } = seedOpenRefundRequest();
    const bob = createUser("Bob", UserRole.Admin);
    await decline(ada.id, request.id, "First.");

    const result = await decline(bob.id, request.id, "Second.");

    expect(result).toMatchObject({
      init: { status: 409 },
      data: { message: "Already declined by Ada." },
    });
    expect(getRefundRequestAuditTrail(request.id)).toHaveLength(1);
  });

  it.each([
    ["the buyer", "liam"],
    ["the course's owning instructor", "instructor"],
  ] as const)("rejects %s with 403", async (_label, who) => {
    const seeded = seedOpenRefundRequest();
    const userId = who === "liam" ? seeded.liam.id : seeded.instructor.id;

    await expect(
      decline(userId, seeded.request.id, "Let me decline my own.")
    ).rejects.toMatchObject({ init: { status: 403 } });
    expect(getRefundRequestDetail(seeded.request.id)?.status).toBe(
      RefundStatus.Open
    );
  });
});

describe("tracking the money from the admin detail page", () => {
  async function seedApproved() {
    const seeded = seedOpenRefundRequest();
    enroll(seeded.liam.id, seeded.course.id);
    await approve(seeded.ada.id, seeded.request.id);
    return seeded;
  }

  it("marks a Pending Refund as sent, with the note in the audit trail", async () => {
    const { ada, request } = await seedApproved();

    const result = await moneyStep(ada.id, request.id, "mark-issued", "Ref 42");

    expect(result).toMatchObject({ ok: true });
    expect(getRefundRequestDetail(request.id)).toMatchObject({
      status: RefundStatus.Approved,
      refund: { status: RefundMoneyStatus.Issued, amount: 7900 },
    });
    expect(getRefundRequestAuditTrail(request.id).at(-1)).toMatchObject({
      type: RefundRequestEventType.RefundIssued,
      note: "Ref 42",
      actor: { id: ada.id },
    });
  });

  it("marks a Pending Refund as failed, then retries it", async () => {
    const { ada, liam, course, request } = await seedApproved();

    expect(await moneyStep(ada.id, request.id, "mark-failed")).toMatchObject({
      ok: true,
    });
    expect(getRefundRequestDetail(request.id)?.refund?.status).toBe(
      RefundMoneyStatus.Failed
    );

    expect(await moneyStep(ada.id, request.id, "retry")).toMatchObject({
      ok: true,
    });
    expect(getRefundRequestDetail(request.id)?.refund?.status).toBe(
      RefundMoneyStatus.Pending
    );
    expect(isEnrolled(liam.id, course.id)).toBe(false);
    expect(findSuspendedEnrollment(liam.id, course.id)).toBeDefined();
  });

  it("rejects a stale step with 409, saying where the Refund already is", async () => {
    const { ada, request } = await seedApproved();
    const bob = createUser("Bob", UserRole.Admin);
    await moneyStep(ada.id, request.id, "mark-issued");

    const result = await moneyStep(bob.id, request.id, "mark-failed");

    expect(result).toMatchObject({
      init: { status: 409 },
      data: { ok: false, message: "The Refund is already marked issued." },
    });
    expect(getRefundRequestDetail(request.id)?.refund?.status).toBe(
      RefundMoneyStatus.Issued
    );
    expect(getRefundRequestAuditTrail(request.id)).toHaveLength(2);
  });

  it("rejects a step on a request that has no Refund with 409", async () => {
    const { ada, request } = seedOpenRefundRequest();

    const result = await moneyStep(ada.id, request.id, "mark-issued");

    expect(result).toMatchObject({ init: { status: 409 } });
    expect(getRefundRequestDetail(request.id)).toMatchObject({
      status: RefundStatus.Open,
      refund: null,
    });
  });

  it("returns a field error for an overlong note", async () => {
    const { ada, request } = await seedApproved();

    const result = await moneyStep(
      ada.id,
      request.id,
      "mark-issued",
      "x".repeat(1001)
    );

    expect(result).toMatchObject({
      init: { status: 400 },
      data: { errors: { note: expect.any(String) } },
    });
    expect(getRefundRequestDetail(request.id)?.refund?.status).toBe(
      RefundMoneyStatus.Pending
    );
  });

  it.each([
    ["the buyer", "liam", "mark-issued"],
    ["the buyer", "liam", "mark-failed"],
    ["the course's owning instructor", "instructor", "mark-issued"],
    ["the course's owning instructor", "instructor", "mark-failed"],
  ] as const)("rejects %s with 403 on %s", async (_label, who, intent) => {
    const seeded = await seedApproved();
    const userId = who === "liam" ? seeded.liam.id : seeded.instructor.id;

    await expect(
      moneyStep(userId, seeded.request.id, intent)
    ).rejects.toMatchObject({ init: { status: 403 } });
    expect(getRefundRequestDetail(seeded.request.id)?.refund?.status).toBe(
      RefundMoneyStatus.Pending
    );
  });

  it("rejects a non-admin with 403 on retry", async () => {
    const seeded = await seedApproved();
    await moneyStep(seeded.ada.id, seeded.request.id, "mark-failed");

    await expect(
      moneyStep(seeded.liam.id, seeded.request.id, "retry")
    ).rejects.toMatchObject({ init: { status: 403 } });
    expect(getRefundRequestDetail(seeded.request.id)?.refund?.status).toBe(
      RefundMoneyStatus.Failed
    );
  });
});

describe("after a decline", () => {
  it("lets the buyer raise a new Refund Request on the same purchase", async () => {
    const { ada, liam, course, request } = seedOpenRefundRequest();
    await decline(ada.id, request.id, "Outside our policy.");

    const url = `http://localhost/courses/${course.slug}/refund`;
    const response = await requestRefundAction({
      request: await postAs(liam.id, url, {
        reason: "Something changed, please look again.",
      }),
      params: { slug: course.slug },
      context: new RouterContextProvider(),
      url: new URL(url),
      pattern: "/courses/:slug/refund",
    });

    expect(response).toBeInstanceOf(Response);
    expect(listRefundRequests(RefundStatus.Open)).toMatchObject([
      { buyer: { id: liam.id }, course: { id: course.id } },
    ]);
    expect(listRefundRequests(RefundStatus.Declined)).toMatchObject([
      { id: request.id },
    ]);
  });
});
