import { isRouteErrorResponse, Link } from "react-router";
import { AlertTriangle } from "lucide-react";
import { Button } from "~/components/ui/button";

/** The error screen the admin pages share: 401, 403, and everything else. */
export function AdminErrorScreen({
  error,
  fallbackMessage,
}: {
  error: unknown;
  fallbackMessage: string;
}) {
  let title = "Something went wrong";
  let message = fallbackMessage;

  if (isRouteErrorResponse(error)) {
    const detail = typeof error.data === "string" ? error.data : null;
    if (error.status === 401) {
      title = "Sign in required";
      message = detail ?? "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message = detail ?? "Only admins can access this page.";
    } else {
      title = `Error ${error.status}`;
      message = detail ?? error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
