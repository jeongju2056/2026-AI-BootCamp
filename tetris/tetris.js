'use strict';

/*
 * BLOCK STACKER — 테트리스형 블록 낙하 퍼즐
 *
 * 구조: [1] 상수 → [2] 상태 → [3] 순수 로직 → [4] 게임 동작 → [5] 렌더링 → [6] 입력 → [7] 루프
 * 배경음악은 bgm.js의 BGM 객체에 맡기고, 여기서는 상태가 바뀔 때 play/pause/stop만 부른다(setStatus).
 *
 * 핵심 원칙: "상태"와 "그리기"를 분리한다.
 *  - 로직은 숫자 2차원 배열(board)과 현재 블록 객체만 바꾼다. (DB 테이블을 UPDATE하는 쪽)
 *  - draw()는 매 프레임 그 상태를 읽어서 canvas에 그리기만 한다. (화면이 SELECT해서 보여 주는 쪽)
 *  그래서 점수 계산이나 줄 제거 버그는 화면과 상관없이 [3]·[4]만 보면 된다.
 */
(() => {
  // ===== [1] 상수 =====
  const COLS = 10;
  const ROWS = 20;
  const CELL = 30;            // 보드 한 칸 크기(논리 px). 실제 표시 크기는 CSS가 정한다
  const PREVIEW_SIZE = 120;   // HOLD / NEXT 미리보기 canvas 크기
  const PREVIEW_CELL = 24;
  const LOCK_DELAY = 500;     // 바닥에 닿은 뒤 고정까지 기다리는 시간(ms)
  const MAX_LOCK_RESETS = 15; // 바닥에서 이동·회전으로 고정을 미룰 수 있는 횟수
  const KICKS = [0, 1, -1, 2, -2];            // 회전이 막히면 좌우로 밀어 보는 칸 수(간단한 wall kick)
  const LINE_SCORES = [0, 100, 300, 500, 800]; // 한 번에 지운 줄 수 → 기본 점수
  const STORAGE_KEY = 'block-stacker.highScore';

  const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

  // 행렬 안의 숫자 = 색 번호. 보드에 고정될 때 이 숫자가 그대로 board에 기록된다
  const SHAPES = {
    I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
    O: [[2, 2], [2, 2]],
    T: [[0, 3, 0], [3, 3, 3], [0, 0, 0]],
    S: [[0, 4, 4], [4, 4, 0], [0, 0, 0]],
    Z: [[5, 5, 0], [0, 5, 5], [0, 0, 0]],
    J: [[6, 0, 0], [6, 6, 6], [0, 0, 0]],
    L: [[0, 0, 7], [7, 7, 7], [0, 0, 0]],
  };

  // 0번은 빈칸이라 비워 둔다. 머티리얼 색상표의 300 톤(어두운 배경에서 눈이 덜 피로한 밝기)
  const COLORS = [null, '#4dd0e1', '#ffd54f', '#ba68c8', '#81c784', '#e57373', '#64b5f6', '#ffb74d'];

  const BOARD_BG =
    getComputedStyle(document.documentElement).getPropertyValue('--md-sys-color-surface-container-lowest').trim() ||
    '#0f0d13';

  // bgm.js가 없거나 불러오지 못해도 게임은 돌아가게 빈 대역(stub)을 쓴다
  const music =
    typeof BGM !== 'undefined'
      ? BGM
      : {
          play() {}, pause() {}, stop() {}, setLevel() {},
          toggle: () => false, setTrack: () => false, nextTrack: () => null,
          enabled: false, tracks: [], track: null,
        };

  // ===== [2] 상태 =====
  // status: 'ready'(시작 전) | 'playing' | 'paused' | 'over'
  const state = {
    board: createBoard(),
    current: null,   // { type, matrix, x, y }
    next: null,
    hold: null,      // 홀드한 블록의 타입 문자열
    canHold: true,   // 블록 하나당 홀드는 한 번만
    bag: [],
    score: 0,
    level: 1,
    lines: 0,
    highScore: loadHighScore(),
    newRecord: false,
    status: 'ready',
    dropCounter: 0,  // 마지막 낙하 이후 흐른 시간(ms)
    lockTimer: 0,    // 바닥에 닿은 뒤 흐른 시간(ms)
    lockResets: 0,
  };

  // ===== [3] 순수 로직: 입력(배열·블록) → 결과. DOM을 건드리지 않는다 =====
  function createBoard() {
    return Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
  }

  function shuffle(arr) {
    // Fisher–Yates
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // 7-bag: 7종을 한 봉지에 넣고 섞어서 하나씩 꺼낸다 → 같은 블록이 오래 안 나오는 일을 막는다
  function takeFromBag() {
    if (state.bag.length === 0) state.bag = shuffle([...TYPES]);
    return state.bag.pop();
  }

  function createPiece(type) {
    const matrix = SHAPES[type].map((row) => [...row]);
    return {
      type,
      matrix,
      x: Math.floor((COLS - matrix[0].length) / 2),
      y: type === 'I' ? -1 : 0, // I는 첫 줄이 비어 있어 한 칸 올려서 보드 맨 위에 맞춘다
    };
  }

  // piece를 (dx, dy)만큼 옮기고 matrix 모양으로 바꿨을 때 벽·바닥·쌓인 블록과 겹치는지
  function collides(board, piece, dx = 0, dy = 0, matrix = piece.matrix) {
    for (let r = 0; r < matrix.length; r++) {
      for (let c = 0; c < matrix[r].length; c++) {
        if (!matrix[r][c]) continue;
        const x = piece.x + c + dx;
        const y = piece.y + r + dy;
        if (x < 0 || x >= COLS || y >= ROWS) return true;
        if (y >= 0 && board[y][x]) return true; // y < 0(보드 위 공간)은 비어 있다고 본다
      }
    }
    return false;
  }

  // 정사각 행렬 회전. 시계 방향 = 전치(transpose) 후 각 행 뒤집기
  function rotate(matrix, dir) {
    const n = matrix.length;
    return matrix.map((row, r) =>
      row.map((_, c) => (dir > 0 ? matrix[n - 1 - c][r] : matrix[c][n - 1 - r])),
    );
  }

  // 블록을 보드에 새긴다. 보드 위(y < 0)에 걸친 칸이 있으면 true(= 게임 오버)
  function merge(board, piece) {
    let lockedOut = false;
    piece.matrix.forEach((row, r) => {
      row.forEach((v, c) => {
        if (!v) return;
        const y = piece.y + r;
        if (y < 0) {
          lockedOut = true;
          return;
        }
        board[y][piece.x + c] = v;
      });
    });
    return lockedOut;
  }

  // 꽉 찬 줄을 지우고 위에 빈 줄을 넣는다. 지운 줄 수를 돌려준다
  function clearLines(board) {
    let cleared = 0;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (board[r].every((v) => v !== 0)) {
        board.splice(r, 1);
        board.unshift(new Array(COLS).fill(0));
        cleared++;
        r++; // 위 줄이 한 칸 내려왔으니 같은 r을 다시 검사
      }
    }
    return cleared;
  }

  // 지금 위치에서 바닥까지 몇 칸 떨어질 수 있는지(고스트·하드 드롭에 사용)
  function dropDistance(board, piece) {
    let d = 0;
    while (!collides(board, piece, 0, d + 1)) d++;
    return d;
  }

  function dropInterval(level) {
    return Math.max(100, 1000 - (level - 1) * 75);
  }

  function lineScore(cleared, level) {
    return LINE_SCORES[cleared] * level;
  }

  // ===== [4] 게임 동작: 상태를 바꾸는 함수들 =====

  // 게임 상태 전이는 반드시 여기를 거친다. 화면(다이얼로그·아이콘)과 음악이 상태와 어긋나지 않게 한 곳에서 맞춘다
  //   ready ──시작──▶ playing ◀──재개── paused
  //                     │ └──일시정지──▶ ┘
  //                     └──막힘──▶ over ──다시 시작──▶ playing
  function setStatus(next) {
    state.status = next;
    if (next === 'playing') {
      hideOverlay();
      music.play();
    } else {
      showOverlay();
      if (next === 'paused') music.pause();
      else music.stop();
    }
    syncControls();
  }

  function startGame() {
    state.board = createBoard();
    state.bag = [];
    state.hold = null;
    state.canHold = true;
    state.score = 0;
    state.level = 1;
    state.lines = 0;
    state.newRecord = false;
    state.next = createPiece(takeFromBag());
    music.setLevel(1);
    setStatus('playing');
    spawn();
  }

  function resetTimers() {
    state.dropCounter = 0;
    state.lockTimer = 0;
    state.lockResets = 0;
  }

  // 새 블록 등장. piece를 주면 그 블록(홀드 교체), 없으면 NEXT에서 꺼낸다
  function spawn(piece) {
    if (piece) {
      state.current = piece;
    } else {
      state.current = state.next;
      state.next = createPiece(takeFromBag());
    }
    resetTimers();
    if (collides(state.board, state.current)) gameOver(); // 나올 자리부터 막혔다
  }

  // 바닥에 닿은 채로 움직였으면 고정 대기를 다시 센다(무한히 미루지 못하게 횟수 제한)
  function afterMove() {
    if (collides(state.board, state.current, 0, 1) && state.lockResets < MAX_LOCK_RESETS) {
      state.lockTimer = 0;
      state.lockResets++;
    }
  }

  function move(dx) {
    if (!collides(state.board, state.current, dx, 0)) {
      state.current.x += dx;
      afterMove();
    }
  }

  function rotatePiece(dir) {
    const p = state.current;
    if (p.type === 'O') return;
    const rotated = rotate(p.matrix, dir);
    for (const kick of KICKS) {
      if (!collides(state.board, p, kick, 0, rotated)) {
        p.matrix = rotated;
        p.x += kick;
        afterMove();
        return;
      }
    }
    // 모든 위치가 막히면 회전하지 않는다
  }

  function softDrop() {
    if (!collides(state.board, state.current, 0, 1)) {
      state.current.y++;
      state.score += 1;
      state.dropCounter = 0;
      state.lockResets = 0;
    }
  }

  function hardDrop() {
    const d = dropDistance(state.board, state.current);
    state.current.y += d;
    state.score += d * 2;
    lockPiece();
  }

  function lockPiece() {
    if (merge(state.board, state.current)) {
      gameOver();
      return;
    }
    const cleared = clearLines(state.board);
    if (cleared > 0) {
      state.score += lineScore(cleared, state.level); // 레벨이 오르기 전 레벨로 계산
      state.lines += cleared;
      const level = Math.floor(state.lines / 10) + 1;
      if (level !== state.level) {
        state.level = level;
        music.setLevel(level); // 음악도 빨라진다
        showSnackbar(`레벨 ${level}`);
      }
    }
    state.canHold = true;
    spawn();
  }

  function holdPiece() {
    if (!state.canHold) return;
    const currentType = state.current.type;
    if (state.hold) spawn(createPiece(state.hold));
    else spawn();
    state.hold = currentType;
    state.canHold = false;
  }

  function pause() {
    if (state.status === 'playing') setStatus('paused');
  }

  function resume() {
    if (state.status === 'paused') setStatus('playing');
  }

  function toggleMusic() {
    const on = music.toggle();
    syncControls();
    showSnackbar(on ? '배경음악 켬' : '배경음악 끔');
  }

  // 곡 바꾸기는 시작 전·일시정지 중에만 (게임 중에 바꾸면 손이 바쁠 때 실수로 눌리기 쉽다)
  function canPickTrack() {
    return state.status === 'paused' || state.status === 'ready';
  }

  function selectTrack(id) {
    if (!canPickTrack() || !music.setTrack(id)) return;
    syncTracks();
    showSnackbar(`배경음악: ${music.track.title}`);
  }

  function cycleTrack() {
    if (!canPickTrack() || music.tracks.length < 2) return;
    selectTrack(music.tracks[(music.tracks.findIndex((t) => t.id === music.track.id) + 1) % music.tracks.length].id);
  }

  // 버튼 하나로 상황에 맞게: 시작 전·게임 오버 → 시작, 일시정지 → 재개, 진행 중 → 일시정지
  function primaryAction() {
    if (state.status === 'ready' || state.status === 'over') startGame();
    else if (state.status === 'paused') resume();
    else pause();
  }

  function gameOver() {
    if (state.score > state.highScore) {
      state.highScore = state.score;
      state.newRecord = true;
      saveHighScore(state.score);
    }
    setStatus('over');
  }

  // 매 프레임 호출. delta = 지난 프레임 이후 흐른 시간(ms)
  function update(delta) {
    if (state.status !== 'playing') return;
    const p = state.current;

    if (collides(state.board, p, 0, 1)) {
      // 바닥(또는 쌓인 블록)에 닿음 → 잠깐 기다렸다가 고정
      state.lockTimer += delta;
      if (state.lockTimer >= LOCK_DELAY) lockPiece();
      return;
    }

    state.lockTimer = 0;
    state.dropCounter += delta;
    if (state.dropCounter >= dropInterval(state.level)) {
      state.dropCounter = 0;
      p.y++;
      state.lockResets = 0; // 더 낮은 줄로 내려왔으니 미루기 횟수 초기화
    }
  }

  // ===== 저장: 최고 점수 (사생활 모드 등에서 localStorage가 막혀도 게임은 돌아가야 한다) =====
  function loadHighScore() {
    try {
      return Number(localStorage.getItem(STORAGE_KEY)) || 0;
    } catch {
      return 0;
    }
  }

  function saveHighScore(value) {
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      /* 저장할 수 없는 환경이면 이번 세션에서만 기억한다 */
    }
  }

  // ===== [5] 렌더링: 상태를 읽어서 그리기만 한다 =====
  const boardCanvas = document.getElementById('board');
  const holdCanvas = document.getElementById('hold');
  const nextCanvas = document.getElementById('next');
  const boardCtx = setupCanvas(boardCanvas, COLS * CELL, ROWS * CELL);
  const holdCtx = setupCanvas(holdCanvas, PREVIEW_SIZE, PREVIEW_SIZE);
  const nextCtx = setupCanvas(nextCanvas, PREVIEW_SIZE, PREVIEW_SIZE);

  const hud = {
    score: document.getElementById('score'),
    best: document.getElementById('best'),
    level: document.getElementById('level'),
    lines: document.getElementById('lines'),
  };

  const overlay = {
    root: document.getElementById('overlay'),
    title: document.getElementById('overlay-title'),
    text: document.getElementById('overlay-text'),
    button: document.getElementById('overlay-btn'),
    home: document.getElementById('overlay-home'),
    picker: document.getElementById('track-picker'),
    trackList: document.getElementById('track-list'),
    trackDesc: document.getElementById('track-desc'),
  };

  const controls = {
    bgmButton: document.getElementById('bgm-btn'),
    bgmIcon: document.getElementById('bgm-icon'),
    pauseButton: document.getElementById('pause-btn'),
    pauseIcon: document.getElementById('pause-icon'),
    touchPauseIcon: document.getElementById('touch-pause-icon'),
  };

  const snackbar = document.getElementById('snackbar');
  let snackbarTimer = null;

  // 고해상도 화면(레티나)에서 흐리지 않게 실제 픽셀 수를 devicePixelRatio배로 잡는다
  function setupCanvas(canvas, width, height) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 이후로는 논리 px 단위로 그린다
    return ctx;
  }

  // 모서리가 둥근 사각형 경로. roundRect가 없는 옛 브라우저에서는 그냥 사각형
  function cellPath(ctx, x, y, w, h, radius) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, radius);
    else ctx.rect(x, y, w, h);
  }

  // 머티리얼 스타일: 그라데이션 없이 평평한 색 + 둥근 모서리
  function drawCell(ctx, px, py, size, colorIndex, alpha = 1) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = COLORS[colorIndex];
    cellPath(ctx, px + 1.5, py + 1.5, size - 3, size - 3, size * 0.16);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawGhostCell(ctx, px, py, size, colorIndex) {
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = COLORS[colorIndex];
    cellPath(ctx, px + 2, py + 2, size - 4, size - 4, size * 0.16);
    ctx.fill();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = COLORS[colorIndex];
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function forEachCell(piece, fn) {
    piece.matrix.forEach((row, r) => {
      row.forEach((v, c) => {
        if (v) fn(piece.x + c, piece.y + r, v);
      });
    });
  }

  function drawBoard() {
    const ctx = boardCtx;
    const w = COLS * CELL;
    const h = ROWS * CELL;

    ctx.fillStyle = BOARD_BG;
    ctx.fillRect(0, 0, w, h);

    // 격자
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < COLS; x++) {
      ctx.moveTo(x * CELL + 0.5, 0);
      ctx.lineTo(x * CELL + 0.5, h);
    }
    for (let y = 1; y < ROWS; y++) {
      ctx.moveTo(0, y * CELL + 0.5);
      ctx.lineTo(w, y * CELL + 0.5);
    }
    ctx.stroke();

    // 쌓인 블록
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (state.board[y][x]) drawCell(ctx, x * CELL, y * CELL, CELL, state.board[y][x]);
      }
    }

    const p = state.current;
    if (!p) return;

    // 고스트(떨어질 자리) → 현재 블록 순서로 그려야 현재 블록이 위에 보인다
    if (state.status === 'playing' || state.status === 'paused') {
      const ghostY = p.y + dropDistance(state.board, p);
      forEachCell({ ...p, y: ghostY }, (x, y, v) => {
        if (y >= 0) drawGhostCell(ctx, x * CELL, y * CELL, CELL, v);
      });
    }
    forEachCell(p, (x, y, v) => {
      if (y >= 0) drawCell(ctx, x * CELL, y * CELL, CELL, v);
    });
  }

  // 미리보기: 블록의 실제 칸만 골라 가운데 정렬
  function drawPreview(ctx, type, dimmed) {
    ctx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
    if (!type) return;

    const m = SHAPES[type];
    const cells = [];
    m.forEach((row, r) => row.forEach((v, c) => { if (v) cells.push([r, c, v]); }));

    const rows = cells.map(([r]) => r);
    const cols = cells.map(([, c]) => c);
    const minR = Math.min(...rows);
    const minC = Math.min(...cols);
    const width = (Math.max(...cols) - minC + 1) * PREVIEW_CELL;
    const height = (Math.max(...rows) - minR + 1) * PREVIEW_CELL;
    const ox = (PREVIEW_SIZE - width) / 2;
    const oy = (PREVIEW_SIZE - height) / 2;

    cells.forEach(([r, c, v]) => {
      drawCell(ctx, ox + (c - minC) * PREVIEW_CELL, oy + (r - minR) * PREVIEW_CELL, PREVIEW_CELL, v, dimmed ? 0.35 : 1);
    });
  }

  function setText(el, value) {
    const text = String(value);
    if (el.textContent !== text) el.textContent = text; // 바뀔 때만 DOM을 건드린다
  }

  function drawHud() {
    setText(hud.score, state.score.toLocaleString('ko-KR'));
    setText(hud.best, Math.max(state.highScore, state.score).toLocaleString('ko-KR'));
    setText(hud.level, state.level);
    setText(hud.lines, state.lines);
  }

  function draw() {
    drawBoard();
    drawPreview(holdCtx, state.hold, !state.canHold); // 이미 홀드를 썼으면 흐리게
    drawPreview(nextCtx, state.next && state.next.type, false);
    drawHud();
  }

  function showOverlay() {
    const score = state.score.toLocaleString('ko-KR');
    const content = {
      ready: ['Block Stacker', '블록을 쌓아 가로줄을 채우면 사라집니다.\nEnter 또는 아래 버튼으로 시작하세요.', '게임 시작'],
      paused: ['일시정지', 'P · Esc · Enter로 이어서 할 수 있습니다.', '계속하기'],
      over: [
        state.newRecord ? '새 최고 기록!' : '게임 오버',
        `점수 ${score}\n레벨 ${state.level} · ${state.lines}줄`,
        '다시 시작',
      ],
    }[state.status];
    [overlay.title.textContent, overlay.text.textContent, overlay.button.textContent] = content;
    overlay.picker.hidden = !(canPickTrack() && music.tracks.length > 1);
    overlay.home.hidden = state.status === 'ready';
    syncTracks();
    overlay.root.hidden = false;
  }

  // 곡 선택 버튼: bgm.js의 곡 목록으로 만든다 → 곡을 추가해도 HTML은 고칠 필요가 없다
  const CHECK_ICON = '<svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>';
  const trackButtons = music.tracks.map((track) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'segment';
    button.setAttribute('role', 'radio');
    button.dataset.track = track.id;
    button.innerHTML = CHECK_ICON; // 고정 문자열만 innerHTML로 넣는다
    const label = document.createElement('span');
    label.textContent = track.title;
    button.appendChild(label);
    overlay.trackList.appendChild(button);
    return button;
  });

  function syncTracks() {
    const current = music.track;
    if (!current) return;
    trackButtons.forEach((button) => button.setAttribute('aria-checked', String(button.dataset.track === current.id)));
    overlay.trackDesc.textContent = `${current.description}${state.status === 'paused' ? ' · 바꾸면 처음부터 재생' : ''} · B 키로도 바꿀 수 있습니다`;
  }

  function hideOverlay() {
    overlay.root.hidden = true;
  }

  // 앱 바·터치 버튼의 아이콘과 접근성 라벨을 현재 상태에 맞춘다
  function syncControls() {
    const playing = state.status === 'playing';
    const pauseIcon = playing ? '#i-pause' : '#i-play';
    controls.pauseIcon.setAttribute('href', pauseIcon);
    controls.touchPauseIcon.setAttribute('href', pauseIcon);
    controls.pauseButton.setAttribute('aria-label', playing ? '일시정지' : state.status === 'paused' ? '계속하기' : '게임 시작');

    const on = music.enabled;
    controls.bgmIcon.setAttribute('href', on ? '#i-music' : '#i-music-off');
    controls.bgmButton.setAttribute('aria-pressed', String(on));
    controls.bgmButton.setAttribute('aria-label', on ? '배경음악 끄기' : '배경음악 켜기');
  }

  function showSnackbar(message) {
    snackbar.textContent = message;
    snackbar.classList.add('show');
    clearTimeout(snackbarTimer);
    snackbarTimer = setTimeout(() => snackbar.classList.remove('show'), 1800);
  }

  // ===== [6] 입력: 키보드·터치 모두 같은 액션 함수를 부른다 =====
  const ACTIONS = {
    left: () => move(-1),
    right: () => move(1),
    down: softDrop,
    rotateCW: () => rotatePiece(1),
    rotateCCW: () => rotatePiece(-1),
    hardDrop,
    hold: holdPiece,
  };

  // 누르고 있으면 반복되는 액션(회전·하드 드롭·홀드는 한 번만)
  const REPEATABLE = new Set(['left', 'right', 'down']);

  const KEY_MAP = {
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowDown: 'down',
    ArrowUp: 'rotateCW',
    KeyX: 'rotateCW',
    KeyZ: 'rotateCCW',
    Space: 'hardDrop',
    KeyC: 'hold',
    ShiftLeft: 'hold',
    ShiftRight: 'hold',
  };

  function runAction(name) {
    if (state.status !== 'playing') return;
    const action = ACTIONS[name];
    if (action) action();
  }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault(); // 포커스된 버튼이 한 번 더 눌리지 않게
      if (e.repeat) return;
      if (state.status !== 'playing') primaryAction(); // 진행 중 Enter는 무시
      return;
    }
    if (e.code === 'KeyP' || e.code === 'Escape') {
      if (e.repeat) return;
      if (state.status === 'playing') pause();
      else resume();
      return;
    }
    if (e.code === 'KeyM') {
      if (!e.repeat) toggleMusic();
      return;
    }
    if (e.code === 'KeyB') {
      if (!e.repeat) cycleTrack();
      return;
    }

    const name = KEY_MAP[e.code];
    if (!name) return;
    e.preventDefault(); // 방향키·Space로 페이지가 스크롤되지 않게
    if (e.repeat && !REPEATABLE.has(name)) return; // 키를 누르고 있을 때의 자동 반복은 이동·소프트 드롭만
    runAction(name);
  });

  // 마우스로 누른 버튼은 바로 포커스를 뺀다. 포커스가 남아 있으면 Space(하드 드롭)가 그 버튼을 다시 누른다
  function clickThenBlur(button, handler) {
    button.addEventListener('click', () => {
      handler();
      button.blur();
    });
  }

  clickThenBlur(overlay.button, primaryAction);
  clickThenBlur(controls.pauseButton, primaryAction);
  clickThenBlur(controls.bgmButton, toggleMusic);
  trackButtons.forEach((button) => clickThenBlur(button, () => selectTrack(button.dataset.track)));

  // 보드 위 스와이프(휴대폰): 탭 = 회전, 좌우로 밀기 = 이동, 아래로 밀기 = 소프트 드롭,
  // 아래로 빠르게 튕기기 = 하드 드롭, 위로 튕기기 = 홀드
  // 손가락이 "보드 한 칸 너비"만큼 움직일 때마다 한 칸 이동한다 → 화면 크기와 상관없이 같은 느낌
  const TAP_MAX_MS = 250;
  const TAP_MAX_PX = 10;
  const FLICK_SPEED = 0.8; // px/ms. 이보다 빠르게 튕기면 하드 드롭·홀드
  let gesture = null;

  boardCanvas.addEventListener('pointerdown', (e) => {
    if (state.status !== 'playing') return;
    e.preventDefault();
    if (boardCanvas.setPointerCapture) boardCanvas.setPointerCapture(e.pointerId); // 손가락이 보드 밖으로 나가도 계속 받는다
    gesture = {
      id: e.pointerId,
      cell: boardCanvas.getBoundingClientRect().width / COLS,
      startX: e.clientX,
      startY: e.clientY,
      anchorX: e.clientX, // 마지막으로 한 칸 움직인 기준점
      anchorY: e.clientY,
      startTime: e.timeStamp,
      axis: null,         // 처음 움직인 방향으로 고정('x' | 'y') → 아래로 밀 때 옆으로 새지 않게
      moved: false,
    };
  });

  boardCanvas.addEventListener('pointermove', (e) => {
    const g = gesture;
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.anchorX;
    const dy = e.clientY - g.anchorY;
    if (!g.axis) {
      if (Math.abs(dx) >= g.cell * 0.6) g.axis = 'x';
      else if (dy >= g.cell * 0.6) g.axis = 'y';
      else return;
    }
    if (g.axis === 'x') {
      while (e.clientX - g.anchorX >= g.cell) { runAction('right'); g.anchorX += g.cell; g.moved = true; }
      while (g.anchorX - e.clientX >= g.cell) { runAction('left'); g.anchorX -= g.cell; g.moved = true; }
    } else {
      while (e.clientY - g.anchorY >= g.cell) { runAction('down'); g.anchorY += g.cell; g.moved = true; }
    }
  });

  function endGesture(e) {
    const g = gesture;
    if (!g || e.pointerId !== g.id) return;
    gesture = null;
    if (e.type === 'pointercancel') return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const dt = Math.max(1, e.timeStamp - g.startTime);
    if (!g.moved && Math.abs(dx) < TAP_MAX_PX && Math.abs(dy) < TAP_MAX_PX && dt < TAP_MAX_MS) runAction('rotateCW');
    else if (g.axis !== 'x' && dy > g.cell * 2 && dy / dt > FLICK_SPEED) runAction('hardDrop');
    else if (g.axis !== 'x' && -dy > g.cell * 2 && -dy / dt > FLICK_SPEED) runAction('hold');
  }
  boardCanvas.addEventListener('pointerup', endGesture);
  boardCanvas.addEventListener('pointercancel', endGesture);

  // 터치 버튼: 누르는 순간 1회 실행, 이동·소프트 드롭은 누르고 있으면 반복
  document.querySelectorAll('.touch [data-action]').forEach((btn) => {
    const name = btn.dataset.action;
    let delayTimer = null;
    let repeatTimer = null;

    const stop = () => {
      clearTimeout(delayTimer);
      clearInterval(repeatTimer);
      delayTimer = null;
      repeatTimer = null;
    };

    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault(); // 포커스 이동·더블탭 확대 방지
      if (name === 'primary') {
        primaryAction();
        return;
      }
      runAction(name);
      if (REPEATABLE.has(name)) {
        stop();
        delayTimer = setTimeout(() => {
          repeatTimer = setInterval(() => runAction(name), 50);
        }, 170);
      }
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((type) => btn.addEventListener(type, stop));
  });

  // 다른 탭으로 가면 자동 일시정지
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });

  // ===== [7] 게임 루프 =====
  // requestAnimationFrame: 브라우저가 화면을 다시 그릴 때마다(보통 초당 60번) 호출해 준다.
  // 중력은 프레임 수가 아니라 실제 흐른 시간(delta)으로 계산해서 모니터 주사율과 상관없이 같은 속도가 된다.
  let lastTime = 0;

  function frame(time) {
    const delta = Math.min(time - lastTime, 100); // 탭 전환 등으로 시간이 크게 튀면 잘라 낸다
    lastTime = time;
    update(delta);
    draw();
    requestAnimationFrame(frame);
  }

  // 랜딩 페이지의 "플레이"(game.html?autostart)로 들어오면 바로 시작한다.
  // 브라우저는 페이지를 연 직후에는 소리를 막으므로, 음악은 첫 키 입력·터치 순간에 시작된다(bgm.js의 unlock)
  const autostart = new URLSearchParams(window.location.search).has('autostart');
  if (autostart) {
    startGame();
    if (music.enabled) showSnackbar('키를 누르거나 화면을 터치하면 음악이 시작됩니다');
  } else {
    setStatus('ready');
  }
  requestAnimationFrame((time) => {
    lastTime = time;
    frame(time);
  });
})();
