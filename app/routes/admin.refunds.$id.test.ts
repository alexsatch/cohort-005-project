import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { db } from "~/db";
import {
  categories,
  courses,
  CourseStatus,
  purchases,
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
import { setCurrentUserId } from "~/lib/session";
import { useTestDatabase } from "~/test/db";
import { action as refundRequestAction } from "./admin.refunds.$id";
import { action as requestRefundAction } from "./courses.$slug.refund";

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
