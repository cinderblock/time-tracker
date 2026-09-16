# QB Bridge: the `/api/v1/qbxml` endpoint

The time tracker's `qb-bridge` backend talks to QuickBooks Desktop through a small
REST service running on the QuickBooks machine (the "QB Bridge"). It needs exactly
one endpoint from that service. This document is the contract; the app side is
[`src/accounting/qb-bridge.ts`](../src/accounting/qb-bridge.ts), and
[`src/testing/fake-bridge.ts`](../src/testing/fake-bridge.ts) is a working
reference implementation used by the tests.

## Request

```
POST /api/v1/qbxml
X-API-Key: <key>
Content-Type: application/json

{ "qbxml": "<?xml version=\"1.0\" encoding=\"utf-8\"?><?qbxml version=\"13.0\"?><QBXML>…</QBXML>" }
```

`qbxml` is a complete qbXML request document. The bridge passes it to QuickBooks
(`ProcessRequest` on its open session with the company file) unchanged.

## Response

Success — QuickBooks answered, whatever it said:

```json
{ "ok": true, "data": { "qbxml": "<?xml version=\"1.0\" ?><QBXML><QBXMLMsgsRs>…</QBXMLMsgsRs></QBXML>" } }
```

The response document is QuickBooks' answer, unchanged. Errors *inside* it
(`statusCode` on each response element) are the app's business, not the bridge's:
still `ok: true`, HTTP 200.

Failure — the bridge couldn't or wouldn't ask QuickBooks — uses the bridge's
existing envelope and codes:

```json
{ "ok": false, "error": { "code": "REQUEST_NOT_ALLOWED", "message": "…" } }
```

| Situation | HTTP | `error.code` |
| --- | --- | --- |
| Wrong or missing `X-API-Key` | 401 | `UNAUTHORIZED` (as today) |
| Source address not private | 403 | `FORBIDDEN_IP` (as today) |
| A request type outside the allowlist | 403 | `REQUEST_NOT_ALLOWED` |
| Body isn't `{ qbxml: string }` or isn't well-formed XML | 400 | `BAD_REQUEST` |
| QuickBooks rejected the document as a whole (an HRESULT from `ProcessRequest`, e.g. a parse error) | 502 | `QB_ERROR`, with the HRESULT and message |
| QuickBooks or the company file isn't available | 503 | `QB_UNAVAILABLE` |

The app treats every failure as "the accounting system can't be reached right
now". It retries later and never counts the failure against the time it was
sending.

## Allowlist

The bridge must refuse any document containing a request element that isn't one
of these. This is what keeps a leaked API key from rewriting the books.

| Request | Used for |
| --- | --- |
| `HostQueryRq` | Health check |
| `CustomerQueryRq`, `EmployeeQueryRq`, `VendorQueryRq`, `OtherNameQueryRq`, `ItemServiceQueryRq`, `PayrollItemWageQueryRq` | Pulling lists (all six in one document, `onError="continueOnError"`) |
| `TimeTrackingAddRq`, `TimeTrackingModRq`, `TimeTrackingQueryRq` | Sending time, and finding a record whose answer was lost |
| `TxnDelRq` — **only with `<TxnDelType>TimeTracking</TxnDelType>`** | Removing time deleted in the app after it was sent |
| `CustomerAddRq` | Creating a job an admin asked for |

Everything else — including `TxnDelRq` for any other transaction type — gets
`REQUEST_NOT_ALLOWED`.

## Notes for the implementation

- **Timeouts.** A list pull on a large company file can take tens of seconds. The
  app waits up to two minutes.
- **One request at a time.** The app sends requests one after another, never in
  parallel.
- **Logging.** Log the request types and status codes, not the documents: time
  notes are employees' words.
- **Encoding.** The app escapes everything outside printable ASCII as numeric
  character references, so the document is plain ASCII whatever QuickBooks
  assumes.
- **Version.** Requests declare qbXML 13.0 (QuickBooks 2014 and later).
