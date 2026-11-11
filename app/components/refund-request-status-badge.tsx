import { RefundStatus } from "~/db/schema";
import { cn } from "~/lib/utils";

export const refundRequestStatusLabels: Record<RefundStatus, string> = {
  [RefundStatus.Open]: "Open",
  [RefundStatus.Approved]: "Approved",
  [RefundStatus.Declined]: "Declined",
};

const statusStyles: Record<RefundStatus, string> = {
  [RefundStatus.Open]:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  [RefundStatus.Approved]:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  [RefundStatus.Declined]:
    "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
};

export function RefundRequestStatusBadge({ status }: { status: RefundStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        statusStyles[status]
      )}
    >
      {refundRequestStatusLabels[status]}
    </span>
  );
}
