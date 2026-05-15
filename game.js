'use strict';

// ─── Global state ───────────────────────────────────────────────────────────
const G = {
  state: 'landing',
  peer: null,
  conn: null,
  role: null,
  roomCode: null,
  mySecret: null,
  myReadySent: false,
  opponentReady: false,
  myGuesses: [],
  opponentGuesses: [],
  myTurn: false,
  guessPending: false,
  won: false,
  connectTimeout: null,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function isValidNumber(s) {
  return /^\d{4}$/.test(s) && new Set(s).size === 4;
}

function calcHitBlow(secret, guess) {
  let hits = 0, blows = 0;
  for (let i = 0; i < 4; i++) {
    if (guess[i] === secret[i]) hits++;
    else if (secret.includes(guess[i])) blows++;
  }
  return { hits, blows };
}

// ルームコード(6文字)を自動生成 — 紛らわしい文字(0/O, 1/I/L)を除外
function generateRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ルームコード → PeerJS ID (英数字のみの安全な形式)
function toPeerId(code) {
  let hex = '';
  for (const ch of code) hex += ch.codePointAt(0).toString(16).padStart(4, '0');
  return 'hb' + hex;
}

function send(msg) {
  if (G.conn && G.conn.open) G.conn.send(msg);
}

// ─── Numpad factory ───────────────────────────────────────────────────────────
function createNumpad(prefix, onSubmit) {
  let value = '';
  let enabled = true;

  const slots     = [0, 1, 2, 3].map(i => document.getElementById(`${prefix}-slot-${i}`));
  const digitBtns = document.querySelectorAll(`#numpad-${prefix} [data-digit]`);
  const delBtn    = document.querySelector(`#numpad-${prefix} [data-action="del"]`);
  const okBtn     = document.querySelector(`#numpad-${prefix} [data-action="ok"]`);

  function refresh() {
    slots.forEach((slot, i) => {
      if (i < value.length) {
        slot.textContent = value[i];
        slot.classList.add('filled');
        slot.classList.remove('active');
      } else if (i === value.length && enabled) {
        slot.textContent = '—';
        slot.classList.remove('filled');
        slot.classList.add('active');
      } else {
        slot.textContent = '—';
        slot.classList.remove('filled', 'active');
      }
    });
    digitBtns.forEach(btn => {
      btn.disabled = !enabled || value.includes(btn.dataset.digit) || value.length >= 4;
    });
    if (delBtn) delBtn.disabled = !enabled || value.length === 0;
    if (okBtn)  okBtn.disabled  = !enabled || value.length !== 4;
  }

  digitBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (!enabled || value.length >= 4 || value.includes(btn.dataset.digit)) return;
      value += btn.dataset.digit;
      refresh();
    });
  });
  if (delBtn) delBtn.addEventListener('click', () => {
    if (!enabled || value.length === 0) return;
    value = value.slice(0, -1);
    refresh();
  });
  if (okBtn) okBtn.addEventListener('click', () => {
    if (!enabled || value.length !== 4) return;
    onSubmit(value);
  });

  refresh();
  return {
    reset()       { value = ''; refresh(); },
    getValue()    { return value; },
    setEnabled(v) { enabled = v; refresh(); },
  };
}

// ─── State machine ───────────────────────────────────────────────────────────
function setState(newState) {
  G.state = newState;
  renderUI();
}

// ─── Render ──────────────────────────────────────────────────────────────────
const screens = [
  'landing', 'creating', 'waiting', 'joining',
  'connecting', 'setup', 'game', 'result', 'disconnected',
];

function renderUI() {
  screens.forEach(id => {
    const el = document.getElementById('screen-' + id);
    if (el) el.classList.toggle('hidden', G.state !== id);
  });
  if (G.state === 'game') renderGame();
}

function renderGame() {
  const badge = document.getElementById('turn-badge');
  if (G.myTurn) {
    badge.textContent = 'あなたのターン';
    badge.classList.add('my-turn');
  } else {
    badge.textContent = '相手のターン';
    badge.classList.remove('my-turn');
  }
  guessNumpad.setEnabled(G.myTurn && !G.guessPending);
  renderGuessTable('my-guess-body',  'my-guess-empty',  G.myGuesses);
  renderGuessTable('opp-guess-body', 'opp-guess-empty', G.opponentGuesses);
}

function renderGuessTable(bodyId, emptyId, list) {
  const tbody = document.getElementById(bodyId);
  const empty = document.getElementById(emptyId);
  tbody.innerHTML = '';
  if (list.length === 0) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  list.forEach((entry, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${entry.guess}</td>
      <td class="${entry.hits  > 0 ? 'hit-val'  : 'zero-val'}">${entry.hits}</td>
      <td class="${entry.blows > 0 ? 'blow-val' : 'zero-val'}">${entry.blows}</td>
    `;
    tbody.appendChild(tr);
  });
}

function showResult(won, opponentSecret) {
  G.won = won;
  document.getElementById('result-icon').textContent  = won ? '🏆' : '😢';
  document.getElementById('result-title').textContent = won ? 'あなたの勝ち！' : 'あなたの負け...';
  document.getElementById('result-my-secret').textContent  = G.mySecret || '—';
  document.getElementById('result-opp-secret').textContent = opponentSecret || '...';
  setState('result');
}

function revealOpponentSecret(secret) {
  document.getElementById('result-opp-secret').textContent = secret;
}

// ─── PeerJS Host ──────────────────────────────────────────────────────────────
// ランダムコードを自動生成してルームを作る。IDが衝突した場合は自動リトライ。
function createRoom(attempt = 0) {
  if (attempt >= 5) { setState('disconnected'); return; }

  const code = generateRoomCode();
  G.roomCode = code;
  G.role = 'host';
  setState('creating');

  if (G.peer) { try { G.peer.destroy(); } catch (_) {} G.peer = null; }
  G.peer = new Peer(toPeerId(code), { debug: 0 });

  G.peer.on('open', () => {
    document.getElementById('room-code-display').textContent = code;
    setState('waiting');
  });

  G.peer.on('connection', conn => {
    G.conn = conn;
    setupConnectionHandlers();
    // データチャンネルが開いたら conn.on('open') 内で setup へ遷移
  });

  G.peer.on('error', err => {
    if (err.type === 'unavailable-id') {
      // 同じコードが既に使用中 → 別コードで自動リトライ
      createRoom(attempt + 1);
    } else {
      handlePeerError(err);
    }
  });
}

// ─── PeerJS Guest ─────────────────────────────────────────────────────────────
function joinRoom(code) {
  G.roomCode = code;
  setState('connecting');
  G.role = 'guest';

  G.connectTimeout = setTimeout(() => {
    if (G.state !== 'connecting') return;
    const errEl = document.getElementById('join-error');
    errEl.textContent = '接続がタイムアウトしました。ルームコードを確認して再度お試しください。';
    errEl.classList.remove('hidden');
    if (G.peer) { try { G.peer.destroy(); } catch (_) {} G.peer = null; }
    G.connectTimeout = null;
    setState('joining');
  }, 15000);

  G.peer = new Peer(undefined, { debug: 0 });

  G.peer.on('open', () => {
    G.conn = G.peer.connect(toPeerId(code));
    setupConnectionHandlers();
  });

  G.peer.on('error', handlePeerError);
}

// ─── Connection handlers ──────────────────────────────────────────────────────
function setupConnectionHandlers() {
  // ホスト・ゲスト両方、データチャンネルが開いてから setup へ
  G.conn.on('open', () => {
    if (G.connectTimeout) { clearTimeout(G.connectTimeout); G.connectTimeout = null; }
    setState('setup');
  });

  G.conn.on('data', msg => {
    switch (msg.type) {
      case 'READY':  handleOpponentReady();           break;
      case 'GUESS':  handleOpponentGuess(msg.guess);  break;
      case 'RESULT': handleResult(msg);               break;
      case 'REVEAL': revealOpponentSecret(msg.secret); break;
    }
  });

  G.conn.on('close', () => { if (G.state !== 'result') setState('disconnected'); });
  G.conn.on('error', () => { if (G.state !== 'result') setState('disconnected'); });
}

// ─── Setup phase ─────────────────────────────────────────────────────────────
function submitSecret(val) {
  G.mySecret = val;
  G.myReadySent = true;
  setupNumpad.setEnabled(false);
  document.getElementById('setup-waiting').classList.remove('hidden');
  send({ type: 'READY' });
  tryStartGame();
}

function handleOpponentReady() {
  G.opponentReady = true;
  tryStartGame();
}

function tryStartGame() {
  if (G.myReadySent && G.opponentReady) {
    G.myTurn = G.role === 'host';
    setState('game');
  }
}

// ─── Game phase ───────────────────────────────────────────────────────────────
function submitGuess(val) {
  if (!G.myTurn || G.guessPending) return;
  G.guessPending = true;
  G.myTurn = false;
  guessNumpad.setEnabled(false);
  guessNumpad.reset();
  send({ type: 'GUESS', guess: val });
  renderGame();
}

function handleOpponentGuess(guess) {
  const { hits, blows } = calcHitBlow(G.mySecret, guess);
  G.opponentGuesses.push({ guess, hits, blows });
  send({ type: 'RESULT', guess, hits, blows });
  if (hits === 4) {
    showResult(false, null);
  } else {
    G.myTurn = true;
    setState('game');
  }
}

function handleResult(msg) {
  G.myGuesses.push({ guess: msg.guess, hits: msg.hits, blows: msg.blows });
  G.guessPending = false;
  if (msg.hits === 4) {
    send({ type: 'REVEAL', secret: G.mySecret });
    showResult(true, msg.guess);
  } else {
    G.myTurn = false;
    setState('game');
  }
}

// ─── Error handling ───────────────────────────────────────────────────────────
function handlePeerError(err) {
  if (G.role === 'guest') {
    if (G.connectTimeout) { clearTimeout(G.connectTimeout); G.connectTimeout = null; }
    let msg = '接続に失敗しました。再度お試しください。';
    if (err.type === 'peer-unavailable') msg = 'そのルームコードのルームが見つかりません。';
    if (err.type === 'network')          msg = 'ネットワークエラーが発生しました。';
    const errEl = document.getElementById('join-error');
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
    if (G.peer) { try { G.peer.destroy(); } catch (_) {} G.peer = null; }
    setState('joining');
    return;
  }
  setState('disconnected');
}

// ─── Reset ────────────────────────────────────────────────────────────────────
function resetGame() {
  if (G.connectTimeout) { clearTimeout(G.connectTimeout); G.connectTimeout = null; }
  if (G.conn) { try { G.conn.close();   } catch (_) {} }
  if (G.peer) { try { G.peer.destroy(); } catch (_) {} }

  Object.assign(G, {
    state: 'landing', peer: null, conn: null, role: null,
    roomCode: null, mySecret: null,
    myReadySent: false, opponentReady: false,
    myGuesses: [], opponentGuesses: [],
    myTurn: false, guessPending: false, won: false, connectTimeout: null,
  });

  setupNumpad.reset();
  setupNumpad.setEnabled(true);
  guessNumpad.reset();
  guessNumpad.setEnabled(false);

  document.getElementById('setup-waiting').classList.add('hidden');
  document.getElementById('input-room-id').value = '';
  document.getElementById('join-error').classList.add('hidden');

  setState('landing');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
let setupNumpad, guessNumpad;

window.addEventListener('load', () => {
  if (typeof Peer === 'undefined') {
    alert('PeerJSの読み込みに失敗しました。ページを再読み込みしてください。');
    return;
  }

  setupNumpad = createNumpad('setup', submitSecret);
  guessNumpad = createNumpad('game',  submitGuess);
  guessNumpad.setEnabled(false);

  // Landing
  document.getElementById('btn-create').addEventListener('click', () => createRoom());
  document.getElementById('btn-join').addEventListener('click',   () => setState('joining'));

  // Waiting — copy room code
  document.getElementById('btn-copy').addEventListener('click', () => {
    const text     = document.getElementById('room-code-display').textContent;
    const feedback = document.getElementById('copy-feedback');
    const show = () => {
      feedback.classList.remove('hidden');
      setTimeout(() => feedback.classList.add('hidden'), 2000);
    };
    navigator.clipboard.writeText(text).then(show).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      show();
    });
  });

  // Joining
  document.getElementById('btn-connect').addEventListener('click', () => {
    const val   = document.getElementById('input-room-id').value.trim().toUpperCase();
    const errEl = document.getElementById('join-error');
    if (!val) {
      errEl.textContent = 'ルームコードを入力してください';
      errEl.classList.remove('hidden');
      return;
    }
    errEl.classList.add('hidden');
    joinRoom(val);
  });
  document.getElementById('input-room-id').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-connect').click();
  });
  document.getElementById('btn-back-from-join').addEventListener('click', () => setState('landing'));

  // Result / Disconnected
  document.getElementById('btn-replay').addEventListener('click', resetGame);
  document.getElementById('btn-back-from-disconnect').addEventListener('click', resetGame);

  renderUI();
});
