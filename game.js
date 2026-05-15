'use strict';

// ─── Global state ───────────────────────────────────────────────────────────
const G = {
  state: 'landing',
  peer: null,
  conn: null,
  role: null,
  passphrase: null,
  mySecret: null,
  myReadySent: false,
  opponentReady: false,
  myGuesses: [],
  opponentGuesses: [],
  myTurn: false,
  guessPending: false,
  won: false,
  connectTimeout: null,
  hostWinPending: false,  // ホストが勝利確定、ゲストの最後の1手を待機中
  lastChanceTurn: false,  // ゲスト側: 今が最後の1手
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

// 合言葉 → PeerJS ID (英数字のみの安全な形式)
function toPeerId(passphrase) {
  let hex = '';
  for (const ch of passphrase) hex += ch.codePointAt(0).toString(16).padStart(4, '0');
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

  function handleKey(key, code) {
    if (!enabled) return;
    // e.key で '0'–'9'（数字行・テンキー共通）、fallback で e.code の Numpad0–9
    const digit = /^[0-9]$/.test(key) ? key
                : /^Numpad([0-9])$/.exec(code)?.[1] ?? null;
    if (digit !== null) {
      if (value.length < 4 && !value.includes(digit)) { value += digit; refresh(); }
    } else if (key === 'Backspace' || code === 'NumpadDecimal') {
      if (value.length > 0) { value = value.slice(0, -1); refresh(); }
    } else if (key === 'Enter' || code === 'NumpadEnter') {
      if (value.length === 4) onSubmit(value);
    }
  }

  refresh();
  return {
    reset()       { value = ''; refresh(); },
    getValue()    { return value; },
    setEnabled(v) { enabled = v; refresh(); },
    handleKey,
  };
}

// ─── State machine ───────────────────────────────────────────────────────────
function setState(newState) {
  G.state = newState;
  renderUI();
}

// ─── Render ──────────────────────────────────────────────────────────────────
const screens = [
  'landing', 'create-form', 'creating', 'waiting', 'joining',
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
  if (G.hostWinPending) {
    badge.textContent = '相手の最後のチャンス';
    badge.classList.remove('my-turn');
  } else if (G.lastChanceTurn) {
    badge.textContent = '最後のチャンス！';
    badge.classList.add('my-turn');
  } else if (G.myTurn) {
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

function showResult(outcome, opponentSecret) {
  // outcome: true=勝ち, false=負け, 'draw'=引き分け
  G.won = outcome === true;
  const isDraw = outcome === 'draw';
  const isWin  = outcome === true;
  document.getElementById('result-icon').textContent  = isDraw ? '🤝' : (isWin ? '🏆' : '😢');
  document.getElementById('result-title').textContent = isDraw ? '引き分け！' : (isWin ? 'あなたの勝ち！' : 'あなたの負け...');
  document.getElementById('result-my-secret').textContent  = G.mySecret || '—';
  document.getElementById('result-opp-secret').textContent = opponentSecret || '...';
  setState('result');
}

function revealOpponentSecret(secret) {
  document.getElementById('result-opp-secret').textContent = secret;
}

// ─── PeerJS Host ──────────────────────────────────────────────────────────────
function createRoom(passphrase) {
  G.passphrase = passphrase;
  G.role = 'host';
  setState('creating');

  if (G.peer) { try { G.peer.destroy(); } catch (_) {} G.peer = null; }
  G.peer = new Peer(toPeerId(passphrase), { debug: 0 });

  G.peer.on('open', () => {
    document.getElementById('passphrase-display').textContent = passphrase;
    setState('waiting');
  });

  G.peer.on('connection', conn => {
    G.conn = conn;
    setupConnectionHandlers();
  });

  G.peer.on('error', err => {
    if (err.type === 'unavailable-id') {
      // 合言葉がすでに使用中 → エラーを表示して再入力画面へ
      if (G.peer) { try { G.peer.destroy(); } catch (_) {} G.peer = null; }
      const errEl = document.getElementById('create-error');
      errEl.textContent = 'その合言葉はすでに使われています。別の合言葉を試してください。';
      errEl.classList.remove('hidden');
      setState('create-form');
    } else {
      handlePeerError(err);
    }
  });
}

// ─── PeerJS Guest ─────────────────────────────────────────────────────────────
function joinRoom(passphrase) {
  G.passphrase = passphrase;
  setState('connecting');
  G.role = 'guest';

  G.connectTimeout = setTimeout(() => {
    if (G.state !== 'connecting') return;
    const errEl = document.getElementById('join-error');
    errEl.textContent = '接続がタイムアウトしました。合言葉を確認して再度お試しください。';
    errEl.classList.remove('hidden');
    if (G.peer) { try { G.peer.destroy(); } catch (_) {} G.peer = null; }
    G.connectTimeout = null;
    setState('joining');
  }, 15000);

  G.peer = new Peer(undefined, { debug: 0 });

  G.peer.on('open', () => {
    G.conn = G.peer.connect(toPeerId(passphrase));
    setupConnectionHandlers();
  });

  G.peer.on('error', handlePeerError);
}

// ─── Connection handlers ──────────────────────────────────────────────────────
function setupConnectionHandlers() {
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

  if (G.hostWinPending) {
    // ゲストの最後の1手を評価（ホスト側で実行）
    G.hostWinPending = false;
    send({ type: 'RESULT', guess, hits, blows });
    send({ type: 'REVEAL', secret: G.mySecret });
    showResult(hits === 4 ? 'draw' : true, guess);
  } else if (hits === 4 && G.role === 'guest') {
    // ホストが正解 → ゲストに最後の1手を与える
    send({ type: 'RESULT', guess, hits, blows, lastChance: true });
    G.myTurn = true;
    G.lastChanceTurn = true;
    setState('game');
  } else if (hits === 4) {
    // ゲストが正解（通常の勝利）
    send({ type: 'RESULT', guess, hits, blows });
    showResult(false, null);
  } else {
    send({ type: 'RESULT', guess, hits, blows });
    G.myTurn = true;
    setState('game');
  }
}

function handleResult(msg) {
  G.myGuesses.push({ guess: msg.guess, hits: msg.hits, blows: msg.blows });
  G.guessPending = false;

  if (msg.lastChance) {
    // 自分の推測が正解だがゲストに最後の1手が与えられた（ホスト側）
    G.hostWinPending = true;
    G.myTurn = false;
    setState('game');
  } else if (msg.hits === 4) {
    send({ type: 'REVEAL', secret: G.mySecret });
    if (G.lastChanceTurn) {
      // 最後の1手で自分も正解 → 引き分け
      G.lastChanceTurn = false;
      showResult('draw', msg.guess);
    } else {
      showResult(true, msg.guess);
    }
  } else if (G.lastChanceTurn) {
    // 最後の1手で正解できず → 負け
    G.lastChanceTurn = false;
    showResult(false, null);
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
    if (err.type === 'peer-unavailable') msg = 'その合言葉のルームが見つかりません。';
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
    passphrase: null, mySecret: null,
    myReadySent: false, opponentReady: false,
    myGuesses: [], opponentGuesses: [],
    myTurn: false, guessPending: false, won: false, connectTimeout: null,
    hostWinPending: false, lastChanceTurn: false,
  });

  setupNumpad.reset();
  setupNumpad.setEnabled(true);
  guessNumpad.reset();
  guessNumpad.setEnabled(false);

  document.getElementById('setup-waiting').classList.add('hidden');
  document.getElementById('input-passphrase-create').value = '';
  document.getElementById('create-error').classList.add('hidden');
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

  // キーボード入力をアクティブなテンキーへルーティング
  document.addEventListener('keydown', e => {
    // テキスト入力中は無視
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (G.state === 'setup') setupNumpad.handleKey(e.key, e.code);
    if (G.state === 'game')  guessNumpad.handleKey(e.key, e.code);
  });

  // Landing
  document.getElementById('btn-create').addEventListener('click', () => setState('create-form'));
  document.getElementById('btn-join').addEventListener('click',   () => setState('joining'));

  // Create form
  document.getElementById('btn-start-create').addEventListener('click', () => {
    const val   = document.getElementById('input-passphrase-create').value.trim();
    const errEl = document.getElementById('create-error');
    if (!val) {
      errEl.textContent = '合言葉を入力してください';
      errEl.classList.remove('hidden');
      return;
    }
    errEl.classList.add('hidden');
    createRoom(val);
  });
  document.getElementById('input-passphrase-create').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-start-create').click();
  });
  document.getElementById('btn-back-from-create').addEventListener('click', () => setState('landing'));

  // Waiting — copy passphrase
  document.getElementById('btn-copy').addEventListener('click', () => {
    const text     = document.getElementById('passphrase-display').textContent;
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
    const val   = document.getElementById('input-room-id').value.trim();
    const errEl = document.getElementById('join-error');
    if (!val) {
      errEl.textContent = '合言葉を入力してください';
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
