import { redirect } from "react-router";

/**
 * Browsers and crawlers ask for /favicon.ico whether or not the page names an
 * icon. Without a route, every such request logged a full router stack trace
 * ("No route matches URL"), which buried the lines that matter. The icon is a
 * PNG; a redirect is enough for everything that asks.
 */
export function loader() {
  return redirect("/icons/icon-192.png", 301);
}
