// 칸반 저장소 계층: Supabase 테이블 kanban_cards와 앱 카드 모양을 오간다
// Java로 치면 Repository. DOM을 모르고 client(supabase-js)만 받으므로 가짜 client로 단위 테스트한다
// 브라우저에서는 window.KanbanStore, Node(Jest)에서는 module.exports
(function (root, factory) {
  'use strict';
  const Kanban = typeof module === 'object' && module.exports ? require('./kanban.js') : root.Kanban;
  const api = factory(Kanban);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KanbanStore = api;
})(typeof self !== 'undefined' ? self : this, function (Kanban) {
  'use strict';

  const TABLE = 'kanban_cards';
  const COLUMNS = 'id,title,status,sort_order,created_at'; // user_id는 RLS가 처리하므로 읽지 않는다

  // DB 행 → 앱 카드
  function toCard(row) {
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      order: row.sort_order,
      createdAt: Date.parse(row.created_at) || 0,
    };
  }

  // 앱 카드 → DB 행. user_id(기본값 auth.uid())와 created_at(기본값 now())은 DB가 채운다
  function toRow(card) {
    return { id: card.id, title: card.title, status: card.status, sort_order: card.order };
  }

  // supabase-js는 실패해도 예외를 던지지 않고 { error }를 돌려준다. 호출하는 쪽이 try/catch 하나로 처리하도록 예외로 바꾼다
  function check({ error }) {
    if (error) throw error;
  }

  function createStore(client) {
    return {
      // 내 카드 전체(RLS가 내 행만 돌려준다). 형식이 맞지 않는 행은 버린다
      async list() {
        const res = await client.from(TABLE).select(COLUMNS).order('status').order('sort_order');
        check(res);
        return res.data.map(toCard).filter(Kanban.isValidCard);
      },

      // diffCards 결과를 서버에 반영한다. 지우기 → 고치기 순서. 앞 단계가 실패하면 멈춘다
      async apply({ removes, upserts }) {
        if (removes.length) check(await client.from(TABLE).delete().in('id', removes));
        if (upserts.length) check(await client.from(TABLE).upsert(upserts.map(toRow)));
      },
    };
  }

  return { createStore, toCard, toRow, TABLE };
});
