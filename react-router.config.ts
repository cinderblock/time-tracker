import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  // Ship the whole route manifest with the first page. The default ("lazy")
  // asks the server for route information on navigation, which fails offline
  // and would break moving between days with no connection.
  routeDiscovery: { mode: "initial" },
} satisfies Config;
