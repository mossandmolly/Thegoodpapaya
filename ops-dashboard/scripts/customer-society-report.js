#!/usr/bin/env node
// Reads a Zoho "Sales by Customer" CSV export, collapses customer_name rows
// that refer to the same real customer (case/spacing/punctuation differences,
// and Zoho's auto-appended "-1"/"-2" duplicate-contact suffix), then reports
// a distribution of unique customers by society using the same
// society/alias list the order parser uses.
//
// Usage: node customer-society-report.js <path-to-sales-by-customer.csv> [customer-detail-out.csv]
// The optional second argument writes one row per unique (deduped) customer
// with the society it was assigned to, for auditing the grouping decisions.

const fs = require("fs");
const { resolveSociety, splitGluedSociety } = require("../js/order-parser.js");

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row = {};
    header.forEach((h, i) => { row[h] = cols[i]; });
    return row;
  });
}

function normKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Manual overrides for societies known to be a single real community despite
// splitting into multiple resolved/inferred names above (typos, sub-block
// names, or a shared complex referred to by its individual tower numbers).
const MANUAL_SOCIETY_MERGES = [
  { test: (s) => /^sjr/i.test(s) && /blu.?water/i.test(s), into: "Sjr Bluewater" },
  { test: (s) => /^sjr/i.test(s) && /redwood/i.test(s), into: "Sjr Redwood" },
  { test: (s) => /^t[1-7]$/i.test(s) || /^lotus$/i.test(s), into: "Lotus (T1-T7)" },
];

function applyManualMerge(soc) {
  for (const rule of MANUAL_SOCIETY_MERGES) {
    if (rule.test(soc)) return rule.into;
  }
  return soc;
}

// Best-effort society name for customers the canonical list doesn't cover:
// take the leading run of tokens that contain no digits (society names are
// alphabetic, door/unit numbers contain a digit), then collapse a trailing
// plural "s" so "Bren Edgewaters" and "Brenedgewater" land in the same bucket.
function inferSociety(words) {
  const lead = [];
  for (const w of words) {
    if (/\d/.test(w)) break;
    lead.push(w);
  }
  let base = lead.length ? lead.join(" ") : words[0].replace(/\d+$/, "");
  if (!base) base = words[0];
  const display = base
    .split(/\s+/)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
  let key = normKey(base);
  if (key.length > 4 && key.endsWith("s")) key = key.slice(0, -1);
  return { key, display };
}

function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("Usage: node customer-society-report.js <path-to-csv>");
    process.exit(1);
  }
  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));

  // Group raw rows by normalized key (case/space/punctuation-insensitive).
  const groups = new Map(); // normKey -> { names: Map(rawName -> count), count, sales }
  for (const row of rows) {
    const raw = row.customer_name.trim();
    const key = normKey(raw);
    if (!groups.has(key)) groups.set(key, { names: new Map(), count: 0, sales: 0 });
    const g = groups.get(key);
    g.names.set(raw, (g.names.get(raw) || 0) + 1);
    g.count += Number(row.count) || 0;
    g.sales += parseFloat(row.sales_with_tax) || 0;
  }

  // Fold in Zoho's auto-duplicate "-1"/"-2" suffix: only merge when the
  // suffix-stripped name normalizes to another group that already exists
  // independently (real evidence of duplication, not just a door number
  // that happens to end in a dash-number like "Ahad 12-202").
  for (const [key, g] of [...groups]) {
    // only strip if the *raw* form actually had a "-<digits>" suffix
    const rawSample = [...g.names.keys()][0];
    const dashMatch = rawSample.match(/^(.*)-(\d{1,2})$/);
    if (!dashMatch) continue;
    const trimmedKey = normKey(dashMatch[1]);
    if (trimmedKey !== key && groups.has(trimmedKey)) {
      const target = groups.get(trimmedKey);
      for (const [name, count] of g.names) target.names.set(name, (target.names.get(name) || 0) + count);
      target.count += g.count;
      target.sales += g.sales;
      groups.delete(key);
    }
  }

  // Pick a display name per unique customer: the raw spelling seen most often.
  const customers = [...groups.values()].map((g) => {
    const display = [...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { display, count: g.count, sales: g.sales };
  });

  // Assign each unique customer to a society: try the canonical list first
  // (authoritative — same list order-entry parsing uses), otherwise fall
  // back to a heuristic guess flagged as "inferred" for manual review.
  const bySociety = new Map(); // society -> { customers: [], sales, orders, inferred }
  for (const c of customers) {
    const words = c.display.trim().split(/\s+/);
    let soc = null;

    const [gluedSoc] = splitGluedSociety(words[0]);
    if (gluedSoc) soc = gluedSoc;
    if (!soc) [soc] = resolveSociety(words[0]);
    if (!soc && words.length > 1) [soc] = resolveSociety(words[0] + words[1]);

    let inferred = false;
    if (!soc) {
      const guess = inferSociety(words);
      soc = guess.display;
      inferred = true;
    }
    soc = applyManualMerge(soc);
    c.society = soc;
    c.inferred = inferred;

    if (!bySociety.has(soc)) bySociety.set(soc, { customers: [], sales: 0, orders: 0, inferred: false });
    if (inferred) bySociety.get(soc).inferred = true;
    const s = bySociety.get(soc);
    s.customers.push(c.display);
    s.sales += c.sales;
    s.orders += c.count;
  }

  const detailOut = process.argv[3];
  if (detailOut) {
    const lines = ["customer_name,society,inferred,orders,sales_with_tax"];
    for (const c of [...customers].sort((a, b) => a.society.localeCompare(b.society) || a.display.localeCompare(b.display))) {
      lines.push(`"${c.display}",${c.society},${c.inferred},${c.count},${c.sales.toFixed(2)}`);
    }
    fs.writeFileSync(detailOut, lines.join("\n") + "\n");
  }

  const inferredCount = [...bySociety.values()].filter((s) => s.inferred).length;
  console.log(`Raw customer_name rows: ${rows.length}`);
  console.log(`Unique customers (normalized): ${customers.length}`);
  console.log(`Societies: ${bySociety.size} (${bySociety.size - inferredCount} from canonical list, ${inferredCount} inferred — review these)`);
  console.log("");

  const totalSales = customers.reduce((sum, c) => sum + c.sales, 0);
  const totalOrders = customers.reduce((sum, c) => sum + c.count, 0);
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  console.log(`Avg sales per customer: ${(totalSales / customers.length).toFixed(2)}`);
  console.log(`Avg orders (frequency) per customer: ${(totalOrders / customers.length).toFixed(2)}`);
  console.log(`Median orders (frequency) per customer: ${median(customers.map((c) => c.count))}`);
  console.log(`Median sales per customer: ${median(customers.map((c) => c.sales)).toFixed(2)}`);
  console.log("");
  const sorted = [...bySociety.entries()].sort((a, b) => b[1].customers.length - a[1].customers.length);
  console.log("society,unique_customers,pct_customers,orders,sales_with_tax,pct_sales,inferred");
  for (const [soc, data] of sorted) {
    const pctCustomers = ((data.customers.length / customers.length) * 100).toFixed(1);
    const pctSales = ((data.sales / totalSales) * 100).toFixed(1);
    console.log(`${soc},${data.customers.length},${pctCustomers}%,${data.orders},${data.sales.toFixed(2)},${pctSales}%,${data.inferred}`);
  }
  console.log(`Grand Total,${customers.length},100.0%,${totalOrders},${totalSales.toFixed(2)},100.0%,`);
}

main();
