import type { BugReportPayload } from "../../src/bug-schema.ts";
import { CODE_BUILD } from "../../src/build-info.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { addCrumb } from "./breadcrumbs.ts";
import { type AddResult, problemQueue } from "./queue.ts";
import type { Shot } from "./screenshot.ts";

/** What sending a report came to, in the person's terms. */
export type SendResult =
  | { status: "sent"; serverRevision: string | null }
  | { status: "queued" }
  | { status: "refused"; error: string }
  | { status: "lost" };

/** File a report: kept on the device first, sent now if there's a connection. */
export async function sendReport(args: {
  userId: number;
  pressedAt: number;
  description: string;
  expected: string;
  context: Record<string, unknown>;
  shots: Shot[];
}): Promise<SendResult> {
  const id = uuidv7();
  const body: BugReportPayload = {
    id,
    at: args.pressedAt,
    description: args.description.trim(),
    expected: args.expected.trim() || undefined,
    url: location.href,
    revision: CODE_BUILD.revision,
    context: args.context,
    images: args.shots.map((s) => ({ kind: s.kind, mime: s.mime, width: s.width, height: s.height, data: s.data })),
  };
  addCrumb("report", "Bug report filed", { id });
  const result: AddResult = await problemQueue().add({ key: `report:${id}`, kind: "report", userId: args.userId, body });
  if (result.status === "sent") {
    const answer = result.answer as { server?: { revision?: string } } | null;
    return { status: "sent", serverRevision: answer?.server?.revision ?? null };
  }
  return result;
}
