import type { Config } from "./config.js";

export interface Balance {
  totalBalance: string;
  currency: string;
}

export async function fetchBalance(config: Config): Promise<Balance | null> {
  try {
    const res = await fetch(`${config.baseUrl}/user/balance`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      balance_infos?: { total_balance?: string; currency?: string }[];
    };
    const info = data.balance_infos?.[0];
    if (!info?.total_balance) return null;
    return {
      totalBalance: info.total_balance,
      currency: info.currency || "CNY",
    };
  } catch {
    return null;
  }
}
