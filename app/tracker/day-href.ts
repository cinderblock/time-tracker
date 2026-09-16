/** A person's own day pages: today lives at "/", other days at "/day/<date>". */
export function dayHref(date: string, today: string): string {
  return date === today ? "/" : `/day/${date}`;
}
