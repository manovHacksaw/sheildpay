export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";

export type OrderStatus = "awaiting_payment" | "seen" | "confirmed" | "issuing" | "ready" | "failed";
export interface Voucher { code: string; pin?: string }

export interface Order {
  id: string;
  status: OrderStatus;
  zecAmount: number;
  address: string;
  paymentUri: string;
  expiresAt: number;
  currency: string;
  cardValue: number;
  surplus: number;
  cards: number[];
  costUsd: number;
  feeUsd: number;
  redeem: "web" | "copy";
  vouchers?: Voucher[];
  error?: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, {
    ...init,
    credentials: "omit",
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json();
}

export const createOrder = (body: { host: string; amount: number; currency: string }) =>
  call<Order>("/orders", { method: "POST", body: JSON.stringify(body) });

export const getOrder = (id: string) => call<Order>(`/orders/${id}`);

export interface Quote {
  currency: string; cardValue: number; surplus: number; cards: number[];
  costUsd: number; feeUsd: number; zecAmount: number; redeem: "web" | "copy"; validForMs: number;
}
export const getQuote = (body: { host: string; amount: number; currency: string }) =>
  call<Quote>("/quote", { method: "POST", body: JSON.stringify(body) });
