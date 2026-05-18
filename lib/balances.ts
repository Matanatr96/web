// Fetches the Tradier account's spendable cash. The CSP scanner uses
// `option_buying_power` as the budget — it's the cash you could deploy as
// collateral for a new short put, net of margin requirements on open positions.

const PROD_BASE = "https://api.tradier.com/v1";

type TradierBalancesResponse = {
  balances: {
    total_cash?: number;
    cash?: {
      cash_available?: number;
    };
    margin?: {
      option_buying_power?: number;
    };
    option_buying_power?: number;
  } | null;
};

export type AccountBalances = {
  cash_available: number;        // unencumbered cash
  option_buying_power: number;   // best signal for "how much can I deploy on a CSP"
};

export async function getAccountBalances(): Promise<AccountBalances | null> {
  const key = process.env.TRADIER_API_KEY;
  const account = process.env.TRADIER_ACCOUNT_ID;
  if (!key || !account) return null;

  const res = await fetch(`${PROD_BASE}/accounts/${account}/balances`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) return null;

  const data = (await res.json()) as TradierBalancesResponse;
  const b = data.balances;
  if (!b) return null;

  // Tradier returns different shapes for cash vs margin accounts. Pull from the
  // first field that exists, falling back to total_cash for cash accounts.
  const cash_available =
    b.cash?.cash_available ?? b.total_cash ?? 0;
  const option_buying_power =
    b.margin?.option_buying_power ?? b.option_buying_power ?? cash_available;

  return { cash_available, option_buying_power };
}
