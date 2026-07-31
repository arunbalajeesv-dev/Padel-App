(function(){
  const AN = window.AN;
  const AUCTION_ID = location.pathname.split('/').filter(Boolean).pop();
  const MINE_KEY = 'auction:me:' + AUCTION_ID;
  const ROLE_KEY = 'auction:role:' + AUCTION_ID;

  // Anti-sniping window — mirrors src/services/auctionNightService.js. A bid
  // landing inside the last TIMER_EXTEND_WINDOW_SECONDS of the countdown
  // pushes the deadline out by TIMER_EXTEND_SECONDS.
  const TIMER_EXTEND_SECONDS = 15;
  const TIMER_EXTEND_WINDOW_SECONDS = 10;

  const $ = id => document.getElementById(id);

  function normalize(doc){
    const d = doc || {};
    return {
      id: d.id, title: d.title || 'Auction Night', rev: d.rev || 0,
      settings: Object.assign({ purse: 30000, slots: 3, floorPrice: 100, steps: [100,250,500,1000,2500], timerSeconds: 0 }, d.settings || {}),
      teams: Array.isArray(d.teams) ? d.teams : [],
      seq: d.seq || 1,
      players: Array.isArray(d.players) ? d.players : [],
      currentId: d.currentId ?? null,
      bid: d.bid || 0,
      bidder: d.bidder ?? null,
      step: d.step || 500,
      lotEndsAt: d.lotEndsAt ?? null,
      history: Array.isArray(d.history) ? d.history : [],
      purse: d.purse || {},
      seats: d.seats || {},
      status: d.status || 'live',
    };
  }

  let S = null;
  let me = 'g' + Math.random().toString(36).slice(2, 9);
  let seat = null;          // team key | 'mod' | 'watch'
  let unlockedRole = null;  // 'captain' | 'mod' | 'viewer' — which PIN this device entered
  let sale = null, flip = false, offline = false, seenSold = 0;

  function saveMe(){ try{ localStorage.setItem(MINE_KEY, JSON.stringify({me, seat})); }catch(e){} }
  function loadMe(){
    try{
      const raw = localStorage.getItem(MINE_KEY);
      if(raw){ const d = JSON.parse(raw); me = d.me || me; seat = d.seat || null; }
    }catch(e){}
  }
  function saveRole(){ try{ localStorage.setItem(ROLE_KEY, unlockedRole); }catch(e){} }
  function loadRole(){ try{ unlockedRole = localStorage.getItem(ROLE_KEY) || null; }catch(e){} }

  const teamByKey = key => S.teams.find(t => t.key === key);
  const isCaptain = () => !!teamByKey(seat);
  const isMod = () => seat === 'mod';
  const modSeated = () => !!(S.seats && S.seats.mod);
  // The moderator runs the floor. Until one takes the chair, the captains run it themselves.
  const canRun = () => isMod() || (isCaptain() && !modSeated());
  const seatName = key => key === 'mod' ? 'Moderator' : (teamByKey(key) ? teamByKey(key).name : 'Spectator');

  const roster = key => S.players.filter(p => p.status === 'sold' && p.team === key);
  const pool = () => S.players.filter(p => p.status !== 'sold');
  const current = () => S.players.find(p => p.id === S.currentId) || null;
  const maxBid = key => S.purse[key] - (S.settings.slots - roster(key).length - 1) * S.settings.floorPrice;
  const done = () => S.teams.every(t => roster(t.key).length === S.settings.slots);

  // Call after S.currentId changes: starts the countdown if there's a real
  // lot on the block and this auction has a timer configured, clears it
  // otherwise (nothing on the block, or no timer).
  function startLotTimer(){
    S.lotEndsAt = (S.currentId && S.settings.timerSeconds) ? Date.now() + S.settings.timerSeconds * 1000 : null;
  }
  // A bid landing near the buzzer pushes the deadline out — the countdown
  // exists to create urgency, not to cut off a live bidding war mid-raise.
  function maybeExtendTimer(){
    if(!S.lotEndsAt) return;
    const remainingMs = S.lotEndsAt - Date.now();
    if(remainingMs <= TIMER_EXTEND_WINDOW_SECONDS * 1000){
      S.lotEndsAt = Date.now() + TIMER_EXTEND_SECONDS * 1000;
    }
  }

  /* ---------- sync ----------
     Every write carries the revision it was read against. The server (a
     Firestore transaction, see auctionNightService.js) accepts it only if
     that revision is still current, otherwise it hands back the real latest
     state with a 409. On conflict we adopt that state and simply retry the
     SAME intent from scratch — safe because every mutator below only ever
     reads fresh state at call time; nothing accumulates across retries. */
  function adopt(doc){
    S = normalize(doc);
    if((isCaptain() || isMod()) && S.seats[seat] !== me){
      AN.toast('Your seat was reassigned — you are now watching');
      seat = 'watch'; saveMe();
    }
    if(S.history.length > seenSold) flashLast();
  }

  let queue = Promise.resolve();
  function tx(fn){
    queue = queue.then(async () => {
      let base = S;
      for(let attempt = 0; attempt < 5; attempt++){
        S = base;
        const result = fn();
        if(result === false){ render(); return; }
        const r = await AN.api('/auctions/' + AUCTION_ID, {
          method: 'POST',
          body: JSON.stringify({ expectedRev: base.rev, state: S }),
        });
        if(r.ok){ adopt(r.body.auction); render(); return; }
        if(r.conflict && r.body && r.body.auction){ base = normalize(r.body.auction); continue; }
        AN.toast(r.network ? 'Connection lost — try again' : 'Could not save — try again');
        S = base; render(); return;
      }
      AN.toast('Too much happening at once — try that again');
      render();
    }).catch(() => {});
    return queue;
  }

  function goOffline(){
    if(offline) return;
    offline = true;
    $('warnSlot').innerHTML = '<p class="warn">Lost connection to the auction. This screen will keep retrying automatically.</p>';
    render();
  }

  async function pull(){
    const r = await AN.api('/auctions/' + AUCTION_ID);
    if(!r.ok){ goOffline(); return; }
    if(offline){ offline = false; $('warnSlot').innerHTML = ''; }
    if(!S || (r.body.auction.rev || 0) > S.rev){ adopt(r.body.auction); render(); }
  }

  function flashLast(){
    const last = S.history[S.history.length - 1];
    seenSold = S.history.length;
    if(!last) return;
    sale = last;
    setTimeout(() => { sale = null; render(); }, 1400);
  }

  /* ---------- PIN gate ----------
     Entering a PIN unlocks a ROLE TIER (captain / mod / viewer), remembered
     per-device via localStorage so it isn't asked again on reload. The seat
     picker below then only offers what that tier is allowed to take — a
     viewer PIN skips the picker entirely and goes straight to watching. */
  function showPinGate(on){
    const g = $('pinGate');
    g.hidden = !on;
    g.style.display = on ? 'grid' : 'none';
  }
  async function submitPin(pin){
    const err = $('pinErr');
    err.hidden = true;
    if(!/^\d{4}$/.test(pin)){ err.textContent = 'Enter the 4-digit PIN.'; err.hidden = false; return; }
    const r = await AN.api('/auctions/' + AUCTION_ID + '/verify-pin', { method: 'POST', body: JSON.stringify({ pin }) });
    if(!r.ok){
      err.textContent = r.status === 401 ? 'That PIN is not right — check with your organizer.' : 'Could not check that PIN — try again.';
      err.hidden = false;
      return;
    }
    unlockedRole = r.body.role; saveRole();
    showPinGate(false);
    $('pinInput').value = '';
    enterWithRole();
  }
  // Called once a role is known (fresh PIN entry, or already remembered from
  // a past visit): a viewer PIN never sees a seat picker at all.
  function enterWithRole(){
    if(unlockedRole === 'viewer' && (!seat || seat === 'watch')){ takeSeat('watch'); return; }
    if(!seat || ((isCaptain() || isMod()) && S.seats[seat] !== me)) openGate();
  }

  /* ---------- seats ---------- */
  function showGate(on){
    const g = $('gate');
    g.hidden = !on;
    g.style.display = on ? 'grid' : 'none';
  }
  function openGate(){
    // Inclusion, not exclusion — a viewer PIN must see NEITHER team nor mod
    // seats here, so each row is only added for the tier that's allowed it.
    const rows = unlockedRole === 'captain' ? S.teams.map(t => {
      const held = S.seats[t.key];
      const label = held === me ? 'Your seat' : (held ? 'Taken · tap to claim' : 'Free');
      return '<button class="seatbtn" data-seat="' + t.key + '" style="--tc:' + t.color + '">' + AN.esc(t.name) + ' <small>' + label + '</small></button>';
    }).join('') : '';
    const modHeld = S.seats.mod;
    const modLabel = modHeld === me ? 'Your seat' : (modHeld ? 'Taken · tap to claim' : 'Runs the floor');
    const modRow = unlockedRole === 'mod' ?
      '<button class="seatbtn" data-seat="mod" style="--tc:var(--mod)">Moderator <small>' + modLabel + '</small></button>' : '';
    $('seatList').innerHTML = rows + modRow +
      '<button class="seatbtn" data-seat="watch">Just watching <small>view only</small></button>';
    showGate(true);
  }
  async function takeSeat(k){
    if(k === 'watch'){
      const had = seat;
      seat = 'watch'; showGate(false); saveMe(); render();
      if(had && had !== 'watch') await tx(() => { if(S.seats[had] === me) S.seats[had] = null; else return false; });
      return;
    }
    const held = S.seats[k];
    if(held && held !== me && !await AN.ask(seatName(k) + "'s seat is already open on another device. Take it over here?")) return;
    const had = seat;
    seat = k; showGate(false); render(); saveMe();
    await tx(() => {
      if(had && had !== 'watch' && had !== k && S.seats[had] === me) S.seats[had] = null;
      S.seats[k] = me;
    });
  }
  async function freeSeat(k){
    if(!isMod() || !S.seats[k]) return;
    if(!await AN.ask('Free ' + seatName(k) + "'s seat? That device drops to view only.")) return;
    tx(() => { if(!S.seats[k]) return false; S.seats[k] = null; AN.toast(seatName(k) + "'s seat is open"); });
  }

  /* ---------- actions ---------- */
  function guard(){
    if(canRun()) return true;
    AN.toast(isCaptain() ? 'The moderator runs the floor' : 'View only — you cannot change the auction');
    return false;
  }

  function addPlayers(){
    if(!guard()) return;
    const raw = $('fName').value.trim();
    if(!raw) return AN.toast('Type a player name first');
    const role = $('fRole').value.trim();
    const base = Math.max(S.settings.floorPrice, parseInt($('fBase').value, 10) || S.settings.floorPrice);
    const names = raw.split(',').map(x => x.trim()).filter(Boolean);
    $('fName').value = ''; $('fRole').value = ''; $('fName').focus();
    tx(() => {
      names.forEach(name => S.players.push({ id: S.seq++, name, role, base, status: 'pool', team: null, price: 0 }));
      if(!S.currentId){ const n = pool()[0]; if(n){ S.currentId = n.id; S.bid = 0; S.bidder = null; startLotTimer(); } }
    });
  }

  function nextLot(notify){
    if(!guard()) return;
    tx(() => {
      const next = pool().find(p => p.status === 'pool') || pool()[0];
      S.currentId = next ? next.id : null;
      if(!next && notify !== false) AN.toast('Pool is empty');
      S.bid = 0; S.bidder = null;
      startLotTimer();
    });
  }

  function stageLot(id){
    if(!guard()) return;
    tx(() => {
      if(!S.players.some(p => p.id === id && p.status !== 'sold')) return false;
      S.currentId = id; S.bid = 0; S.bidder = null;
      startLotTimer();
    });
  }

  function bid(team){
    if(seat !== team) return AN.toast(
      isMod() ? 'Moderators call the auction, they do not bid'
      : isCaptain() ? 'You can only bid for ' + teamByKey(seat).name
      : 'View only — you cannot bid');
    tx(() => {
      const p = current();
      if(!p){ AN.toast('No player on the block'); return false; }
      if(roster(team).length >= S.settings.slots){ AN.toast('Your squad is full'); return false; }
      if(S.bidder === team){ AN.toast('You already lead'); return false; }
      const next = S.bidder ? S.bid + S.step : p.base;
      if(next > maxBid(team)){ AN.toast('You can go up to ' + AN.money(maxBid(team)) + ' only'); return false; }
      S.bid = next; S.bidder = team; flip = true;
      maybeExtendTimer();
    });
  }

  // A captain's own jump — an explicit raise amount instead of the shared
  // step, e.g. bidding +2000 to scare off a rival. Still has to clear the
  // current step, same floor as an ordinary bid.
  function bidCustom(team, raise){
    if(seat !== team) return AN.toast(
      isMod() ? 'Moderators call the auction, they do not bid'
      : isCaptain() ? 'You can only bid for ' + teamByKey(seat).name
      : 'View only — you cannot bid');
    tx(() => {
      const p = current();
      if(!p){ AN.toast('No player on the block'); return false; }
      if(roster(team).length >= S.settings.slots){ AN.toast('Your squad is full'); return false; }
      if(S.bidder === team){ AN.toast('You already lead'); return false; }
      if(!Number.isFinite(raise) || raise < S.step){ AN.toast('Jump must be at least ' + AN.money(S.step)); return false; }
      const next = (S.bidder ? S.bid : p.base) + raise;
      if(next > maxBid(team)){ AN.toast('You can go up to ' + AN.money(maxBid(team)) + ' only'); return false; }
      S.bid = next; S.bidder = team; flip = true;
      maybeExtendTimer();
    });
  }

  function hammer(){
    if(!guard()) return;
    tx(() => {
      const p = current();
      if(!p || !S.bidder){ AN.toast('No bids yet — mark it unsold instead'); return false; }
      const team = S.bidder, price = S.bid;
      p.status = 'sold'; p.team = team; p.price = price;
      S.purse[team] -= price;
      S.history.push({ id: p.id, name: p.name, team, price });
      S.currentId = null; S.bid = 0; S.bidder = null; S.lotEndsAt = null;
      flashLast();
    }).then(() => {
      setTimeout(() => { if(!done() && canRun() && !S.currentId) nextLot(false); }, 1400);
    });
  }

  // Auto-resolve when the countdown hits zero — sells to whoever's leading,
  // or marks unsold with no bids. Deliberately bypasses guard(): this is a
  // system trigger the moderator opted into by starting the timer, not a
  // person acting, so it runs from ANY connected device (even a spectator's
  // tab), not just one with canRun(). Whichever device's tick notices first
  // wins; the rest 409, adopt the resolved state, and no-op on retry.
  function resolveExpiredLot(){
    tx(() => {
      const p = current();
      if(!p || !S.lotEndsAt || Date.now() < S.lotEndsAt) return false;
      if(S.bidder){
        const team = S.bidder, price = S.bid;
        p.status = 'sold'; p.team = team; p.price = price;
        S.purse[team] -= price;
        S.history.push({ id: p.id, name: p.name, team, price });
        flashLast();
      } else {
        p.status = 'unsold';
      }
      S.currentId = null; S.bid = 0; S.bidder = null; S.lotEndsAt = null;
    }).then(() => {
      setTimeout(() => { if(!done() && canRun() && !S.currentId) nextLot(false); }, 1400);
    });
  }

  function unsold(){
    if(!guard()) return;
    tx(() => {
      const p = current();
      if(!p) return false;
      p.status = 'unsold'; AN.toast(p.name + ' goes unsold');
      const next = pool().find(x => x.status === 'pool');
      S.currentId = next ? next.id : null; S.bid = 0; S.bidder = null;
      startLotTimer();
    });
  }

  function undo(){
    if(!guard()) return;
    tx(() => {
      const last = S.history.pop();
      if(!last){ AN.toast('Nothing to undo'); return false; }
      const p = S.players.find(x => x.id === last.id);
      if(p){ p.status = 'pool'; p.team = null; p.price = 0; }
      S.purse[last.team] += last.price;
      seenSold = S.history.length; sale = null;
      AN.toast(last.name + ' is back in the pool');
    });
  }

  function removePlayer(id){
    if(!guard()) return;
    tx(() => {
      S.players = S.players.filter(p => p.id !== id);
      if(S.currentId === id){ S.currentId = null; S.bid = 0; S.bidder = null; S.lotEndsAt = null; }
    });
  }

  async function reset(){
    if(!guard()) return;
    if(!await AN.ask('Clear every player, bid and squad for everyone watching?')) return;
    tx(() => {
      S.players = []; S.history = [];
      S.currentId = null; S.bid = 0; S.bidder = null; S.lotEndsAt = null;
      S.step = S.settings.steps[2] ?? S.settings.steps[0];
      S.purse = Object.fromEntries(S.teams.map(t => [t.key, S.settings.purse]));
      seenSold = 0; sale = null;
    });
  }

  /* ---------- render ---------- */
  function teamCardHTML(key){
    const t = teamByKey(key), mine = roster(key), left = S.purse[key], p = current();
    const full = mine.length >= S.settings.slots, isMe = seat === key;
    const next = p ? (S.bidder ? S.bid + S.step : p.base) : 0;
    const cap = maxBid(key);
    const canBid = isMe && !!p && !full && S.bidder !== key && next <= cap && !sale;

    let note;
    if(full) note = 'Squad complete';
    else if(!isMe) note = S.seats[key] ? 'Seated on another device' : 'Seat open';
    else if(!p) note = 'Waiting for a lot';
    else if(S.bidder === key) note = 'You lead the bidding';
    else if(next > cap) note = 'Max bid ' + AN.money(cap) + ' — priced out';
    else note = 'Max bid ' + AN.money(cap);

    const slots = Array.from({ length: S.settings.slots }, (_, i) => mine[i]
      ? '<div class="slot filled">' + AN.esc(mine[i].name) + '</div>' : '<div class="slot">Open</div>').join('');

    const jumpRow = canBid
      ? '<div class="jumprow"><input type="number" class="jumpinput" data-jump-input="' + key + '" min="' + S.step + '" step="' + S.step + '" placeholder="Raise by…">' +
        '<button class="mini" data-jump="' + key + '">Jump</button></div>'
      : '';

    return '<div class="team-head"><span class="team-role">Captain</span>' +
        (isMe ? '<span class="you">You</span>' : (S.seats[key] ? '<span class="seatst">Seated</span>' : '')) +
        (isMod() && S.seats[key] ? '<button class="mini" style="margin-left:auto" data-free="' + key + '">Free seat</button>' : '') + '</div>' +
      '<div class="team-name">' + AN.esc(t.name) + '</div>' +
      '<div class="purse" style="margin-top:8px"><small>Coins left</small>' + AN.money(left) + '</div>' +
      '<div class="meter" style="margin:6px 0 10px"><i style="width:' + Math.max(0, left / S.settings.purse * 100) + '%"></i></div>' +
      '<div class="slots" style="margin-bottom:10px">' + slots + '</div>' +
      '<button class="paddle" data-bid="' + key + '"' + (canBid ? '' : ' disabled') + '>' +
        (isMe ? (p && !full ? 'Bid ' + AN.money(next) : 'Bid') : 'Bid') + '</button>' +
      jumpRow +
      '<div class="team-note" style="margin-top:6px">' + note + '</div>';
  }

  function lotHTML(){
    if(sale){
      const t = teamByKey(sale.team);
      return '<div class="stamp" style="color:' + (t ? t.color : 'var(--chalk)') + '"><div><b>Sold</b>' +
        '<span>' + AN.esc(sale.name) + ' — ' + AN.esc(t ? t.name : '') + ' · ' + AN.money(sale.price) + '</span></div></div>';
    }
    if(done()) return '<div class="lotempty"><strong>Auction complete</strong><p>All squads are full.</p></div>';
    const p = current();
    if(!p) return '<div class="lotempty"><strong>Nothing on the block</strong><p>' +
      (canRun() ? 'Add players to the pool, then send one up for bidding.' : 'Waiting for the next lot to be sent up.') + '</p></div>';

    const lotNo = String(S.history.length + 1).padStart(2, '0');
    const timerHtml = S.lotEndsAt ? '<div class="timer" id="lotTimer">' + formatCountdown(S.lotEndsAt - Date.now()) + '</div>' : '';
    const steps = S.settings.steps.map(s => '<button class="step" data-step="' + s + '" aria-pressed="' + (S.step === s) + '"' + (canRun() ? '' : ' disabled') + '>+' + AN.money(s) + '</button>').join('');
    const leaderTeam = S.bidder ? teamByKey(S.bidder) : null;
    const leader = leaderTeam
      ? '<div class="leader" style="color:' + leaderTeam.color + '">' + AN.esc(leaderTeam.name) + ' leads</div>'
      : '<div class="leader" style="color:var(--dim)">No bids yet · opens at ' + AN.money(p.base) + '</div>';

    return '<div class="lot-no">Lot ' + lotNo + (p.status === 'unsold' ? ' · re-listed' : '') + '</div>' +
      timerHtml +
      '<div><div class="lot-name">' + AN.esc(p.name) + '</div>' +
      '<div class="lot-role">' + (p.role ? AN.esc(p.role) + ' · ' : '') + 'base ' + AN.money(p.base) + '</div></div>' +
      '<div><div class="price-label">Current bid</div>' +
      '<div class="price' + (flip ? ' flip' : '') + '" style="color:' + (leaderTeam ? leaderTeam.color : 'var(--chalk)') + '">' +
        AN.money(S.bidder ? S.bid : p.base) + '</div></div>' + leader +
      '<div><div class="price-label" style="margin-bottom:6px">Raise by</div><div class="steps">' + steps + '</div></div>' +
      (canRun() ? '<div class="lot-actions">' +
        '<button class="hammer" id="hammerBtn"' + (S.bidder ? '' : ' disabled') + '>Hammer</button>' +
        '<button class="ghost" id="unsoldBtn">Unsold</button>' +
        '<button class="ghost" id="nextBtn">Next lot</button></div>'
      : '<div class="lot-actions"><span class="lot-role">Watching live · updates every few seconds</span></div>');
  }

  function poolHTML(){
    const list = pool();
    if(!list.length) return '<p class="hint" style="margin:0">No players yet.</p>';
    return list.map(p =>
      '<div class="row' + (p.id === S.currentId ? ' up' : '') + '">' +
        '<div><div class="nm">' + AN.esc(p.name) + (p.status === 'unsold' ? ' <span class="tag">Unsold</span>' : '') + '</div>' +
        (p.role ? '<div class="rl">' + AN.esc(p.role) + '</div>' : '') + '</div>' +
        '<div class="pr">' + AN.money(p.base) + '</div>' +
        (canRun()
          ? (p.id === S.currentId ? '<span class="pr" style="color:var(--chalk)">On block</span>'
             : '<button class="mini" data-stage="' + p.id + '">Send up</button>') +
            '<button class="mini" data-remove="' + p.id + '" aria-label="Remove ' + AN.esc(p.name) + '">×</button>'
          : (p.id === S.currentId ? '<span class="pr" style="color:var(--chalk)">On block</span>' : '')) +
      '</div>').join('');
  }

  function rosterHTML(key){
    const t = teamByKey(key), mine = roster(key), spent = S.settings.purse - S.purse[key];
    const rows = Array.from({ length: S.settings.slots }, (_, i) => {
      const p = mine[i];
      return p ? '<div class="rrow"><b>' + AN.esc(p.name) + '</b>' + (p.role ? '<span class="rl">' + AN.esc(p.role) + '</span>' : '') +
        '<span class="p">' + AN.money(p.price) + '</span></div>' : '<div class="rrow open">Open slot</div>';
    }).join('');
    return '<div class="roster" style="--tc:' + t.color + '"><h3>' + AN.esc(t.name) + '</h3>' +
      '<div class="spent">Spent ' + AN.money(spent) + ' · Left ' + AN.money(S.purse[key]) + '</div>' + rows + '</div>';
  }

  function formatCountdown(ms){
    const secs = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(secs / 60)) + ':' + String(secs % 60).padStart(2, '0');
  }

  // Runs independently of the 2s network poll so the countdown ticks
  // smoothly; only touches the timer element directly rather than a full
  // render(), and is also where auto-resolution actually gets noticed.
  function tickTimer(){
    if(!S || !S.lotEndsAt) return;
    const remaining = S.lotEndsAt - Date.now();
    if(remaining <= 0){ resolveExpiredLot(); return; }
    const el = $('lotTimer');
    if(el){
      el.textContent = formatCountdown(remaining);
      el.classList.toggle('low', remaining <= TIMER_EXTEND_WINDOW_SECONDS * 1000);
    }
  }

  function render(){
    if(!S) return;
    $('titleEl').textContent = S.title;
    document.title = S.title + ' — Auction Night';
    $('teamsGrid').innerHTML = S.teams.map(t => '<article class="card team-card" style="--tc:' + t.color + '">' + teamCardHTML(t.key) + '</article>').join('');
    $('lot').innerHTML = lotHTML();
    $('poolList').innerHTML = poolHTML();
    $('rosters').innerHTML = S.teams.map(t => rosterHTML(t.key)).join('');
    $('poolCount').textContent = pool().length + ' available';
    $('soldCount').textContent = S.history.length + ' sold';

    const w = $('whoami');
    w.textContent = isMod() ? 'Moderating' : isCaptain() ? 'Bidding as ' + teamByKey(seat).name : 'View only';
    w.style.setProperty('--seatc', isMod() ? 'var(--mod)' : isCaptain() ? teamByKey(seat).color : 'var(--dim)');
    ['fName','fRole','fBase','addBtn','undoBtn','resetBtn'].forEach(id => $(id).disabled = !canRun());
    $('poolHint').textContent = canRun()
      ? 'Separate names with commas to add several at once. Base price is the opening bid.'
      : modSeated() ? 'The moderator manages the pool.' : 'Only the captains can add or remove players.';

    let keysHtml = '';
    if(isMod()) keysHtml = '<b>S</b> sell · <b>U</b> unsold · <b>N</b> next lot';
    else if(isCaptain()){
      const idx = S.teams.findIndex(t => t.key === seat);
      keysHtml = '<b>' + (idx + 1) + '</b> place your bid' + (canRun() ? ' · <b>S</b> sell · <b>U</b> unsold · <b>N</b> next lot' : '');
    }
    $('keysHint').innerHTML = keysHtml;
    $('keysHint').style.display = (isMod() || isCaptain()) ? '' : 'none';

    $('liveLabel').textContent = offline
      ? 'Connection lost · retrying'
      : modSeated() ? 'Live auction · moderator on the floor · ' + AN.money(S.settings.purse) + ' coins each'
      : 'Live auction · ' + S.settings.slots + ' players per side · ' + AN.money(S.settings.purse) + ' coins each';
    flip = false;
  }

  /* ---------- wiring ---------- */
  document.addEventListener('click', e => {
    const b = e.target.closest('button'); if(!b) return;
    if(b.dataset.seat) return takeSeat(b.dataset.seat);
    if(b.dataset.free) return freeSeat(b.dataset.free);
    if(b.dataset.bid) return bid(b.dataset.bid);
    if(b.dataset.jump){
      const input = document.querySelector('[data-jump-input="' + b.dataset.jump + '"]');
      const raise = input ? parseInt(input.value, 10) : NaN;
      if(!Number.isFinite(raise) || raise <= 0) return AN.toast('Enter a raise amount first');
      return bidCustom(b.dataset.jump, raise);
    }
    if(b.dataset.step){ if(!guard()) return; const v = +b.dataset.step; return tx(() => { S.step = v; }); }
    if(b.dataset.stage) return stageLot(+b.dataset.stage);
    if(b.dataset.remove) return removePlayer(+b.dataset.remove);
    if(b.id === 'hammerBtn') return hammer();
    if(b.id === 'unsoldBtn') return unsold();
    if(b.id === 'nextBtn') return nextLot(true);
    if(b.id === 'addBtn') return addPlayers();
    if(b.id === 'undoBtn') return undo();
    if(b.id === 'resetBtn') return reset();
    if(b.id === 'switchBtn') return openGate();
    if(b.id === 'wrongPinBtn'){
      unlockedRole = null; saveRole(); seat = null; saveMe();
      showGate(false); showPinGate(true); $('pinInput').focus();
      return;
    }
  });

  $('pinForm').addEventListener('submit', e => {
    e.preventDefault();
    submitPin($('pinInput').value.trim());
  });

  ['fName','fRole','fBase'].forEach(id => $(id).addEventListener('keydown', e => { if(e.key === 'Enter') addPlayers(); }));

  document.addEventListener('keydown', e => {
    if(e.key !== 'Enter' || !e.target.matches('[data-jump-input]')) return;
    e.preventDefault();
    const key = e.target.dataset.jumpInput;
    const raise = parseInt(e.target.value, 10);
    if(!Number.isFinite(raise) || raise <= 0) return AN.toast('Enter a raise amount first');
    bidCustom(key, raise);
  });

  document.addEventListener('keydown', e => {
    if(!S || e.target.matches('input') || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.gate:not([hidden])')) return;
    if(/^[1-9]$/.test(e.key)){
      const team = S.teams[parseInt(e.key, 10) - 1];
      if(team && seat === team.key){ e.preventDefault(); bid(team.key); }
      return;
    }
    const k = e.key.toLowerCase();
    if(k === 's'){ e.preventDefault(); hammer(); }
    else if(k === 'u'){ e.preventDefault(); unsold(); }
    else if(k === 'n'){ e.preventDefault(); nextLot(true); }
  });

  // Mobile browsers throttle timers on a backgrounded/locked tab, so the
  // countdown may not fire the instant it hits zero if nobody's looking.
  // Catching up on visibility regain means it self-heals within moments of
  // anyone glancing at their phone, rather than staying stuck expired.
  document.addEventListener('visibilitychange', () => { if(!document.hidden){ pull(); tickTimer(); } });

  window.addEventListener('error', e => {
    $('warnSlot').innerHTML = '<p class="warn">Something broke on this screen: ' +
      AN.esc((e.error && e.error.message) || e.message || 'unknown error') + ' — reload to recover.</p>';
  });

  (async function init(){
    loadMe(); loadRole();
    const r = await AN.api('/auctions/' + AUCTION_ID);
    if(!r.ok){
      document.querySelector('.wrap').innerHTML =
        '<div class="card" style="margin-top:40px;text-align:center"><strong style="display:block;font-family:var(--display);font-size:24px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px">Auction not found</strong>' +
        '<p style="color:var(--dim)">This link may be wrong, or the auction was deleted. <a href="../">See all auctions</a>.</p></div>';
      return;
    }
    adopt(r.body.auction);
    seenSold = S.history.length;
    render();
    if(!unlockedRole){ showPinGate(true); $('pinInput').focus(); }
    else enterWithRole();
    setInterval(pull, 2000);
    setInterval(tickTimer, 500);
  })();
})();
