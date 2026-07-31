#!/usr/bin/env node
// Compares two months of a Zoho "Sales by Customer" CSV export to find:
//   1. Lapsed customers: bought in the earlier month, nothing in the later
//      month — sorted by earlier-month sales so the highest-value lapsed
//      customers are first to reach out to.
//   2. Most loyal customers: bought in BOTH months, ranked by combined
//      order frequency (then combined sales) across the two months.
//
// Usage: node customer-retention-report.js <earlier-month.csv> <later-month.csv> [outDir]
// With outDir given, writes lapsed-customers.csv and top-loyal-customers.csv there.

const fs = require("fs");
const path = require("path");
const { loadCustomers, normKey } = require("./lib/customer-normalizer.js");

function csvField(v) {
  return `"${String(v).replace(/"/g, '""')}"`;
}

function main() {
  const [prevPath, curPath, outDir] = process.argv.slice(2);
  if (!prevPath || !curPath) {
    console.error("Usage: node customer-retention-report.js <earlier-month.csv> <later-month.csv> [outDir]");
    process.exit(1);
  }

  const { customers: prev } = loadCustomers(prevPath);
  const { customers: cur } = loadCustomers(curPath);
  const prevByKey = new Map(prev.map((c) => [normKey(c.display), c]));
  const curByKey = new Map(cur.map((c) => [normKey(c.display), c]));

  const lapsed = prev
    .filter((c) => !curByKey.has(normKey(c.display)))
    .sort((a, b) => b.sales - a.sales);

  const allKeys = new Set([...prevByKey.keys(), ...curByKey.keys()]);
  const combined = [...allKeys].map((key) => {
    const p = prevByKey.get(key);
    const c = curByKey.get(key);
    return {
      display: (c || p).display,
      society: (c || p).society,
      prevOrders: p ? p.count : 0,
      curOrders: c ? c.count : 0,
      prevSales: p ? p.sales : 0,
      curSales: c ? c.sales : 0,
      boughtBoth: !!p && !!c,
    };
  });

  const loyal = combined
    .filter((c) => c.boughtBoth)
    .sort((a, b) => {
      const totalA = a.prevOrders + a.curOrders;
      const totalB = b.prevOrders + b.curOrders;
      if (totalB !== totalA) return totalB - totalA;
      return (b.prevSales + b.curSales) - (a.prevSales + a.curSales);
    })
    .slice(0, 250);

  console.log(`Earlier month: ${prev.length} unique customers`);
  console.log(`Later month:   ${cur.length} unique customers`);
  console.log(`Lapsed (bought earlier month, nothing later): ${lapsed.length}`);
  console.log(`Bought in both months: ${combined.filter((c) => c.boughtBoth).length}`);
  console.log("");
  console.log("Top 15 lapsed by value:");
  console.log("customer_name,society,orders,sales");
  for (const c of lapsed.slice(0, 15)) {
    console.log(`${c.display},${c.society},${c.count},${c.sales.toFixed(2)}`);
  }
  console.log("");
  console.log("Top 15 most loyal:");
  console.log("customer_name,society,total_orders,total_sales");
  for (const c of loyal.slice(0, 15)) {
    console.log(`${c.display},${c.society},${c.prevOrders + c.curOrders},${(c.prevSales + c.curSales).toFixed(2)}`);
  }

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });

    const lapsedLines = ["customer_name,society,orders,sales_with_tax"];
    for (const c of lapsed) {
      lapsedLines.push(`${csvField(c.display)},${c.society},${c.count},${c.sales.toFixed(2)}`);
    }
    fs.writeFileSync(path.join(outDir, "lapsed-customers.csv"), lapsedLines.join("\n") + "\n");

    const loyalLines = ["rank,customer_name,society,prev_month_orders,cur_month_orders,total_orders,prev_month_sales,cur_month_sales,total_sales"];
    loyal.forEach((c, i) => {
      loyalLines.push(
        `${i + 1},${csvField(c.display)},${c.society},${c.prevOrders},${c.curOrders},${c.prevOrders + c.curOrders},${c.prevSales.toFixed(2)},${c.curSales.toFixed(2)},${(c.prevSales + c.curSales).toFixed(2)}`
      );
    });
    fs.writeFileSync(path.join(outDir, "top-loyal-customers.csv"), loyalLines.join("\n") + "\n");

    console.log("");
    console.log(`Wrote ${path.join(outDir, "lapsed-customers.csv")} (${lapsed.length} rows)`);
    console.log(`Wrote ${path.join(outDir, "top-loyal-customers.csv")} (${loyal.length} rows)`);
  }
}

main();
