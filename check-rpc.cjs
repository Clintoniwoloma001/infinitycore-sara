const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);
(async () => {
  const fns = ['run_sql', 'exec_sql', 'execute_sql', 'pg_query', 'run_migration'];
  for (const fn of fns) {
    try {
      const { data, error } = await supabase.rpc(fn, { sql: 'SELECT 1 as test' });
      if (error) console.log(fn + ':', error.message.substring(0, 80));
      else console.log(fn + ': SUCCESS', JSON.stringify(data).substring(0, 80));
    } catch(e) { console.log(fn + ':', (e.message || e).toString().substring(0, 80)); }
  }
})();
