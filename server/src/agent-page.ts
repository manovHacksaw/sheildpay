// Single-file UI for the shopping agent, served at GET /agent. All model text is inserted with textContent.
export const AGENT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ShieldCheckout Agent</title>
<style>
  :root{color-scheme:light dark;--bg:#fafafa;--card:#fff;--fg:#14161a;--mut:#667;--line:#e3e5ea;--acc:#f4b728;--ok:#0a7;--bad:#c00}
  @media (prefers-color-scheme:dark){:root{--bg:#101215;--card:#181b20;--fg:#f1f1f1;--mut:#9aa;--line:#2a2e36}}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui}
  main{max-width:720px;margin:0 auto;padding:20px 16px 60px}
  h1{font-size:20px;margin:0} .sub{color:var(--mut);margin:2px 0 16px;font-size:13px}
  .badge{font-size:11px;padding:2px 8px;border-radius:99px;background:var(--line);color:var(--mut);margin-left:8px;vertical-align:middle}
  .log{display:flex;flex-direction:column;gap:10px;margin-bottom:14px}
  .msg{padding:10px 12px;border-radius:12px;max-width:92%;white-space:pre-wrap;border:1px solid var(--line);background:var(--card)}
  .msg.user{align-self:flex-end;background:var(--acc);color:#111;border-color:transparent}
  form{display:flex;gap:8px} input[type=text]{flex:1;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit}
  button{font:600 14px system-ui;padding:11px 16px;border:0;border-radius:10px;background:var(--acc);color:#111;cursor:pointer}
  button.s{background:none;border:1px solid var(--line);color:var(--fg);padding:5px 10px;font-weight:500}
  button:disabled{opacity:.5;cursor:default}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px} .chips button{background:var(--card);border:1px solid var(--line);color:var(--fg);font-weight:500;padding:7px 12px}
  .card{border:1px solid var(--line);background:var(--card);border-radius:14px;padding:14px;margin:12px 0}
  .row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--line)} .row:last-child{border:0}
  .row span:first-child{color:var(--mut)} .big{font-size:18px;font-weight:700}
  canvas{display:block;margin:10px auto} code{word-break:break-all;font-size:12px}
  ol{padding-left:20px} li{color:var(--mut);padding:2px 0} li.done{color:var(--ok)} li.cur{color:var(--fg);font-weight:700}
  .err{color:var(--bad)} .note{color:var(--mut);font-size:12px;margin-top:8px} .v{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:6px 0}
</style></head><body><main>
<h1>ShieldCheckout Agent <span id="mode" class="badge"></span></h1>
<p class="sub">Tell me what you want to spend and where. I price it and explain the choice. Nothing is bought until you approve: pay in one click from your prepaid shielded balance, or scan a QR from your own wallet.</p>
<div class="card" id="wallet"><div class="row"><span>Prepaid balance</span><span id="bal" class="big">…</span></div>
  <form id="topup" style="margin-top:8px"><input type="text" id="usd" inputmode="decimal" placeholder="Add funds (USD), e.g. 10" autocomplete="off" maxlength="6"><button id="addf">Add funds</button></form>
  <div id="dep"></div></div>
<div class="chips" id="chips"></div>
<div class="log" id="log"></div>
<form id="f"><input type="text" id="q" placeholder="e.g. ₹800 on Swiggy and ₹500 on Flipkart" autocomplete="off" maxlength="400"><button id="send">Ask</button></form>
<div id="plan"></div><div id="pay"></div>
<script>
const $=(id)=>document.getElementById(id), el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
const history=[];
// Prepaid wallet: the token is a bearer secret for this browser's balance (custodial, held by this server).
let token=null;try{token=localStorage.getItem('sc_wallet')}catch{}
const authH=()=>token?{authorization:'Bearer '+token}:{};
let wallet=null;
async function loadWallet(){
  if(!token){const r=await fetch('/wallet',{method:'POST'});const d=await r.json();if(!r.ok)throw new Error(d.error);token=d.token;try{localStorage.setItem('sc_wallet',token)}catch{}}
  const r=await fetch('/wallet',{headers:authH()});const d=await r.json();
  if(r.status===400&&/not found/.test(d.error||'')){token=null;try{localStorage.removeItem('sc_wallet')}catch{};return loadWallet()}
  if(!r.ok)throw new Error(d.error);wallet=d;
  $('bal').textContent=d.balanceZec+' ZEC'+(d.balanceUsdEstimate!=null?' (~$'+d.balanceUsdEstimate.toFixed(2)+')':'');
  const p=d.deposits.filter(x=>x.pending&&x.receivedZec>0).pop();
  const st=$('depstatus');if(st&&p)st.textContent=p.confirmations?'Received '+p.receivedZec+' ZEC, crediting…':'Seen '+p.receivedZec+' ZEC, waiting for 1 confirmation…';
  document.querySelectorAll('button[data-bal]').forEach(b=>{const need=Number(b.dataset.bal);b.disabled=d.balanceZec<need;b.title=b.disabled?'Balance too low: top up first':''});
}
loadWallet().catch(e=>{$('bal').textContent='unavailable';console.error(e)});setInterval(()=>loadWallet().catch(()=>{}),5000);
$('topup').onsubmit=async(e)=>{e.preventDefault();const usd=Number($('usd').value);if(!(usd>0))return;$('addf').disabled=true;
  try{const r=await fetch('/wallet/deposit',{method:'POST',headers:{'content-type':'application/json',...authH()},body:JSON.stringify({usd})});const d=await r.json();if(!r.ok)throw new Error(d.error);
    const box=$('dep');box.innerHTML='';const img=new Image(180,180);img.alt='Top-up QR';img.style.display='block';img.style.margin='10px 0';img.src='/qr?d='+encodeURIComponent(d.paymentUri);
    const a=el('div','note');a.append('Send about ',el('b','',d.suggestedZec+' ZEC'),' (any amount is credited). Address starts ',el('b','',d.address.slice(0,8)),' and ends ',el('b','',d.address.slice(-6)),'.');
    const cp=el('button','s','Copy address');cp.type='button';cp.onclick=()=>navigator.clipboard.writeText(d.address);
    const l=el('a','','Open in my Zcash wallet');l.href=d.paymentUri;l.style.display='block';l.style.margin='8px 0';
    box.append(img,a,l,cp,el('div','note','Waiting for your deposit…'));box.lastChild.id='depstatus'}
  catch(err){$('dep').textContent=err.message}finally{$('addf').disabled=false}};
fetch('/agent/info').then(r=>r.json()).then(i=>{$('mode').textContent=i.llm?'AI planner':'offline planner';
  const names=i.merchants.map(h=>h.replace(/^www\\./,'').split('.')[0]);
  [names.length>1?'₹800 on '+names[1]+' and ₹500 on '+names[0]:'₹500 on '+names[0],'₹250 on '+names[0]+', fewest cards'].forEach(t=>{const b=el('button','',t);b.type='button';b.onclick=()=>{$('q').value=t;$('f').requestSubmit()};$('chips').append(b)})});
const say=(role,text)=>{const m=el('div','msg '+role,text);$('log').append(m);m.scrollIntoView({block:'end'})};
$('f').onsubmit=async(e)=>{e.preventDefault();const text=$('q').value.trim();if(!text)return;$('q').value='';say('user',text);history.push({role:'user',content:text});
  $('send').disabled=true;$('plan').innerHTML='';
  try{const r=await fetch('/agent/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:history})});const d=await r.json();
    if(!r.ok)throw new Error(d.error||'error');say('assistant',d.reply);history.push({role:'assistant',content:d.reply});if(d.plan)showPlan(d.plan)}
  catch(err){say('assistant','Sorry: '+err.message)}finally{$('send').disabled=false}};
function showPlan(p){const c=el('div','card');
  p.lines.forEach(l=>{const r=el('div','row');r.append(el('span','',l.merchant),el('span','',l.cards.join(' + ')+' '+l.currency+(l.unusedBalance>0?' ('+l.unusedBalance+' unused)':'')));c.append(r)});
  const add=(a,b,cls)=>{const r=el('div','row');r.append(el('span','',a),el('span',cls||'',b));c.append(r)};
  add('Cards (USD)','$'+p.totalCardCostUsd.toFixed(2));add('Service fee','$'+p.serviceFeeUsd.toFixed(2));add('You pay',p.totalZec+' ZEC','big');
  const b=el('button','','Pay from balance ('+p.totalZec+' ZEC)');b.dataset.bal=String(p.totalZec);b.disabled=!wallet||wallet.balanceZec<p.totalZec;b.onclick=()=>approve(p.planId,b,'balance');
  const q=el('button','s','Pay with QR instead');q.style.marginLeft='8px';q.onclick=()=>approve(p.planId,q,'qr');c.append(b,q);
  c.append(el('div','note','Pay from balance buys right away. With the QR, nothing is spent until your payment confirms. Quote valid ~'+p.validMinutes+' min.'));$('plan').append(c)}
async function approve(id,btn,pay){btn.disabled=true;try{const r=await fetch('/agent/approve',{method:'POST',headers:{'content-type':'application/json',...authH()},body:JSON.stringify({planId:id,pay})});const o=await r.json();if(!r.ok)throw new Error(o.error);$('plan').innerHTML='';track(o)}catch(e){btn.disabled=false;btn.after(el('div','err',e.message))}}
const STEPS=['Waiting for your ZEC','Confirming payment','Buying your cards','Done'];const idx={awaiting_payment:0,seen:1,paid:2,confirmed:2,issuing:2,ready:3,failed:0};
async function track(o){const box=$('pay');const canvas=new Image(200,200);canvas.alt='Payment QR';canvas.style.display='block';canvas.style.margin='10px 0';canvas.src='/qr?d='+encodeURIComponent(o.paymentUri);
  const draw=()=>{box.innerHTML='';const c=el('div','card');if(o.paidFrom==='balance')c.append(el('div','big','Paid '+o.zecAmount+' ZEC from your balance'));
    if(o.status==='awaiting_payment'){c.append(el('div','big','Send '+o.zecAmount+' ZEC'),canvas);
      const a=el('div','note');a.append('Address starts ',el('b','',o.address.slice(0,8)),' and ends ',el('b','',o.address.slice(-6)),'. Check before sending.');c.append(a);
      const l=el('a','', 'Open in my Zcash wallet');l.href=o.paymentUri;l.style.display='block';l.style.margin='10px 0';c.append(l);
      const cp=el('button','s','Copy address');cp.onclick=()=>navigator.clipboard.writeText(o.address);const ca=el('button','s','Copy amount');ca.onclick=()=>navigator.clipboard.writeText(String(o.zecAmount));ca.style.marginLeft='8px';c.append(cp,ca)}
    const ol=document.createElement('ol');STEPS.forEach((s,i)=>{const li=el('li',i<idx[o.status]?'done':i===idx[o.status]?'cur':'',s);ol.append(li)});c.append(ol);
    if(o.error)c.append(el('div','err',o.error));
    if(o.status==='ready'&&o.vouchers){o.vouchers.forEach(v=>{const r=el('div','v');const t=el('div');
      // Codes are cash: masked on screen by default (safe for screenshots and demos); Copy still copies the real code.
      const full=v.code+(v.pin?' / PIN '+v.pin:''),masked='•'.repeat(Math.max(4,v.code.length-4))+v.code.slice(-4)+(v.pin?' / PIN ••••':'');
      const code=el('code','',masked),rv=el('button','s','Reveal');rv.style.marginLeft='8px';rv.onclick=()=>{const hid=code.textContent===masked;code.textContent=hid?full:masked;rv.textContent=hid?'Hide':'Reveal'};
      t.append(el('div','note',v.label||''),code,rv);
      const b=el('button','s','Copy');b.onclick=()=>navigator.clipboard.writeText(v.pin?v.code+' '+v.pin:v.code);r.append(t,b);c.append(r)});
      c.append(el('div','note','Flipkart: the ShieldCheckout extension can fill these in at checkout. Swiggy: paste the code in the app.'))}
    box.append(c)};
  draw();while(o.status!=='ready'&&o.status!=='failed'){await new Promise(r=>setTimeout(r,3000));try{o=await (await fetch('/orders/'+o.id)).json();draw()}catch{}}}
</script></main></body></html>`;
