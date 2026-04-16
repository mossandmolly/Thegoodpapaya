// Replace with your Supabase project values
const SUPABASE_URL  = 'REPLACE_WITH_YOUR_SUPABASE_URL';
const SUPABASE_ANON = 'REPLACE_WITH_YOUR_ANON_KEY';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// Today's date in IST
function todayIST() {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().substring(0, 10);
}

function formatDate(d) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

function showToast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2500);
}
