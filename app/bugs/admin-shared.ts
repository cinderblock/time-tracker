/** Shared by the admin bug pages: labels, and how a page address is shown. */

/** The page a report came from, without the host. */
export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

export const REPORT_STATUS: Record<string, { label: string; color: string }> = {
  new: { label: "New", color: "red" },
  fixed: { label: "Fixed", color: "green" },
  wont_fix: { label: "Won't fix", color: "gray" },
};

export const ERROR_STATUS: Record<string, { label: string; color: string }> = {
  new: { label: "Open", color: "red" },
  fixed: { label: "Fixed", color: "green" },
  ignored: { label: "Ignored", color: "gray" },
};

export const when = (t: number) =>
  new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export const at = (t: number) =>
  new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
