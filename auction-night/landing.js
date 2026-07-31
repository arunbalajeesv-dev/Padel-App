(function(){
  const {esc, money, api} = window.AN;

  function row(a){
    const chips = a.teams.map(t => '<span class="chip" style="color:'+t.color+'">'+esc(t.name)+'</span>').join('');
    const when = new Date(a.createdAt).toLocaleString('en-IN', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'});
    return '<a class="card arow" href="a/'+a.id+'">' +
      '<div><div class="ttl">'+esc(a.title)+'</div><div class="meta">'+when+'</div></div>' +
      '<span class="status '+a.status+'">'+(a.status==='complete'?'Complete':'Live')+'</span>' +
      '<div class="chips">'+chips+'</div>' +
    '</a>';
  }

  async function load(){
    const r = await api('/auctions');
    const list = document.getElementById('list');
    if(!r.ok){ list.innerHTML = '<p style="color:var(--alert)">Could not load auctions. Reload to try again.</p>'; return; }
    const auctions = r.body.auctions || [];
    if(!auctions.length){
      list.innerHTML = '<div class="empty"><strong>No auctions yet</strong>Create one to get started.</div>';
      return;
    }
    list.innerHTML = auctions.map(row).join('');
  }

  load();
})();
