import { useEffect, useState } from "react";
import { data, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/admin.refunds.$id";
import { RefundRequestEventType, RefundStatus } from "~/db/schema";
import { requireAdmin } from "~/lib/access.server";
import {
  declineRefundRequest,
  getRefundRequestDetail,
  type RefundRequestAuditEntry,
} from "~/lib/refund-requests.server";
import { parseFormData, parseParams } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { RefundRequestStatusBadge } from "~/components/refund-request-status-badge";
import { AdminErrorScreen } from "~/components/admin-error-screen";

const refundRequestParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export function meta() {
  return [{ title: "Refund Request — Cadence" }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const { id } = parseParams(params, refundRequestParamsSchema);
  const refundRequest = getRefundRequestDetail(id);

  if (!refundRequest) {
    throw data("Refund Request not found", { status: 404 });
  }

  return { refundRequest };
}

const refundRequestIntentSchema = z.object({
  intent: z.literal("decline"),
});

export async function action({ params, request }: Route.ActionArgs) {
  // Loader guards don't protect actions.
  const { userId } = await requireAdmin(request);
  const { id } = parseParams(params, refundRequestParamsSchema);

  const formData = await request.formData();
  const intent = parseFormData(formData, refundRequestIntentSchema);

  if (!intent.success) {
    throw data("Invalid action.", { status: 400 });
  }

  const result = declineRefundRequest(id, userId, {
    reason: formData.get("reason"),
  });

  switch (result.outcome) {
    case "invalid":
      return data(
        { ok: false as const, errors: result.errors, message: null },
        { status: 400 }
      );
    case "already-decided":
      return data(
        {
          ok: false as const,
          errors: null,
          message: result.alreadyDecided.message,
        },
        { status: 409 }
      );
    case "declined":
      return {
        ok: true as const,
        errors: null,
        message: "Refund Request declined. The buyer has been emailed.",
      };
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatWatchTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes % 60}m`;
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const EVENT_LABELS: Record<RefundRequestEventType, string> = {
  [RefundRequestEventType.Declined]: "Declined",
  [RefundRequestEventType.Approved]: "Approved",
  [RefundRequestEventType.RefundIssued]: "Refund issued",
  [RefundRequestEventType.RefundFailed]: "Refund failed",
  [RefundRequestEventType.RefundRetried]: "Refund retried",
};

function DeclineForm() {
  const fetcher = useFetcher<typeof action>();
  const [reason, setReason] = useState("");
  const reasonError =
    fetcher.state === "idle" ? fetcher.data?.errors?.reason : undefined;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      toast.success(fetcher.data.message);
      setReason("");
    } else if (fetcher.data.message) {
      toast.error(fetcher.data.message);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <fetcher.Form method="post" className="space-y-3">
      <input type="hidden" name="intent" value="decline" />
      <div className="space-y-2">
        <Label htmlFor="decline-reason">Reason for declining</Label>
        <Textarea
          id="decline-reason"
          name="reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="The buyer will see this in their email."
          aria-invalid={reasonError ? true : undefined}
          rows={3}
        />
        {reasonError && (
          <p className="text-sm text-destructive">{reasonError}</p>
        )}
      </div>
      <Button
        type="submit"
        variant="destructive"
        disabled={fetcher.state !== "idle"}
      >
        {fetcher.state !== "idle" ? "Declining…" : "Decline"}
      </Button>
    </fetcher.Form>
  );
}

function AuditTrail({ entries }: { entries: RefundRequestAuditEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No decision has been made yet.
      </p>
    );
  }

  return (
    <ol className="divide-y divide-border">
      {entries.map((entry) => (
        <li key={entry.id} className="py-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium">
              {EVENT_LABELS[entry.type]} by {entry.actor.name}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatDateTime(entry.createdAt)}
            </span>
          </div>
          {entry.note && (
            <p className="mt-2 whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-sm">
              {entry.note}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

export default function AdminRefundRequest({
  loaderData,
}: Route.ComponentProps) {
  const { refundRequest } = loaderData;
  const { completedLessons, totalLessons } = refundRequest.lessonCompletion;

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <Link to="/admin/refunds" className="hover:text-foreground">
          Refund Requests
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">#{refundRequest.id}</span>
      </nav>

      <div className="mb-8 flex items-center gap-3">
        <h1 className="text-3xl font-bold">Refund Request</h1>
        <RefundRequestStatusBadge status={refundRequest.status} />
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Request</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Field label="Buyer">
                <div className="font-medium">{refundRequest.buyer.name}</div>
                <div className="text-muted-foreground">
                  {refundRequest.buyer.email}
                </div>
              </Field>
              <Field label="Course">{refundRequest.course.title}</Field>
              <Field label="Amount paid">
                {formatPrice(refundRequest.amountPaid)}
              </Field>
              <Field label="Purchased">
                {formatDate(refundRequest.purchasedAt)}
              </Field>
              <Field label="Requested">
                {formatDate(refundRequest.requestedAt)}
              </Field>
            </dl>
            <div className="mt-6">
              <Field label="Buyer's reason">
                <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-3">
                  {refundRequest.reason}
                </p>
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Context</CardTitle>
            <p className="text-sm text-muted-foreground">
              For information only. None of these block a decision.
            </p>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-3">
              <Field label="Watch time">
                {formatWatchTime(refundRequest.watchedSeconds)}
              </Field>
              <Field label="Lessons completed">
                {completedLessons} / {totalLessons}
              </Field>
              <Field label="Days since purchase">
                {refundRequest.daysSincePurchase}
              </Field>
            </dl>
          </CardContent>
        </Card>

        {refundRequest.status === RefundStatus.Open && (
          <Card>
            <CardHeader>
              <CardTitle>Decision</CardTitle>
            </CardHeader>
            <CardContent>
              <DeclineForm />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Audit trail</CardTitle>
          </CardHeader>
          <CardContent>
            <AuditTrail entries={refundRequest.auditTrail} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Buyer's other Refund Requests</CardTitle>
          </CardHeader>
          <CardContent>
            {refundRequest.otherRefundRequests.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This is the buyer's only Refund Request.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {refundRequest.otherRefundRequests.map((other) => (
                  <li
                    key={other.id}
                    className="flex items-center justify-between gap-4 py-3"
                  >
                    <div>
                      <Link
                        to={`/admin/refunds/${other.id}`}
                        className="text-sm font-medium hover:underline"
                      >
                        {other.course.title}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        Requested {formatDate(other.requestedAt)}
                        {other.resolvedAt &&
                          ` · decided ${formatDate(other.resolvedAt)}`}
                      </div>
                    </div>
                    <RefundRequestStatusBadge status={other.status} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return (
    <AdminErrorScreen
      error={error}
      fallbackMessage="An unexpected error occurred while loading this Refund Request."
    />
  );
}
