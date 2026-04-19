let currentCustomerData = null;
let lastSituation = '';

// ── Microphone / Speech recognition ───────────────────────────
let recognition = null;
let isRecording  = false;

function initMic() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = document.getElementById('mic-btn');

  if (!SpeechRecognition) {
    btn.classList.add('unsupported');
    btn.title = 'Voice input not supported in this browser';
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'en-IN';
  recognition.continuous = false;
  recognition.interimResults = true;

  const ta = document.getElementById('situation');
  let baseText = '';

  recognition.onstart = () => {
    isRecording = true;
    baseText = ta.value;
    btn.classList.add('recording');
    btn.title = 'Tap to stop';
  };

  recognition.onresult = (e) => {
    const transcript = Array.from(e.results)
      .map(r => r[0].transcript)
      .join('');
    ta.value = baseText ? `${baseText} ${transcript}` : transcript;
  };

  recognition.onend = () => {
    isRecording = false;
    btn.classList.remove('recording');
    btn.title = 'Speak your situation';
  };

  recognition.onerror = (e) => {
    isRecording = false;
    btn.classList.remove('recording');
    if (e.error !== 'no-speech') showToast('Mic error: ' + e.error, 'error');
  };
}

function toggleMic() {
  if (!recognition) return;
  if (isRecording) {
    recognition.stop();
  } else {
    recognition.start();
  }
}

initMic();

const SCENARIO_HINTS = {
  quantity: 'The customer is saying their order had wrong quantities or wrong items. ',
  refund:   'The customer is requesting a refund. ',
  escalation: 'The customer is very upset and escalating. ',
  payment:  'The customer has a question about their invoice or payment. ',
};

function selectScenario(el, type) {
  document.querySelectorAll('.scenario-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');

  const ta = document.getElementById('situation');
  const hint = SCENARIO_HINTS[type] || '';
  if (!ta.value.startsWith(hint)) {
    ta.value = hint + ta.value.replace(/^(The customer is saying.*?\. |The customer is requesting.*?\. |The customer is very upset.*?\. |The customer has a question.*?\. )/, '');
  }
  ta.focus();
}

async function lookupCustomer() {
  const input = document.getElementById('customer-input').value.trim();
  if (!input) return;

  const infoEl = document.getElementById('customer-info');
  infoEl.innerHTML = '<div class="skeleton" style="height:60px;margin-top:12px"></div>';

  try {
    // Search by customer_name (partial) or phone number
    const isPhone = /^\d{7,}$/.test(input.replace(/\s/g, ''));

    let query = sb
      .from('invoice_line_items')
      .select('customer_name, item_name, requested_quantity, final_quantity, invoice_total, amount_paid, payment_status, invoice_number, invoice_date')
      .order('invoice_date', { ascending: false })
      .limit(20);

    if (isPhone) {
      query = query.eq('phone_number', input.replace(/\s/g, ''));
    } else {
      query = query.ilike('customer_name', `%${input}%`);
    }

    const { data, error } = await query;

    if (error) throw error;

    if (!data || data.length === 0) {
      infoEl.innerHTML = `<div style="margin-top:12px;font-size:0.85rem;color:var(--text-muted)">No customer found for "${input}"</div>`;
      currentCustomerData = null;
      return;
    }

    const customerName = data[0].customer_name;

    // Deduplicate by invoice+item (latest per invoice_number)
    const seen = new Set();
    const invoices = data.filter(row => {
      const key = `${row.invoice_number}|${row.item_name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 8);

    // Fetch complaint history in parallel
    const { data: complaints } = await sb
      .from('complaint_history')
      .select('complaint_date, complaint_type, description, invoice_number')
      .ilike('customer_name', `%${customerName}%`)
      .order('complaint_date', { ascending: false })
      .limit(20);

    const orderCount = new Set(data.map(r => r.invoice_number)).size;
    const complaintCount = complaints?.length || 0;
    const hasIntegrityComplaint = complaints?.some(c => c.complaint_type === 'integrity') || false;

    currentCustomerData = { customerName, invoices, complaints: complaints || [], orderCount, complaintCount, hasIntegrityComplaint };

    const rows = invoices.map(inv => {
      const short = inv.requested_quantity && inv.final_quantity &&
        parseFloat(inv.final_quantity) < parseFloat(inv.requested_quantity);
      const qtyLabel = inv.requested_quantity
        ? `${inv.final_quantity ?? '—'} / ${inv.requested_quantity}${short ? ' <span class="qty-short">▼</span>' : ''}`
        : inv.final_quantity ?? '—';

      let statusClass = 'status-unpaid';
      let statusLabel = 'Unpaid';
      if (inv.payment_status === 'paid') { statusClass = 'status-paid'; statusLabel = 'Paid'; }
      else if (inv.payment_status === 'partial') { statusClass = 'status-partial'; statusLabel = 'Partial'; }

      return `<div class="invoice-row">
        <span class="inv-item">${inv.item_name}</span>
        <span class="inv-qty">${qtyLabel}</span>
        <span class="inv-status ${statusClass}">${statusLabel}</span>
      </div>`;
    }).join('');

    // Complaint summary badge
    let complaintBadge = '';
    if (hasIntegrityComplaint) {
      complaintBadge = `<div style="margin-top:8px;padding:6px 10px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;font-size:0.78rem;color:#dc2626;font-weight:500">⚠️ Integrity/ethics complaint on record — AI will use firm, direct tone</div>`;
    } else if (orderCount > 0 && complaintCount / orderCount >= 0.5) {
      complaintBadge = `<div style="margin-top:8px;padding:6px 10px;background:#fff3e0;border:1px solid #ffe0b2;border-radius:6px;font-size:0.78rem;color:#e65100;font-weight:500">⚠️ Frequent complainer (${complaintCount}/${orderCount} orders) — AI will use direct, friendly tone</div>`;
    } else if (complaintCount > 0) {
      complaintBadge = `<div style="margin-top:8px;font-size:0.78rem;color:var(--text-muted)">${complaintCount} past complaint${complaintCount > 1 ? 's' : ''} on record</div>`;
    }

    infoEl.innerHTML = `<div class="customer-info">
      <div class="ci-name">✓ ${customerName}</div>
      ${rows}
      ${complaintBadge}
    </div>`;

  } catch (err) {
    console.error(err);
    infoEl.innerHTML = `<div style="margin-top:12px;font-size:0.85rem;color:var(--red)">Error looking up customer</div>`;
    currentCustomerData = null;
  }
}

async function askSomya() {
  const situation = document.getElementById('situation').value.trim();
  if (!situation) {
    showToast('Please describe the situation first', 'error');
    return;
  }

  lastSituation = situation;
  setLoading(true);

  const contentEl = document.getElementById('response-content');
  contentEl.innerHTML = `<div class="response-skeleton">
    <div class="skeleton" style="height:14px;width:85%"></div>
    <div class="skeleton" style="height:14px;width:70%"></div>
    <div class="skeleton" style="height:14px;width:90%"></div>
    <div class="skeleton" style="height:14px;width:55%"></div>
  </div>`;

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/somya-chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON}`,
        'apikey': SUPABASE_ANON,
      },
      body: JSON.stringify({
        situation,
        customerData: currentCustomerData || null,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const { response } = await res.json();
    showResponse(response);

  } catch (err) {
    console.error(err);
    contentEl.innerHTML = `<div class="response-empty">
      <div class="emoji">⚠️</div>
      <p>Something went wrong: ${err.message}</p>
    </div>`;
    showToast('Failed to get response', 'error');
  } finally {
    setLoading(false);
  }
}

function showResponse(text) {
  const contentEl = document.getElementById('response-content');
  contentEl.innerHTML = `
    <div class="whatsapp-bubble" id="response-text">${escapeHtml(text)}</div>
    <div class="response-actions">
      <button class="btn-copy" onclick="copyResponse()">Copy for WhatsApp</button>
      <button class="btn-regen" onclick="askSomya()">Try again</button>
    </div>`;
}

function copyResponse() {
  const text = document.getElementById('response-text')?.textContent || '';
  navigator.clipboard.writeText(text).then(() => {
    showToast('Copied! ✓', 'success');
  }).catch(() => {
    showToast('Could not copy — select and copy manually', 'error');
  });
}

function setLoading(on) {
  const btn = document.getElementById('ask-btn');
  const label = document.getElementById('ask-btn-text');
  if (on) {
    btn.disabled = true;
    label.textContent = 'Thinking…';
    btn.insertAdjacentHTML('afterbegin', '<span class="spinner"></span>');
  } else {
    btn.disabled = false;
    label.textContent = 'Ask Somya AI';
    btn.querySelector('.spinner')?.remove();
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
