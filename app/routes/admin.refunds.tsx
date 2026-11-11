import { Link } from "react-router";
import { Receipt } from "lucide-react";
import type { Route } from "./+types/admin.refunds";
import { RefundStatus } from "~/db/schema";
import { requireAdmin } from "~/lib/access.server";
import {
  listRefundRequests,
  parseRefundRequestFilter,
} from "~/lib/refund-requests.server";
import { cn, formatPrice } from "~/lib/utils";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { refundRequestStatusLabels } from "~/components/refund-request-status-badge";
import { AdminErrorScreen } from "~/components/admin-error-screen";

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Review buyers' Refund Requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const status = parseRefundRequestFilter(new URL(request.url).searchParams);
  return { status, refundRequests: listRefundRequests(status) };
}

const filters = [
  RefundStatus.Open,
  RefundStatus.Approved,
  RefundStatus.Declined,
] as const;

const columns = ["Buyer", "Course", "Amount paid", "Requested", ""] as const;

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { status, refundRequests } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Buyers' asks to get back what they paid
        </p>
      </div>

      <div className="mb-4 inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground">
        {filters.map((filter) => (
          <Link
            key={filter}
            to={
              filter === RefundStatus.Open
                ? "/admin/refunds"
                : `/admin/refunds?status=${filter}`
            }
            className={cn(
              "rounded-md px-3 py-1 text-sm font-medium transition-colors",
              filter === status
                ? "bg-background text-foreground shadow-sm"
                : "hover:text-foreground"
            )}
          >
            {refundRequestStatusLabels[filter]}
          </Link>
        ))}
      </div>

      {refundRequests.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <Receipt className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              No {refundRequestStatusLabels[status]} Refund Requests.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    {columns.map((heading) => (
                      <th
                        key={heading}
                        className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {refundRequests.map((refundRequest) => (
                    <tr
                      key={refundRequest.id}
                      className="border-b border-border last:border-0"
                    >
                      <td className="px-4 py-3">
                        <div className="text-sm font-medium">
                          {refundRequest.buyer.name}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {refundRequest.buyer.email}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {refundRequest.course.title}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {formatPrice(refundRequest.amountPaid)}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatDate(refundRequest.requestedAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button asChild variant="outline" size="sm">
                          <Link to={`/admin/refunds/${refundRequest.id}`}>
                            View
                          </Link>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return (
    <AdminErrorScreen
      error={error}
      fallbackMessage="An unexpected error occurred while loading Refund Requests."
    />
  );
}
