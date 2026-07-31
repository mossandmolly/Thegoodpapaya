// Good Papaya order-text parser — JavaScript port of parser.py
// Same rules: society/door detection, item-anchor scanning, multiword
// collapsing, number-word normalization, pc->kg conversion, stop words,
// new-customer flagging. Runs entirely client-side, no dependencies.
//
// Call setSocieties(canonicals, aliasMap) after loading from Supabase
// to override the built-in defaults below.

let CANONICAL_SOCIETIES = [
  "77degree", "80trees", "ahad", "akme", "ascentia", "assetz", "bhuvi",
  "dsr", "dsrparkway", "espana", "ferns", "iksha", "iris", "ivy", "jade",
  "kethana", "krishvigavakshi", "lakefront", "lotus", "meda", "pristine",
  "regalia", "rohan", "saroj", "silvedale", "silverdale", "silversun",
  "summerfieldvilla", "suncity", "sunnyside", "sunshinesignature",
  "t1", "t2", "t3", "t4", "t5", "t6", "t7", "uberphase1", "uberphase2",
  "vajram", "vars", "villa", "wing", "dhavala", "palmera",
];

let SOC_ALIASES = {
  "77": "77degree", "77-degree": "77degree", "80tree": "80trees",
  "akmi": "akme", "essentia": "ascentia", "feens": "ferns",
  "krishvagavakshi": "krishvigavakshi", "krishvi": "krishvigavakshi",
  "krishvika": "krishvigavakshi", "krishvigavakahi": "krishvigavakshi",
  "krishvigavkshi": "krishvigavakshi", "krishvugavakshi": "krishvigavakshi",
  "lksha": "iksha", "regaila": "regalia", "sunny": "sunnyside",
  "uber": "uberphase1", "vella": "villa", "vela": "villa", "vila": "villa",
  "vill": "villa",
};

const ITEM_ANCHORS = new Set([
  "alphonso", "amla", "apple", "appleber", "avocado", "badami", "banana",
  "banganapalli", "benishan", "blueberry", "cara", "cherry", "chikoo",
  "citrus", "corn", "custard", "dasheri", "dragon", "egyptian", "fuji",
  "gala", "grapes", "guava", "imampasand", "jackfruit", "jamun", "jujube",
  "kashmiri", "kesar", "kinnow", "kiwi", "langra", "lemon", "longan",
  "lychee", "malgova", "malika", "mandarin", "mango", "mangosteen",
  "melon", "mosambi", "mulberry", "muscat", "muskmelon", "mysore",
  "nagpur", "neelam", "nendra", "orange", "papaya", "passion", "peach",
  "pear", "peas", "persimmon", "pineapple", "plum", "pomegranate",
  "rambutan", "raspberry", "robusta", "rockit", "rose", "royal", "sapota",
  "shimla", "sindhura", "strawberry", "tamarind", "totapuri", "valencia",
  "washington", "watermelon", "yelakki", "desi", "nati", "nz", "berry",
]);

const QUALIFIERS = new Set([
  "white", "red", "green", "black", "pink", "golden", "organic", "local",
  "raw", "sweet", "large", "small", "medium", "big", "striped", "sunrise",
  "seedless", "globe", "crispy", "lady", "muscat", "yellow", "purple",
]);

const QTY_UNITS = new Set(["kg", "pcs", "pieces", "piece", "box", "boxes", "nos", "no"]);

const STOP_WORDS = new Set([
  "not", "ripe", "unripe", "fat", "thin", "long", "short", "fresh",
  "sour", "hard", "soft", "please", "and", "or", "with", "for", "the",
  "a", "an", "is", "no", "yes", "ok", "also", "just", "only", "very",
  "too", "more", "less", "flat", "pasand", "pieces", "piece", "rai",
]);

const DIGIT_WORDS = {
  zero: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};
const FRACTION_MAP = { half: "0.5", quarter: "0.25" };

const ITEM_WORD_ALIASES = {
  elaichi: "yelakki", yalakki: "yelakki", yalaki: "yelakki", yellaki: "yelakki",
  rocket: "rockit", began: "banganapalli", langda: "langra", langdaa: "langra",
  musk: "muskmelon",
};

const ANCHOR_DEFAULTS = {
  grapes: "Green grapes", banana: "Yelakki banana", orange: "Nagpur orange",
  apple: "Gala apple", guava: "Guava white", kiwi: "Kiwi green",
};

const SPOKEN_MULTIWORD = { imam: ["pasand"], musk: ["melon"] };

// pc -> kg conversion factors
const PC_TO_KG = {
  apple: 0.18, guava: 0.30, pomegranate: 0.35,
  mango: 0.5,
  "dragon red": 0.5, plum: 0.05,
};

// ---------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------

function pretokenize(line) {
  const tokens = line.trim().split(/\s+/);
  const cleaned = [];
  for (let t of tokens) {
    t = t.replace(/^[,;]+|[,;]+$/g, "");
    if (/^\d+\.\d+$/.test(t)) { cleaned.push(t); continue; }
    t = t.replace(/\.+$/, "");
    if (t) cleaned.push(t);
  }
  return cleaned;
}

function normalizeTokens(tokens) {
  const t1 = [];
  let i = 0;
  while (i < tokens.length) {
    const low = tokens[i].toLowerCase();
    if (SPOKEN_MULTIWORD[low]) {
      const extra = SPOKEN_MULTIWORD[low];
      let j = i + 1, ok = true;
      for (const e of extra) {
        if (j < tokens.length && tokens[j].toLowerCase() === e) j++;
        else { ok = false; break; }
      }
      if (ok) { t1.push(low + extra.join("")); i = j; continue; }
    }
    t1.push(tokens[i]); i++;
  }
  const out = [];
  i = 0;
  while (i < t1.length) {
    const low = t1[i].toLowerCase();
    if (FRACTION_MAP[low]) { out.push(FRACTION_MAP[low]); i++; continue; }
    if (DIGIT_WORDS[low]) {
      let num = "", j = i;
      while (j < t1.length && DIGIT_WORDS[t1[j].toLowerCase()]) { num += DIGIT_WORDS[t1[j].toLowerCase()]; j++; }
      if (j < t1.length && t1[j].toLowerCase() === "point") {
        j++;
        let dec = "";
        while (j < t1.length && DIGIT_WORDS[t1[j].toLowerCase()]) { dec += DIGIT_WORDS[t1[j].toLowerCase()]; j++; }
        if (dec) { out.push((num || "0") + "." + dec); i = j; continue; }
      }
      out.push(num); i = j; continue;
    }
    if (low === "point" && i + 1 < t1.length && DIGIT_WORDS[t1[i + 1].toLowerCase()]) {
      let dec = "", j = i + 1;
      while (j < t1.length && DIGIT_WORDS[t1[j].toLowerCase()]) { dec += DIGIT_WORDS[t1[j].toLowerCase()]; j++; }
      out.push("0." + dec); i = j; continue;
    }
    out.push(t1[i]); i++;
  }
  return out;
}

// ---------------------------------------------------------------------
// Rule-based fuzzy matching
// ---------------------------------------------------------------------

function ruleMatch(spoken, candidates, minScore = 12) {
  const sl = spoken.toLowerCase().trim();
  for (const c of candidates) if (c.toLowerCase() === sl) return [c, true];
  if (SOC_ALIASES[sl]) return [SOC_ALIASES[sl], true];

  let best = null, bestScore = 0;
  for (const c of candidates) {
    const cl = c.toLowerCase();
    if (!cl || cl[0] !== sl[0]) continue;
    const prefixLen = Math.min(4, sl.length, cl.length);
    let pScore = 0;
    for (let k = 0; k < prefixLen; k++) { if (sl[k] === cl[k]) pScore++; else break; }
    const sufLen = Math.min(3, sl.length, cl.length);
    let sScore = 0;
    for (let k = 1; k <= sufLen; k++) if (sl[sl.length - k] === cl[cl.length - k]) sScore++;
    const lScore = Math.max(0, 5 - Math.abs(sl.length - cl.length));
    const total = pScore * 3 + sScore * 2 + lScore;
    if (total > bestScore) { bestScore = total; best = c; }
  }
  if (best && bestScore >= minScore) return [best, bestScore >= 14];
  return [spoken, false];
}

function resolveSociety(word) {
  const low = word.toLowerCase();
  if (CANONICAL_SOCIETIES.includes(low)) return [low, true];
  if (SOC_ALIASES[low]) return [SOC_ALIASES[low], true];
  const [matched, confident] = ruleMatch(low, CANONICAL_SOCIETIES);
  if (matched !== low) return [matched, confident];
  return [null, false];
}

function splitGluedSociety(word) {
  const low = word.toLowerCase();
  const sorted = [...CANONICAL_SOCIETIES].sort((a, b) => b.length - a.length);
  for (const soc of sorted) {
    if (low.startsWith(soc) && low.length > soc.length) {
      const remainder = word.slice(soc.length);
      if (remainder && /[a-zA-Z0-9]/.test(remainder[0])) return [soc, remainder];
    }
  }
  return [null, null];
}

// ---------------------------------------------------------------------
// Item-name resolution
// ---------------------------------------------------------------------

function buildItemMap(items) {
  const m = {};
  for (const [name, unit] of items) m[name.toLowerCase()] = [name, unit];
  return m;
}

function applyWordAlias(word) {
  return ITEM_WORD_ALIASES[word.toLowerCase()] || word;
}

function resolveItemGreedy(words, j, anchor, itemMap, items) {
  const anchorL = anchor.toLowerCase();
  const nextWord = (j + 1 < words.length ? words[j + 1] : "").toLowerCase();
  if (anchorL === "mango" && !ITEM_ANCHORS.has(nextWord) && !QUALIFIERS.has(nextWord)) {
    return ["Mango", "kg", 1];
  }

  let bestName = null, bestUnit = "kg", bestLen = 1;
  for (let length = 1; length <= Math.min(4, words.length - j); length++) {
    const parts = [anchor.toLowerCase(), ...words.slice(j + 1, j + length).map(w => w.toLowerCase())];
    const candidate = parts.join(" ");
    if (itemMap[candidate]) { [bestName, bestUnit] = itemMap[candidate]; bestLen = length; }
  }
  if (bestName) return [bestName, bestUnit, bestLen];

  if (ANCHOR_DEFAULTS[anchorL]) {
    const def = ANCHOR_DEFAULTS[anchorL];
    if (itemMap[def.toLowerCase()]) { const [n, u] = itemMap[def.toLowerCase()]; return [n, u, 1]; }
  }
  for (const [name, unit] of items) {
    if (name.toLowerCase().includes(anchorL)) return [name, unit, 1];
  }
  return [anchor[0].toUpperCase() + anchor.slice(1).toLowerCase(), "kg", 1];
}

function isQty(w) { return /^\d+\.?\d*$/.test(w); }
function isUnit(w) { return QTY_UNITS.has(w.toLowerCase()); }
function normUnit(w) {
  const low = w.toLowerCase();
  if (["pcs", "pieces", "piece", "nos", "no"].includes(low)) return "pcs";
  if (low === "boxes") return "box";
  return low;
}

function scanItemStart(words, j) {
  if (j >= words.length) return [false, 0, null];
  const w0 = applyWordAlias(words[j]).toLowerCase();
  const w1 = j + 1 < words.length ? applyWordAlias(words[j + 1]).toLowerCase() : "";
  const w2 = j + 2 < words.length ? applyWordAlias(words[j + 2]).toLowerCase() : "";

  if (STOP_WORDS.has(w0) || isQty(words[j]) || isUnit(w0)) return [false, 0, null];

  if (QUALIFIERS.has(w0) && QUALIFIERS.has(w1) && ITEM_ANCHORS.has(w2)) return [true, 3, w2];
  if (QUALIFIERS.has(w0) && ITEM_ANCHORS.has(w1)) return [true, 2, w1];
  if (ITEM_ANCHORS.has(w0) && QUALIFIERS.has(w1) && !ITEM_ANCHORS.has(w1)) {
    const w2isNext = ITEM_ANCHORS.has(w2) || QUALIFIERS.has(w2);
    const w2isQty = j + 2 < words.length ? isQty(words[j + 2]) : false;
    if (!w2isNext || w2isQty) return [true, 2, w0];
  }
  if (ITEM_ANCHORS.has(w0)) return [true, 1, w0];

  if (w0.length >= 4 && !STOP_WORDS.has(w0)) {
    const [matched, confident] = ruleMatch(w0, [...ITEM_ANCHORS], 14);
    if (matched !== w0 && confident) { words[j] = matched; return scanItemStart(words, j); }
  }
  return [false, 0, null];
}

function isDoorEnd(words, j) {
  const [isStart] = scanItemStart(words, j);
  if (isStart) return true;
  if (j < words.length && isQty(words[j]) && isUnit(j + 1 < words.length ? words[j + 1] : "")) return true;
  return false;
}

// ---------------------------------------------------------------------
// pc -> kg conversion
// ---------------------------------------------------------------------

function resolveConversion(itemName) {
  const low = itemName.toLowerCase();
  if (PC_TO_KG[low] !== undefined) return PC_TO_KG[low];
  for (const [key, factor] of Object.entries(PC_TO_KG)) {
    if (low.includes(key)) return factor;
  }
  const firstWord = low.split(" ")[0];
  if (PC_TO_KG[firstWord] !== undefined) return PC_TO_KG[firstWord];
  return null;
}

// ---------------------------------------------------------------------
// Main per-line parse
// ---------------------------------------------------------------------

function parseLine(line, contacts, itemMap, items) {
  let words = normalizeTokens(pretokenize(line));
  if (!words.length) return null;

  let soc = null, socConfident = false, socTokens = 1, gluedRemainder = null;

  const [gluedSoc, gluedDoor] = splitGluedSociety(words[0]);
  if (gluedSoc) { soc = gluedSoc; socConfident = true; gluedRemainder = gluedDoor; }

  if (!soc) { [soc, socConfident] = resolveSociety(words[0]); }

  if (soc === "krishvigavakshi" && words.length > socTokens &&
      ["gavakshi", "gavkshi"].includes(words[socTokens].toLowerCase())) {
    socTokens += 1;
  }
  if (words[0].toLowerCase() === "uber" && words.length > 1 && words[1].toLowerCase() === "phase") {
    let phaseNum = "1", consumed = 2;
    if (words.length > 2 && ["1", "2"].includes(words[2])) { phaseNum = words[2]; consumed = 3; }
    soc = "uberphase" + phaseNum; socConfident = true; socTokens = consumed; gluedRemainder = null;
  }

  if (!soc && words.length > 1) {
    const [soc2, conf2] = resolveSociety(words[0] + words[1]);
    if (soc2) { soc = soc2; socConfident = conf2; socTokens = 2; }
    else {
      const [matched, confident] = ruleMatch(words[0].toLowerCase(), CANONICAL_SOCIETIES);
      if (matched && matched !== words[0].toLowerCase()) { soc = matched; socConfident = confident; }
    }
  }

  if (soc && gluedRemainder === null && words.length > socTokens && words[socTokens].toLowerCase() === "degree") {
    socTokens += 1;
  }
  if (!soc) return { error: true, raw: line };

  let i = socTokens;
  const doorWords = [];
  let doorChars = 0;
  if (gluedRemainder) { doorWords.push(gluedRemainder); doorChars += gluedRemainder.length; }
  while (i < words.length) {
    if (isDoorEnd(words, i)) break;
    const w = words[i];
    if (doorChars + w.length > 9) break;
    doorWords.push(w); doorChars += w.length; i++;
  }
  const door = doorWords.join(" ");
  const rawCust = soc + (door ? " " + door : "");
  const customer = rawCust[0].toUpperCase() + rawCust.slice(1).toLowerCase();
  const isNew = !contacts.some(c => c.toLowerCase() === customer.toLowerCase());

  const remaining = words.slice(i);
  const parsedItems = [];
  let j = 0;
  while (j < remaining.length) {
    const [isStart, nameLen, anchor] = scanItemStart(remaining, j);
    if (!isStart) { j++; continue; }
    const anchorWord = anchor || remaining[j + (nameLen - 1)].toLowerCase();
    const anchorIdx = j + (nameLen - 1);
    const [name, unit, consumed] = resolveItemGreedy(remaining, anchorIdx, anchorWord, itemMap, items);
    j = anchorIdx + consumed;

    let qty = "", finalUnit = unit;
    const descParts = [];
    while (j < remaining.length) {
      const [isNext] = scanItemStart(remaining, j);
      if (isNext) break;
      const w2 = remaining[j];
      if (isQty(w2) && !qty) qty = w2;
      else if (isUnit(w2)) finalUnit = normUnit(w2);
      else if (!STOP_WORDS.has(w2.toLowerCase())) descParts.push(w2);
      j++;
    }

    let warn = false;
    const warnReasons = [];
    let finalQty = qty;

    if (name === "Mango") {
      warn = true;
      warnReasons.push("no mango variety specified — please confirm (Kesar/Langra/Banganapalli/etc.)");
    }

    if (finalUnit === "pcs" && qty) {
      const factor = resolveConversion(name);
      if (factor !== null) {
        finalQty = String(Math.round(parseFloat(qty) * factor * 10000) / 10000);
      } else {
        descParts.push(qty + " pieces");
        finalQty = qty;
        warn = true;
        warnReasons.push("no kg conversion on file for this item in pieces");
      }
    }

    parsedItems.push({
      item: name,
      description: descParts.join(", "),
      quantity: finalQty,
      warn,
      warnReason: warnReasons.join("; ") || null,
    });
  }

  return { customer, isNew, socConfident, items: parsedItems };
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

function parseOrders(rawText, contacts, items, orderDate) {
  orderDate = orderDate || new Date().toISOString().slice(0, 10);
  const itemMap = buildItemMap(items);
  const rows = [];

  for (const line of rawText.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseLine(line, contacts, itemMap, items);
    if (!parsed) continue;

    if (parsed.error) {
      rows.push({
        orderDate, customer: parsed.raw.trim(), item: "",
        description: "unrecognized society/line — needs manual review",
        quantity: "", salesOrderId: "", warn: true,
        warnReason: "unrecognized society", isNewCustomer: false,
      });
      continue;
    }

    const customer = parsed.customer;
    const salesOrderId = orderDate + customer.split(" ").join("");
    for (const it of parsed.items) {
      const warn = it.warn || parsed.isNew || !parsed.socConfident;
      const reasons = [];
      if (it.warnReason) reasons.push(it.warnReason);
      if (parsed.isNew) reasons.push("new customer (not found in contacts master list)");
      if (!parsed.socConfident) reasons.push("society name guessed via fuzzy match — verify");
      rows.push({
        orderDate, customer, item: it.item, description: it.description,
        quantity: it.quantity, salesOrderId, warn,
        warnReason: reasons.join("; ") || null, isNewCustomer: parsed.isNew,
      });
    }
  }
  return rows;
}

// Override the built-in society list at runtime (e.g. after loading from Supabase).
// canonicals: string[] of lowercase canonical names
// aliasMap: { spoken_form: canonical_name, ... }
function setSocieties(canonicals, aliasMap) {
  CANONICAL_SOCIETIES = canonicals.map(s => s.toLowerCase());
  SOC_ALIASES = aliasMap || {};
}

// Expose for reuse in Node scripts (browser <script> tag usage is unaffected).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    get CANONICAL_SOCIETIES() { return CANONICAL_SOCIETIES; },
    get SOC_ALIASES() { return SOC_ALIASES; },
    resolveSociety, splitGluedSociety, ruleMatch, parseOrders, parseLine, setSocieties,
  };
}
