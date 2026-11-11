import { data, Link } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/admin.refunds.$id";
import { requireAdmin } from "~/lib/access.server";
import { getRefundRequestDetail } from "~/lib/refund-requests.server";
import { parseParams } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
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
