/**
 * Money display, shared by the server and the browser (dependency-free).
 */

const formatters = new Map<string, Intl.NumberFormat>();

/** "$1,234.50" */
export function formatMoney(amount: number, currency: string): string {
  let f = formatters.get(currency);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { style: "currency", currency });
    formatters.set(currency, f);
  }
  return f.format(amount);
}

/** "$45.00/h" */
export function formatRate(amount: number, currency: string): string {
  return `${formatMoney(amount, currency)}/h`;
}
