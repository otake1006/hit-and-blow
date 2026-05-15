'use strict';

// ─── Global state ───────────────────────────────────────────────────────────
const G = {
  state: 'landing',
  peer: null,
  conn: null,
  role: null,           // 'host' | 'guest'
  mySecret: null,
  myReadySent: false,
  opponentReady: false,
  myGuesses: [],        // [{guess, hits, blows}]
  opponentGuesses: [],  // [{guess, hits, blows}]
  myTurn: false,
  guessPending: false,  // prevents double-submit
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

function send(msg) {
  if (G.conn && G.conn.open) G.conn.send(msg);
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

  const guessBtn = document.getElementById('btn-guess');
  guessBtn.disabled = !G.myTurn || G.guessPending;

  renderGuessTable('my-guess-body', 'my-guess-empty', G.myGuesses);
  renderGuessTable('opp-guess-body', 'opp-guess-empty', G.opponentGuesses);
}

function renderGuessTable(bodyId, emptyId, list) {
  const tbody = document.getElementById(bodyId);
  const empty = document.getElementById(emptyId);
  tbody.innerHTML = '';

  if (list.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  list.forEach((entry, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${entry.guess}</td>
      <td class="${entry.hits > 0 ? 'hit-val' : 'zero-val'}">${entry.hits}</td>
      <td class="${entry.blows > 0 ? 'blow-val' : 'zero-val'}">${entry.blows}</td>
    `;
    tbody.appendChild(tr);
  });
}

function showResult(won) {
  setState(won ? 'won' : 'lost');
  document.getElementById('result-icon').textContent = won ? '🏆' : '😢';
  document.getElementById('result-title').textContent = won ? 'あなたの勝ち！' : 'あなたの負け...';
  document.getElementById('result-msg').textContent =
    won
      ? `相手の数字 [${G.opponentGuesses.length > 0 ? '?' : '?'}] を当てました！`
      : `相手があなたの数字 [${G.mySecret}] を当てました`;

  // Override the screen name to show result screen
  screens.forEach(id => {
    const el = document.getElementById('screen-' + id);
    if (el) el.classList.add('hidden');
  });
  document.getElementById('screen-result').classList.remove('hidden');
}

// ─── PeerJS Host ──────────────────────────────────────────────────────────────
function createRoom() {
  setState('creating');
  G.role = 'host';
  G.peer = new Peer(undefined, { debug: 0 });

  G.peer.on('open', (id) => {
    document.getElementById('room-id-display').textContent = id;
    setState('waiting');
  });

  G.peer.on('connection', (conn) => {
    G.conn = conn;
    setupConnectionHandlers();
    setState('setup');
  });

  G.peer.on('error', handlePeerError);
}

// ─── PeerJS Guest ─────────────────────────────────────────────────────────────
function joinRoom(roomId) {
  setState('connecting');
  G.role = 'guest';
  G.peer = new Peer(undefined, { debug: 0 });

  G.peer.on('open', () => {
    G.conn = G.peer.connect(roomId, { reliable: true });
    setupConnectionHandlers();
  });

  G.peer.on('error', handlePeerError);
}

// ─── Connection handlers ──────────────────────────────────────────────────────
function setupConnectionHandlers() {
  G.conn.on('open', () => {
    if (G.role === 'guest') setState('setup');
  });

  G.conn.on('data', (msg) => {
    switch (msg.type) {
      case 'READY':  handleOpponentReady();          break;
      case 'GUESS':  handleOpponentGuess(msg.guess); break;
      case 'RESULT': handleResult(msg);              break;
      case 'WIN':    showResult(false);              break;
    }
  });

  G.conn.on('close', () => {
    if (G.state !== 'won' && G.state !== 'lost') setState('disconnected');
  });
  G.conn.on('error', () => {
    if (G.state !== 'won' && G.state !== 'lost') setState('disconnected');
  });
}

// ─── Setup phase ─────────────────────────────────────────────────────────────
function submitSecret() {
  const val = document.getElementById('input-secret').value.trim();
  const errEl = document.getElementById('setup-error');

  if (!isValidNumber(val)) {
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');
  G.mySecret = val;
  G.myReadySent = true;

  document.getElementById('btn-set-secret').disabled = true;
  document.getElementById('input-secret').disabled = true;
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
function submitGuess() {
  if (!G.myTurn || G.guessPending) return;
  const val = document.getElementById('input-guess').value.trim();
  const errEl = document.getElementById('guess-error');

  if (!isValidNumber(val)) {
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');

  G.guessPending = true;
  G.myTurn = false;
  renderGame();

  send({ type: 'GUESS', guess: val });
  document.getElementById('input-guess').value = '';
}

function handleOpponentGuess(guess) {
  const { hits, blows } = calcHitBlow(G.mySecret, guess);
  G.opponentGuesses.push({ guess, hits, blows });

  send({ type: 'RESULT', guess, hits, blows });

  if (hits === 4) {
    send({ type: 'WIN' });
    showResult(false);
  } else {
    G.myTurn = true;
    setState('game');
  }
}

function handleResult(msg) {
  G.myGuesses.push({ guess: msg.guess, hits: msg.hits, blows: msg.blows });
  G.guessPending = false;

  if (msg.hits === 4) {
    showResult(true);
  } else {
    G.myTurn = false;
    setState('game');
  }
}

// ─── Error handling ───────────────────────────────────────────────────────────
function handlePeerError(err) {
  let msg = '接続に失敗しました。再度お試しください。';
  if (err.type === 'peer-unavailable') msg = '指定されたルームIDが見つかりません。';
  if (err.type === 'network')          msg = 'ネットワークエラーが発生しました。';

  const errEl = document.getElementById('join-error');
  if (errEl && G.state === 'connecting') {
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
    setState('joining');
  } else {
    setState('disconnected');
  }
}

// ─── Reset ────────────────────────────────────────────────────────────────────
function resetGame() {
  if (G.conn) { try { G.conn.close(); } catch(_) {} }
  if (G.peer) { try { G.peer.destroy(); } catch(_) {} }
  Object.assign(G, {
    state: 'landing', peer: null, conn: null, role: null,
    mySecret: null, myReadySent: false, opponentReady: false,
    myGuesses: [], opponentGuesses: [], myTurn: false, guessPending: false,
  });
  // Reset form fields
  document.getElementById('input-secret').value = '';
  document.getElementById('input-secret').disabled = false;
  document.getElementById('btn-set-secret').disabled = false;
  document.getElementById('setup-waiting').classList.add('hidden');
  document.getElementById('input-guess').value = '';
  document.getElementById('input-room-id').value = '';
  document.getElementById('join-error').classList.add('hidden');
  document.getElementById('join-error').textContent = 'ルームIDを入力してください';
  setState('landing');
}

// ─── Event listeners ──────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  if (typeof Peer === 'undefined') {
    alert('PeerJSの読み込みに失敗しました。ページを再読み込みしてください。');
    return;
  }

  // Landing
  document.getElementById('btn-create').addEventListener('click', createRoom);
  document.getElementById('btn-join').addEventListener('click', () => setState('joining'));

  // Joining
  document.getElementById('btn-connect').addEventListener('click', () => {
    const id = document.getElementById('input-room-id').value.trim();
    const errEl = document.getElementById('join-error');
    if (!id) {
      errEl.textContent = 'ルームIDを入力してください';
      errEl.classList.remove('hidden');
      return;
    }
    errEl.classList.add('hidden');
    joinRoom(id);
  });

  document.getElementById('input-room-id').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-connect').click();
  });

  document.getElementById('btn-back-from-join').addEventListener('click', () => setState('landing'));

  // Waiting — copy room ID
  document.getElementById('btn-copy').addEventListener('click', () => {
    const id = document.getElementById('room-id-display').textContent;
    const feedback = document.getElementById('copy-feedback');
    navigator.clipboard.writeText(id).then(() => {
      feedback.classList.remove('hidden');
      setTimeout(() => feedback.classList.add('hidden'), 2000);
    }).catch(() => {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = id;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      feedback.classList.remove('hidden');
      setTimeout(() => feedback.classList.add('hidden'), 2000);
    });
  });

  // Setup
  document.getElementById('btn-set-secret').addEventListener('click', submitSecret);
  document.getElementById('input-secret').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitSecret();
  });
  document.getElementById('input-secret').addEventListener('input', () => {
    document.getElementById('setup-error').classList.add('hidden');
  });

  // Game
  document.getElementById('btn-guess').addEventListener('click', submitGuess);
  document.getElementById('input-guess').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitGuess();
  });
  document.getElementById('input-guess').addEventListener('input', () => {
    document.getElementById('guess-error').classList.add('hidden');
  });

  // Result / Disconnected
  document.getElementById('btn-replay').addEventListener('click', resetGame);
  document.getElementById('btn-back-from-disconnect').addEventListener('click', resetGame);

  renderUI();
});
