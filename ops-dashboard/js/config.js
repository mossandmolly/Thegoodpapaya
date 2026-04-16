// Replace with your Supabase project values
const SUPABASE_URL  = 'https://fykqprogzqcfzrgwlrem.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5a3Fwcm9nenFjZnpyZ3dscmVtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2NDkzMzEsImV4cCI6MjA5MTIyNTMzMX0.FseaaYNbN-QLhzdQF5rcImLvvoWRHOiGcZcbiFaIplQ';

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
