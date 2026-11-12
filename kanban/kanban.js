// 칸반 보드 순수 로직: DOM과 localStorage를 건드리지 않는다
// 입력을 받아 새 값을 돌려주기만 하므로 브라우저 없이(Jest) 테스트할 수 있다
// 브라우저에서는 window.Kanban, Node(Jest)에서는 module.exports로 내보낸다
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Kanban = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATUSES = ['todo', 'doing', 'done'];
  const EDGE = 60;        // 화면 위아래 끝에서 이 거리(px) 안이면 자동 스크롤
  const MAX_SCROLL = 16;  // 프레임당 최대 스크롤 거리(px)

  function isValidCard(c) {
    return c !== null && typeof c === 'object'
      && typeof c.id === 'string'
      && typeof c.title === 'string'
      && STATUSES.includes(c.status)
      && Number.isFinite(c.order);
  }

  // localStorage에서 읽은 문자열 → 카드 배열. 깨졌거나 형식이 맞지 않는 항목은 버린다
  function parseCards(raw) {
    if (!raw) return [];
    try {
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data.filter(isValidCard) : [];
    } catch (e) {
      return [];
    }
  }

  // DB(Supabase)의 id 열이 uuid라서 uuid v4로 만든다. 브라우저 기본 기능이 없으면 같은 형식으로 직접 만든다
  function newId() {
    const c = typeof crypto !== 'undefined' ? crypto : undefined;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
      const r = Math.floor(Math.random() * 16);
      return (ch === 'x' ? r : (r % 4) + 8).toString(16);
    });
  }

  // SQL로 치면 WHERE status = ? ORDER BY order
  function columnCards(list, status) {
    return list
      .filter((c) => c.status === status)
      .sort((a, b) => a.order - b.order);
  }

  // ordered에 든 카드들을 status 열에 0부터 순서대로 다시 매긴다
  function renumber(list, status, ordered) {
    const orderOf = new Map(ordered.map((c, i) => [c.id, i]));
    return list.map((c) => (orderOf.has(c.id) ? { ...c, status, order: orderOf.get(c.id) } : c));
  }

  // 제목의 앞뒤 공백을 지우고 열 맨 아래에 붙인다. 빈 제목이면 원래 배열을 그대로 돌려준다
  function addCard(list, status, title, id = newId(), now = Date.now()) {
    const text = String(title).trim();
    if (!text || !STATUSES.includes(status)) return list;
    const order = columnCards(list, status).length;
    return list.concat({ id, title: text, status, order, createdAt: now });
  }

  function removeCard(list, id) {
    const card = list.find((c) => c.id === id);
    if (!card) return list;
    const rest = list.filter((c) => c.id !== id);
    return renumber(rest, card.status, columnCards(rest, card.status));
  }

  // id 카드를 toStatus 열의 toIndex 자리(끄는 카드를 뺀 목록 기준)에 넣는다
  function moveCard(list, id, toStatus, toIndex) {
    const card = list.find((c) => c.id === id);
    if (!card || !STATUSES.includes(toStatus)) return list;
    const fromStatus = card.status;

    const target = columnCards(list, toStatus).filter((c) => c.id !== id);
    const index = Math.max(0, Math.min(toIndex, target.length));
    target.splice(index, 0, card);

    let next = renumber(list, toStatus, target);
    if (fromStatus !== toStatus) {
      next = renumber(next, fromStatus, columnCards(next, fromStatus).filter((c) => c.id !== id));
    }
    return next;
  }

  // 저장할 때 바뀐 것만 서버에 보내려고 두 상태를 비교한다
  // removes: 사라진 카드 id / upserts: 새로 생겼거나 제목·열·순서가 바뀐 카드
  function diffCards(before, after) {
    const prev = new Map(before.map((c) => [c.id, c]));
    const nextIds = new Set(after.map((c) => c.id));
    const removes = before.filter((c) => !nextIds.has(c.id)).map((c) => c.id);
    const upserts = after.filter((c) => {
      const p = prev.get(c.id);
      return !p || p.title !== c.title || p.status !== c.status || p.order !== c.order;
    });
    return { removes, upserts };
  }

  // 카드들의 세로 중앙선(위에서부터) 목록과 포인터 y로 끼울 위치를 정한다
  // 포인터가 어떤 카드의 중앙선보다 위면 그 카드 앞, 어디에도 해당하지 않으면 맨 끝
  function dropIndex(midlines, y) {
    const i = midlines.findIndex((mid) => y < mid);
    return i === -1 ? midlines.length : i;
  }

  // 화면 위아래 끝 edge px 안으로 들어갈수록 빠르게 스크롤(음수: 위로, 양수: 아래로)
  function autoScrollDelta(y, height, edge = EDGE, max = MAX_SCROLL) {
    if (y < edge) return -Math.ceil((Math.min(edge - y, edge) / edge) * max);
    if (y > height - edge) return Math.ceil((Math.min(y - (height - edge), edge) / edge) * max);
    return 0;
  }

  return {
    STATUSES,
    isValidCard,
    parseCards,
    newId,
    columnCards,
    renumber,
    addCard,
    removeCard,
    moveCard,
    diffCards,
    dropIndex,
    autoScrollDelta,
  };
});
