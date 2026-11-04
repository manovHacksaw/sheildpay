import { createOrder, getOrder, getQuote, getWallet, Order } from "../lib/api";

// All network access happens here so content scripts and the popup never talk to the proxy directly.
// Per-tab state lives in chrome.storage.session (the worker is suspended when idle):
//   ctx:<tabId>    what the checkout page asked to pay (host, amount, currency)
//   active:<tabId> id of the order started for that tab

const POPUP = "src/popup/index.html";
const key = (k: string, tab: number) => `${k}:${tab}`;
const read = async <T>(k: string): Promise<T | undefined> => (await chrome.storage.session.get(k))[k] as T | undefined;

async function openPopup(tabId: number, windowId?: number) {
  try {
    await chrome.action.openPopup(windowId ? { windowId } : undefined);
  } catch {
    // openPopup needs a user gesture the page click doesn't always carry: fall back to a small window.
    await chrome.windows.create({ url: chrome.runtime.getURL(`${POPUP}?tab=${tabId}`), type: "popup", width: 400, height: 660 });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    const tab = msg.tab ?? sender.tab?.id;
    switch (msg.type) {
      case "checkout":
        await chrome.storage.session.set({ [key("ctx", tab)]: msg.ctx });
        await openPopup(tab, sender.tab?.windowId);
        return true;
      case "ctx":
        return (await read(key("ctx", tab))) ?? null;
      case "quote":
        return getQuote(msg.body);
      case "wallet-token":
        await chrome.storage.local.set({ walletToken: String(msg.token) });
        return true;
      case "wallet": {
        const t = (await chrome.storage.local.get("walletToken")).walletToken as string | undefined;
        return t ? getWallet(t).catch(() => null) : null;
      }
      case "create": {
        const t = (await chrome.storage.local.get("walletToken")).walletToken as string | undefined;
        if (msg.body.pay === "balance" && !t) throw new Error("Open the ShieldCheckout agent page once to connect your balance.");
        const order = await createOrder(msg.body, msg.body.pay === "balance" ? t : undefined);
        await chrome.storage.session.set({ [key("active", tab)]: order.id, [order.id]: order });
        await chrome.alarms.create(`poll:${order.id}`, { periodInMinutes: 0.5 });
        return order;
      }
      case "active": {
        const id = await read<string>(key("active", tab));
        return id ? getOrder(id) : null;
      }
      case "get": {
        const order = await getOrder(msg.id);
        await chrome.storage.session.set({ [order.id]: order });
        return order;
      }
    }
  })()
    .then((r) => reply({ ok: true, result: r }))
    .catch((e) => reply({ ok: false, error: String(e.message ?? e) }));
  return true;
});

// Backstop: keeps order state fresh if the worker was suspended while no page was polling.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith("poll:")) return;
  const id = alarm.name.slice(5);
  try {
    const o: Order = await getOrder(id);
    await chrome.storage.session.set({ [id]: o });
    if (o.status === "ready" || o.status === "failed") await chrome.alarms.clear(alarm.name);
  } catch {
    /* retry on next alarm */
  }
});
