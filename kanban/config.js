// Supabase 접속 정보. 둘 다 브라우저에 공개되는 값이다(publishable 키).
// 데이터 보호는 DB의 RLS 규칙이 한다(supabase/schema.sql). secret / service_role 키는 절대 넣지 않는다
window.KANBAN_CONFIG = {
  supabaseUrl: 'https://qgddocddwdffmejyuctw.supabase.co',
  supabaseKey: 'sb_publishable_4EssRmcsB7EszlN-5mLzCw_ApNLWSYy',
};
