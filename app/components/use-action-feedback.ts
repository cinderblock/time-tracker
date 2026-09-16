import { notifications } from "@mantine/notifications";
import { useEffect, useRef } from "react";

interface Result {
  ok: boolean;
  message?: string;
  error?: string;
}

/**
 * Show a toast for each new result a fetcher returns. Errors stay until
 * dismissed; confirmations fade on their own.
 */
export function useActionFeedback(data: Result | undefined): void {
  const last = useRef<Result | undefined>(undefined);
  useEffect(() => {
    if (!data || data === last.current) return;
    last.current = data;
    if (data.ok) {
      if (data.message) notifications.show({ message: data.message, color: "green" });
    } else {
      notifications.show({ message: data.error ?? "Something went wrong.", color: "red", autoClose: false });
    }
  }, [data]);
}
