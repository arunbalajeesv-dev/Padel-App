// Shared across landing.js, new.js and auction.js. No bundler here (same
// choice admin-panel made) so this is loaded as a plain <script> before the
// page-specific one and hangs everything off `window.AN`.
window.AN = (function(){
  const esc = s => String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const money = n => Number(n).toLocaleString('en-IN');

  let toastTimer;
  function toast(msg){
    document.querySelectorAll('.toast').forEach(n=>n.remove());
    const el = document.createElement('div');
    el.className='toast'; el.textContent=msg; el.setAttribute('role','status');
    document.body.appendChild(el);
    clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.remove(),2400);
  }

  // Sandboxed/embedded views can block window.confirm, so ask in-page instead.
  function ask(msg){
    return new Promise(res => {
      const el = document.createElement('div');
      el.className = 'gate';
      el.innerHTML = '<div class="gate-in"><p style="color:var(--chalk);font-size:15px;margin:0 0 18px">'+esc(msg)+'</p>' +
        '<div class="seats" style="flex-direction:row"><button class="seatbtn" data-ok="1" style="flex:1;font-size:17px">Yes</button>' +
        '<button class="seatbtn" data-cancel="1" style="flex:1;font-size:17px;--tc:var(--dim)">Cancel</button></div></div>';
      el.addEventListener('click', e => {
        const b = e.target.closest('button'); if(!b) return;
        e.stopPropagation(); el.remove(); res(!!b.dataset.ok);
      });
      document.body.appendChild(el);
    });
  }

  async function api(path, opts){
    let res;
    try{
      res = await fetch('/auction-night/api' + path, Object.assign({
        headers: {'Content-Type':'application/json'},
      }, opts));
    }catch(e){
      return {ok:false, network:true};
    }
    let body = null;
    try{ body = await res.json(); }catch(e){ /* empty body */ }
    if(res.status === 409) return {ok:false, conflict:true, body};
    if(!res.ok) return {ok:false, status:res.status, body};
    return {ok:true, body};
  }

  return {esc, money, toast, ask, api};
})();
