// Runs only on the ShieldCheckout agent page. Hands the page's prepaid-wallet token to the extension so the
// checkout popup can offer "Pay from balance". The token is a bearer secret for that balance; it stays in
// chrome.storage.local and is only ever sent to the ShieldCheckout API.
let last: string | null = null;
function share() {
  let token: string | null = null;
  try { token = localStorage.getItem("sc_wallet"); } catch { /* storage blocked */ }
  if (token && token !== last) {
    last = token;
    chrome.runtime.sendMessage({ type: "wallet-token", token });
  }
}
share();
setInterval(share, 3000); // the page creates the wallet a moment after it loads
