const { createClient } = require('@supabase/supabase-js');

// Service-role key bypasses RLS — keep this secret, server-side only
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = supabase;
