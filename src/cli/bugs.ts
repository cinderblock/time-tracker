/**
 * Bug reports and browser errors, for whoever can reach the host — an agent
 * included — without a browser or a passkey.
 *
 *   bun run bugs                      what's open: reports and errors, one line each
 *   bun run bugs report <id> <dir>    write a report's bundle into <dir>
 *                                     (report.md, context.json, screenshots)
 *   bun run bugs error <group-id>     an error group and its latest occurrences, as JSON
 *
 *   docker exec <container> bun run bugs ...
 *   docker cp <container>:<dir> .     to bring a bundle out
 *
 * Read-only: marking things fixed stays on the admin page, where it's audited
 * under a person's name.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { listBugReports, reportFiles } from "../bug-reports.ts";
import { shortRevision } from "../build-info.ts";
import { getErrorGroup, listErrorGroups } from "../client-errors.ts";
import { initDb } from "../db.server.ts";

initDb(undefined, (line) => console.error(line));

const [command, ...args] = process.argv.slice(2);
const day = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

function usage(): never {
  console.error("Usage: bugs | bugs report <id> <dir> | bugs error <group-id>");
  process.exit(2);
}

if (!command) {
  const reports = listBugReports();
  const groups = listErrorGroups();
  console.log(`Reports (${reports.filter((r) => r.status === "new").length} new):`);
  for (const r of reports) {
    console.log(
      `  ${r.id}  ${r.status.padEnd(8)} ${day(r.clientTime)}  ${r.userName}  [${shortRevision(r.clientRevision)}]  ${r.description.replace(/\s+/g, " ").slice(0, 80)}`,
    );
  }
  console.log(`Errors (${groups.filter((g) => g.status === "new").length} open):`);
  for (const g of groups) {
    console.log(`  ${String(g.id).padStart(5)}  ${g.status.padEnd(8)} ×${g.count}  last ${day(g.lastSeenAt)}  ${g.message.slice(0, 100)}`);
  }
} else if (command === "report") {
  const [id, dir] = args;
  if (!id || !dir) usage();
  const files = reportFiles(id);
  if (!files) {
    console.error(`No report ${id}.`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
  console.error(`Wrote ${Object.keys(files).length} files to ${dir}; start with report.md.`);
} else if (command === "error") {
  const group = getErrorGroup(Number(args[0]));
  if (!group) {
    console.error(`No error group ${args[0]}.`);
    process.exit(1);
  }
  console.log(JSON.stringify(group, null, 2));
} else {
  usage();
}
