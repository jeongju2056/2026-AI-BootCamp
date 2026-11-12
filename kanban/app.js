// 칸반 보드 화면: 로그인 → 상태(cards 배열) → 화면 그리기 → 서버(Supabase) 저장
// 순수 로직(추가·삭제·이동·비교·위치 계산)은 kanban.js(window.Kanban), 서버 저장은 store.js(window.KanbanStore)
(function () {
  'use strict';

  const {
    STATUSES, columnCards, addCard, removeCard, moveCard, diffCards, dropIndex, autoScrollDelta,
  } = window.Kanban;

  const MSG = {
    unavailable: '로그인 서비스를 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.',
    needEmailPassword: '이메일과 비밀번호를 입력해 주세요.',
    checkEmail: '확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 로그인해 주세요.',
    weakPassword: '비밀번호는 6자 이상이어야 합니다.',
    invalidCredentials: '이메일 또는 비밀번호가 맞지 않습니다.',
    notConfirmed: '이메일 확인이 필요합니다. 받은 확인 메일의 링크를 눌러 주세요.',
    signInFailed: '로그인하지 못했습니다: ',
    signUpFailed: '가입하지 못했습니다: ',
    oauthFailed: '로그인을 시작하지 못했습니다: ',
    loadFailed: '카드를 불러오지 못했습니다. 잠시 뒤 새로고침해 주세요.',
    saveFailed: '저장하지 못했습니다. 서버의 내용으로 다시 불러왔습니다.',
  };

  // ===== 상태 =====

  let cards = [];
  let client = null;        // supabase-js client
  let store = null;         // store.js 저장소
  let currentUserId = null; // 로그인한 사용자 id(없으면 null)
  let saving = Promise.resolve(); // 저장 요청을 순서대로 처리하기 위한 줄

  // ===== 화면 요소 =====

  const board = document.querySelector('.board');
  const loginView = document.querySelector('.login');
  const loginMessage = document.querySelector('.login-message');
  const emailForm = document.querySelector('.email-form');
  const userMenu = document.querySelector('.user-menu');
  const userEmail = document.querySelector('.user-email');
  const snackbar = document.querySelector('.snackbar');
  let snackbarTimer = 0;

  // 로그인 뒤 돌아올 주소: 지금 페이지(배포 주소 또는 http://localhost:5173/)
  const redirectUrl = () => window.location.origin + window.location.pathname;

  function showLoginMessage(text, kind = 'info') {
    loginMessage.textContent = text;
    loginMessage.dataset.kind = kind;
    loginMessage.hidden = !text;
  }

  function showSnackbar(text) {
    snackbar.textContent = text;
    snackbar.hidden = false;
    clearTimeout(snackbarTimer);
    snackbarTimer = setTimeout(() => { snackbar.hidden = true; }, 5000);
  }

  function setLoginBusy(busy) {
    loginView.querySelectorAll('button').forEach((b) => { b.disabled = busy; });
  }

  // 로그인 상태에 맞게 화면을 바꾸고, 사용자가 바뀌었으면 그 사람의 카드를 불러온다
  // (onAuthStateChange가 같은 세션을 여러 번 알려도 다시 불러오지 않게 사용자 id로 비교한다)
  function applySession(session) {
    const user = session ? session.user : null;
    loginView.hidden = Boolean(user);
    board.hidden = !user;
    userMenu.hidden = !user;
    userEmail.textContent = user ? user.email || '' : '';
    const uid = user ? user.id : null;
    if (uid === currentUserId) return;
    currentUserId = uid;
    cards = [];
    render();
    if (uid) loadCards();
  }

  async function loadCards() {
    const uid = currentUserId;
    try {
      const list = await store.list();
      if (uid !== currentUserId) return; // 불러오는 사이 로그아웃·계정 전환
      cards = list;
      render();
    } catch (err) {
      console.warn('카드를 불러오지 못했습니다', err);
      if (uid === currentUserId) showSnackbar(MSG.loadFailed);
    }
  }

  // ===== 화면 그리기 =====

  // Material Icons(Apache 2.0) 경로. 글꼴 아이콘과 달리 인터넷 없이도 보인다
  const ICON_DRAG = 'M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z';
  const ICON_DELETE = 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z';

  // SVG는 HTML 요소가 아니라서 createElementNS로 SVG 네임스페이스를 지정해야 그려진다
  function icon(pathData) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', pathData);
    svg.appendChild(path);
    return svg;
  }

  function createCardElement(card) {
    const li = document.createElement('li');
    li.className = 'card';
    li.dataset.id = card.id;

    const handle = document.createElement('span');
    handle.className = 'card-handle';
    handle.appendChild(icon(ICON_DRAG));
    handle.title = '끌어서 옮기기';
    handle.setAttribute('aria-hidden', 'true');

    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = card.title; // innerHTML을 쓰지 않으므로 입력한 태그가 실행되지 않는다

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'card-delete';
    del.appendChild(icon(ICON_DELETE));
    del.setAttribute('aria-label', `"${card.title}" 삭제`);

    li.append(handle, title, del);
    return li;
  }

  function render() {
    for (const status of STATUSES) {
      const items = columnCards(cards, status);
      board.querySelector(`[data-list="${status}"]`)
        .replaceChildren(...items.map(createCardElement));
      board.querySelector(`[data-count="${status}"]`).textContent = String(items.length);
    }
  }

  // 화면을 먼저 바꾸고(낙관적 갱신), 바뀐 것만 서버에 순서대로 저장한다.
  // 저장이 실패하면 안내하고 서버의 내용으로 다시 불러와 화면과 서버를 맞춘다
  function commit(next) {
    const prev = cards;
    cards = next;
    render();
    const diff = diffCards(prev, next);
    if (!store || (!diff.removes.length && !diff.upserts.length)) return;
    const uid = currentUserId;
    saving = saving
      .then(() => store.apply(diff))
      .catch((err) => {
        console.warn('저장하지 못했습니다', err);
        if (uid !== currentUserId) return undefined;
        showSnackbar(MSG.saveFailed);
        return loadCards();
      });
  }

  // ===== 추가·삭제 =====

  board.addEventListener('submit', (e) => {
    const form = e.target.closest('.add-form');
    if (!form) return;
    e.preventDefault();
    const input = form.elements.title;
    const next = addCard(cards, form.dataset.status, input.value); // 공백 제거·빈 제목 거르기는 addCard가 한다
    if (next === cards) return;
    commit(next);
    input.value = '';
    input.focus();
  });

  board.addEventListener('click', (e) => {
    const del = e.target.closest('.card-delete');
    if (!del) return;
    commit(removeCard(cards, del.closest('.card').dataset.id));
  });

  // ===== 드래그(Pointer Events: 마우스·터치·펜 공통) =====
  // HTML5 Drag and Drop API는 모바일 터치에서 동작하지 않아서 쓰지 않는다

  // 끄는 중에만 값이 있다: { id, pointerId, cardEl, ghost, offsetX, offsetY, x, y, target, frame }
  let drag = null;

  const placeholder = document.createElement('li');
  placeholder.className = 'placeholder';

  // ----- 길게 누르기(터치·펜으로 카드 본문을 눌렀을 때) -----
  // 브라우저는 손가락이 닿는 순간 "스크롤할 수 있는 터치"로 정하므로, 본문은 바로 끌지 않는다.
  // LONG_PRESS_MS 동안 LONG_PRESS_SLOP px 안에서 누르고 있으면 그때 끌기를 시작하고,
  // 그 전에 움직이면 취소해서 브라우저가 평소처럼 스크롤하게 둔다
  const LONG_PRESS_MS = 400;  // 안드로이드 기본 길게 누르기(약 500ms)보다 짧게: 메뉴보다 먼저 시작
  const LONG_PRESS_SLOP = 8;  // 이만큼은 손가락이 흔들려도 누르고 있는 것으로 친다(px)

  // 길게 누르기를 기다리는 중에만 값이 있다: { pointerId, cardEl, x0, y0, x, y, timer }
  let press = null;

  function startLongPress(cardEl, e) {
    cardEl.classList.add('is-pressing');
    press = {
      pointerId: e.pointerId,
      cardEl,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        const p = press;
        cancelLongPress();
        startDrag(p.cardEl, { pointerId: p.pointerId, clientX: p.x, clientY: p.y });
      }, LONG_PRESS_MS),
    };
  }

  function cancelLongPress() {
    if (!press) return;
    clearTimeout(press.timer);
    press.cardEl.classList.remove('is-pressing');
    press = null;
  }

  board.addEventListener('pointerdown', (e) => {
    if (drag || press) return;
    const cardEl = e.target.closest('.card');
    if (!cardEl || e.target.closest('.card-delete')) return;
    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return; // 왼쪽 버튼만
    } else if (!e.target.closest('.card-handle')) {
      // 터치·펜으로 본문을 누름: 길게 누르면 끌기, 그 전에 움직이면 스크롤.
      // 스크롤 가능성을 남겨 두려고 preventDefault를 하지 않는다
      startLongPress(cardEl, e);
      return;
    }
    e.preventDefault(); // PC에서 끄는 동안 글자가 선택되지 않게
    startDrag(cardEl, e);
  });

  // 끄는 중에는 브라우저 스크롤을 막는다. 길게 누르기로 시작한 터치는 "스크롤할 수 있는 터치"라서
  // 막지 않으면 브라우저가 스크롤을 시작하며 pointercancel을 보내 끌기가 끊긴다.
  // preventDefault가 통하려면 passive: false여야 한다
  document.addEventListener('touchmove', (e) => {
    if (drag) e.preventDefault();
  }, { passive: false });

  // 길게 누를 때 뜨는 메뉴(복사, 링크 열기 등)를 막는다
  board.addEventListener('contextmenu', (e) => {
    if (drag || press) e.preventDefault();
  });

  // e: pointerdown 이벤트 또는 { pointerId, clientX, clientY }(길게 누르기 타이머에서 부를 때)
  function startDrag(cardEl, e) {
    const rect = cardEl.getBoundingClientRect();

    const ghost = cardEl.cloneNode(true);
    ghost.classList.add('ghost');
    ghost.style.width = `${rect.width}px`;
    document.body.appendChild(ghost);

    placeholder.style.height = `${rect.height}px`;
    cardEl.classList.add('is-dragging');
    document.body.classList.add('is-dragging-board');

    // 손가락이 카드 밖으로 나가도 board가 계속 이벤트를 받게 한다.
    // board는 render()로 다시 만들어지지 않으므로 끄는 도중 capture가 끊기지 않는다
    board.setPointerCapture(e.pointerId);

    drag = {
      id: cardEl.dataset.id,
      pointerId: e.pointerId,
      cardEl,
      ghost,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      x: e.clientX,
      y: e.clientY,
      target: null,
      frame: 0,
    };
    moveGhost();
    updateTarget();
    drag.frame = requestAnimationFrame(autoScrollLoop);
  }

  board.addEventListener('pointermove', (e) => {
    if (press && e.pointerId === press.pointerId) {
      // 길게 누르기 전에 SLOP보다 많이 움직이면 스크롤하려는 것으로 보고 취소한다
      if (Math.hypot(e.clientX - press.x0, e.clientY - press.y0) > LONG_PRESS_SLOP) {
        cancelLongPress();
      } else {
        press.x = e.clientX;
        press.y = e.clientY;
      }
      return;
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    moveGhost();
    updateTarget();
  });

  board.addEventListener('pointerup', (e) => {
    if (press && e.pointerId === press.pointerId) {
      cancelLongPress(); // 길게 누르기 전에 뗌(탭): 아무 일도 없음
      return;
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { id, target } = drag;
    endDrag();
    if (target) commit(moveCard(cards, id, target.status, target.index));
  });

  board.addEventListener('pointercancel', (e) => {
    // 길게 누르는 중: 브라우저가 스크롤을 시작함 / 끄는 중: 전화 수신, 브라우저 제스처 등
    if (press && e.pointerId === press.pointerId) cancelLongPress();
    if (drag && e.pointerId === drag.pointerId) endDrag();
  });

  board.addEventListener('lostpointercapture', (e) => {
    if (drag && e.pointerId === drag.pointerId) endDrag();
  });

  document.addEventListener('keydown', (e) => {
    if (drag && e.key === 'Escape') endDrag();
  });

  function moveGhost() {
    drag.ghost.style.transform =
      `translate(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px) rotate(2deg)`;
  }

  // 포인터 아래 열과 끼울 위치를 찾아 놓일 자리 표시를 옮긴다
  function updateTarget() {
    const el = document.elementFromPoint(drag.x, drag.y); // ghost는 pointer-events: none이라 걸리지 않는다
    const column = el && el.closest('.column');
    if (!column) {
      drag.target = null;
      placeholder.remove();
      return;
    }

    const list = column.querySelector('.card-list');
    const others = Array.from(list.querySelectorAll('.card'))
      .filter((c) => c.dataset.id !== drag.id);

    // 포인터가 카드의 세로 중앙선보다 위면 그 카드 앞에 끼운다
    const midlines = others.map((c) => {
      const r = c.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    const index = dropIndex(midlines, drag.y);

    drag.target = { status: column.dataset.status, index };
    list.insertBefore(placeholder, others[index] || null);
  }

  function autoScrollLoop() {
    if (!drag) return;
    const dy = autoScrollDelta(drag.y, window.innerHeight);
    if (dy !== 0) {
      window.scrollBy(0, dy);
      updateTarget(); // 스크롤로 포인터 아래 내용이 바뀌었으므로 다시 찾는다
    }
    drag.frame = requestAnimationFrame(autoScrollLoop);
  }

  // 놓기·취소 공통 정리. 상태(cards)는 바꾸지 않는다
  function endDrag() {
    const d = drag;
    drag = null; // 먼저 비워야 releasePointerCapture → lostpointercapture가 다시 들어오지 않는다
    cancelAnimationFrame(d.frame);
    d.ghost.remove();
    placeholder.remove();
    d.cardEl.classList.remove('is-dragging');
    document.body.classList.remove('is-dragging-board');
    if (board.hasPointerCapture(d.pointerId)) board.releasePointerCapture(d.pointerId);
  }

  // ===== 로그인 =====

  loginView.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-provider]');
    if (!btn || !client) return;
    showLoginMessage('');
    const { error } = await client.auth.signInWithOAuth({
      provider: btn.dataset.provider, // 'google' | 'github'
      options: { redirectTo: redirectUrl() },
    });
    if (error) showLoginMessage(MSG.oauthFailed + error.message, 'error');
    // 성공하면 브라우저가 Google·GitHub 화면으로 이동했다가 이 주소로 돌아온다
  });

  function authErrorMessage(error, fallback) {
    if (error.code === 'invalid_credentials') return MSG.invalidCredentials;
    if (error.code === 'email_not_confirmed') return MSG.notConfirmed;
    if (error.code === 'weak_password') return MSG.weakPassword;
    return fallback + error.message;
  }

  async function emailAuth(mode) {
    if (!client) return;
    const email = emailForm.elements.email.value.trim();
    const password = emailForm.elements.password.value;
    if (!email || !password) {
      showLoginMessage(MSG.needEmailPassword, 'error');
      return;
    }
    showLoginMessage('');
    setLoginBusy(true);
    try {
      if (mode === 'sign-up') {
        const { data, error } = await client.auth.signUp({
          email, password, options: { emailRedirectTo: redirectUrl() },
        });
        if (error) showLoginMessage(authErrorMessage(error, MSG.signUpFailed), 'error');
        else if (data.session) applySession(data.session); // 가입 확인 메일을 끈 프로젝트라면 바로 로그인
        else showLoginMessage(MSG.checkEmail, 'info');
      } else {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) {
          showLoginMessage(authErrorMessage(error, MSG.signInFailed), 'error');
        } else {
          emailForm.elements.password.value = ''; // 비밀번호를 화면에 남기지 않는다
          applySession(data.session);
        }
      }
    } finally {
      setLoginBusy(false);
    }
  }

  emailForm.addEventListener('submit', (e) => {
    e.preventDefault();
    emailAuth('sign-in');
  });

  loginView.querySelector('[data-action="sign-up"]').addEventListener('click', () => emailAuth('sign-up'));

  document.querySelector('.sign-out').addEventListener('click', async () => {
    if (!client) return;
    await client.auth.signOut();
    applySession(null);
  });

  // ===== 시작 =====

  async function start() {
    const cfg = window.KANBAN_CONFIG;
    const lib = window.supabase;
    if (!cfg || !cfg.supabaseUrl || !cfg.supabaseKey || !lib || typeof lib.createClient !== 'function') {
      // 설정 파일이 없거나 supabase-js(CDN)를 못 받았다(인터넷 끊김 등)
      loginView.hidden = false;
      setLoginBusy(true);
      showLoginMessage(MSG.unavailable, 'error');
      return;
    }
    client = lib.createClient(cfg.supabaseUrl, cfg.supabaseKey);
    store = window.KanbanStore.createStore(client);
    // 로그인·로그아웃·토큰 갱신, 소셜 로그인·확인 메일에서 돌아왔을 때 알려 준다.
    // - 콜백 안에서 바로 Supabase를 다시 부르면 supabase-js 내부 잠금과 엉킬 수 있어 다음 차례로 미룬다
    // - 알림에 담긴 세션은 "알림을 만든 시점" 것이라, 늦게 도착한 옛 알림이 방금 바뀐 상태(예: 로그아웃)를
    //   되돌리지 않도록 처리할 때 최신 세션을 다시 읽는다
    client.auth.onAuthStateChange(() => {
      setTimeout(async () => {
        const { data } = await client.auth.getSession();
        applySession(data.session);
      }, 0);
    });
    const { data } = await client.auth.getSession();
    applySession(data.session);
  }

  render();
  start();
})();
