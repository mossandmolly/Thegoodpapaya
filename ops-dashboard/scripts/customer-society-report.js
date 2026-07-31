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
const { loadCustomers } = require("./lib/customer-normalizer.js");

function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("Usage: node customer-society-report.js <path-to-csv>");
    process.exit(1);
  }
  const { customers, rawRowCount } = loadCustomers(csvPath);

  const bySociety = new Map(); // society -> { customers: [], sales, orders, inferred }
  for (const c of customers) {
    if (!bySociety.has(c.society)) bySociety.set(c.society, { customers: [], sales: 0, orders: 0, inferred: false });
    const s = bySociety.get(c.society);
    if (c.inferred) s.inferred = true;
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
  console.log(`Raw customer_name rows: ${rawRowCount}`);
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
