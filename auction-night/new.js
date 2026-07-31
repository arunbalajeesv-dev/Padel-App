(function(){
  const {esc, api} = window.AN;
  const SWATCH = ['#F5A524','#3BC9DB','#FF7A7A','#5BE49B','#AEA1FF','#FFB4D6','#8ED1FC','#D6A756'];
  const MIN_TEAMS = 2, MAX_TEAMS = 8;

  const teamsEl = document.getElementById('teams');
  const addBtn = document.getElementById('addTeam');
  const form = document.getElementById('form');
  const errEl = document.getElementById('formErr');
  const createBtn = document.getElementById('createBtn');

  function teamRow(i){
    const el = document.createElement('div');
    el.className = 'teamrow';
    el.innerHTML = '<span class="swatch" style="background:'+SWATCH[i%SWATCH.length]+'"></span>' +
      '<input placeholder="Team '+(i+1)+' name" maxlength="24" autocomplete="off">' +
      '<button type="button" class="rm" aria-label="Remove team">×</button>';
    el.querySelector('.rm').addEventListener('click', () => {
      if(teamsEl.children.length <= MIN_TEAMS) return;
      el.remove(); renumber();
    });
    return el;
  }

  function renumber(){
    [...teamsEl.children].forEach((el, i) => {
      el.querySelector('.swatch').style.background = SWATCH[i%SWATCH.length];
      const input = el.querySelector('input');
      if(!input.value) input.placeholder = 'Team '+(i+1)+' name';
    });
    addBtn.disabled = teamsEl.children.length >= MAX_TEAMS;
  }

  for(let i=0;i<2;i++) teamsEl.appendChild(teamRow(i));
  renumber();

  addBtn.addEventListener('click', () => {
    if(teamsEl.children.length >= MAX_TEAMS) return;
    teamsEl.appendChild(teamRow(teamsEl.children.length));
    renumber();
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    errEl.hidden = true;
    const teams = [...teamsEl.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
    const title = document.getElementById('title').value.trim();
    const purse = parseInt(document.getElementById('purse').value, 10);
    const slots = parseInt(document.getElementById('slots').value, 10);

    if(teams.length < MIN_TEAMS){ errEl.textContent = 'Name at least ' + MIN_TEAMS + ' teams.'; errEl.hidden = false; return; }

    createBtn.disabled = true; createBtn.textContent = 'Creating…';
    const r = await api('/auctions', {method:'POST', body: JSON.stringify({title, teams, purse, slots})});
    createBtn.disabled = false; createBtn.textContent = 'Create auction';

    if(!r.ok){
      errEl.textContent = (r.body && (r.body.reason || (r.body.errors||[]).join(' '))) || 'Could not create the auction — try again.';
      errEl.hidden = false;
      return;
    }
    window.location.href = 'a/' + r.body.auction.id;
  });
})();
