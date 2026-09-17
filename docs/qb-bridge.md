# Using the QB Bridge

The `qb-bridge` backend talks to QuickBooks Desktop through the
[QuickBooks Desktop SDK Bridge](https://github.com/cinderblock/quickbooks-desktop-sdk-bridge),
a small REST service that runs on the QuickBooks computer and turns JSON into
qbXML. The client is [`src/accounting/qb-bridge.ts`](../src/accounting/qb-bridge.ts);
[`src/testing/fake-bridge.ts`](../src/testing/fake-bridge.ts) imitates the bridge
in tests.

## Bridge version

The bridge must include time tracking: commit `599e5d1` (2026-09-16) or later, which
added the `time-tracking`, `other-names` and `payroll-items/wage` routes. An older
bridge shows up on the Accounting page as "The QB Bridge has no
/api/v1/time-tracking — it needs updating".

## Endpoints used

| Request | For |
| --- | --- |
| `GET /api/v1/company` | Health check (the Accounting page) |
| `GET /api/v1/customers?active=All` (paged), `employees`, `vendors`, `other-names`, `items/service`, `payroll-items/wage` | Pulling lists |
| `POST /api/v1/time-tracking` | Sending approved time |
| `PUT /api/v1/time-tracking/{TxnID}` | Amending time that was reopened and approved again |
| `GET /api/v1/time-tracking/{TxnID}`, `GET /api/v1/time-tracking?from_date=…&to_date=…` | Finding a record whose answer was lost, or whose version changed |
| `DELETE /api/v1/time-tracking/{TxnID}` | Removing time deleted here after it was sent |
| `POST /api/v1/customers` | Creating a job an admin asked for |

Every request carries the `X-API-Key` header. `QB_BRIDGE_URL` should be the bridge
computer's IPv4 address: the bridge only accepts private addresses, and a hostname
that resolves to a public IPv6 address is refused before the key is checked.

## The API key

Create a key that can read everything and write only time (and, if admins will
create jobs from the app, add customers). On the bridge computer, in the bridge's
folder:

```sh
# bash or PowerShell 7
uv run python -m qb_bridge.cli create-key "Time tracker" --permissions '{"*": ["read"], "TimeTracking": ["read", "write"], "Customer": ["read", "insert"]}'
```

Windows PowerShell 5.1 (the one Windows 10 and 11 start by default) and
`cmd.exe` strip or split the JSON's inner quotes. In any shell, this does the same
without JSON on the command line:

```powershell
.venv\Scripts\python.exe -c "from qb_bridge.cli import create_key; create_key('Time tracker', {'*': ['read'], 'TimeTracking': ['read', 'write'], 'Customer': ['read', 'insert']})"
```

It prints the key once. Set it as `QB_BRIDGE_API_KEY`.

## What counts as a failure

Only QuickBooks' own answer about a record — a `502` carrying a
`qb_status_code` — marks that record refused (shown on the Accounting page and
retried with backoff). Everything else is "QuickBooks can't be reached right now":
no connection, a timeout, a refused key or address, QuickBooks not opening the
company file (`QBConnectionError`, `QBSessionError`, `QBNotRunningError`,
`QBTimeoutError`). Those are retried later and never held against the time being
sent.
