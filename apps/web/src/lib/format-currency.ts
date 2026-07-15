const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatUsdCents(cents: number | null): string {
  return cents === null ? "Not recorded" : USD.format(cents / 100);
}
