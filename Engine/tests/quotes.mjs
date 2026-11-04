// ============================================================================
//  QUOTES — proves Engine/worker/quotes.js does what docs/CUSTOMIZE.md →
//  "Motivational quotes" says. Pure functions, no server, no model:
//
//      node Engine/tests/quotes.mjs
//
//  Exit code 0 = every check passed; 1 = something failed.
// ============================================================================
import { fillQuote, cleanQuotes, mergeQuotes, pickQuote, quotesFileView, QUOTES_BUILT_IN } from "../worker/quotes.js";

let failed = 0;
const eq = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`); if (!ok) failed++; };

// --- ${name} with a name: first name only, wherever it sits
eq("name at the end", fillQuote("Keep going, ${name}.", "Jim Tyrrell"), "Keep going, Jim.");
eq("name at the start", fillQuote("${name}, start today.", "Amy"), "Amy, start today.");
eq("name twice", fillQuote("${name}, this is for you, ${name}.", "Amy"), "Amy, this is for you, Amy.");
eq("spaces inside the braces", fillQuote("Hi ${ name }!", "Amy"), "Hi Amy!");
eq("capital N is the same placeholder", fillQuote("Hi ${Name}!", "Amy"), "Hi Amy!");
eq("no placeholder: untouched", fillQuote("Well done is better than well said.", "Amy"), "Well done is better than well said.");

// --- no name, a fallback word
eq("fallback word", fillQuote("Keep going, ${name}.", "", "friend"), "Keep going, friend.");
eq("a name beats the fallback", fillQuote("Keep going, ${name}.", "Amy", "friend"), "Keep going, Amy.");
eq("fallback opening a sentence takes a capital", fillQuote("${name}, start today. Yes, ${name}.", "", "friend"), "Friend, start today. Yes, friend.");
eq("fallback after a full stop takes a capital", fillQuote("Well said. ${name}, go.", "", "pal"), "Well said. Pal, go.");

// --- no name, no fallback: dropped and tidied
eq("end of sentence, comma before", fillQuote("Keep going, ${name}.", ""), "Keep going.");
eq("end of sentence, no comma", fillQuote("Hi ${name}!", ""), "Hi!");
eq("end of string, no punctuation", fillQuote("Thanks ${name}", ""), "Thanks");
eq("start of sentence, capitalised", fillQuote("${name}, start today.", ""), "Start today.");
eq("start of a later sentence", fillQuote("Well said. ${name}, go and do it.", ""), "Well said. Go and do it.");
eq("vocative in the middle", fillQuote("Welcome, ${name}, to the show.", ""), "Welcome to the show.");
eq("mid-sentence, no commas", fillQuote("Keep going ${name} and do not stop.", ""), "Keep going and do not stop.");
eq("the shipped shape", fillQuote("“Well done is better than well said.” — Benjamin Franklin. Go do one thing well today, ${name}.", ""), "“Well done is better than well said.” — Benjamin Franklin. Go do one thing well today.");
eq("name with a semicolon tail", fillQuote("Begin badly, ${name}; begin anyway.", ""), "Begin badly; begin anyway.");

// --- cleaning a layer
eq("not an object → null", cleanQuotes(null), null);
eq("empty list keeps the base list", cleanQuotes({ list: [] }).list, QUOTES_BUILT_IN.list);
eq("blank lines are dropped, whitespace squashed", cleanQuotes({ list: ["  a   b ", "", "   ", "c"] }).list, ["a b", "c"]);
eq("show false sticks", cleanQuotes({ show: false }).show, false);
eq("show missing inherits", cleanQuotes({ list: ["x"] }).show, true);
eq("fallback trimmed and capped", cleanQuotes({ fallback: "  friend  " }).fallback, "friend");
eq("people: emails lowered, bad ones dropped, empty lists dropped", cleanQuotes({ people: { "Amy@Example.com": ["Go, ${name}!"], "not-an-email": ["x"], "b@example.com": [] } }).people, { "amy@example.com": ["Go, ${name}!"] });
eq("people missing inherits the base people", cleanQuotes({ list: ["x"] }, { ...QUOTES_BUILT_IN, people: { "a@b.co": ["y"] } }).people, { "a@b.co": ["y"] });
eq("people given replaces whole", cleanQuotes({ people: {} }, { ...QUOTES_BUILT_IN, people: { "a@b.co": ["y"] } }).people, {});

// --- the merge: config < file < saved
const merged = mergeQuotes({ list: ["from config"] }, { fallback: "pal" }, { people: { "amy@example.com": ["Amy's own, ${name}"] } });
eq("merge: list from config survives", merged.list, ["from config"]);
eq("merge: fallback from the file survives", merged.fallback, "pal");
eq("merge: people from the saved row", Object.keys(merged.people), ["amy@example.com"]);
eq("merge: source is the last layer that said anything", merged.source, "saved (Settings screen)");
eq("merge: nothing anywhere → built-in", mergeQuotes(null, null, null).source, "built-in");

// --- the pick
const q = { show: true, fallback: "", list: ["one, ${name}", "two, ${name}"], people: { "amy@example.com": ["Amy only, ${name}"] } };
eq("nobody → the shared list, first pick", pickQuote(q, {}, () => 0), { text: "one, ${name}", filled: "one", fallback: "", own: false });
eq("nobody → the shared list, last pick", pickQuote(q, {}, () => 0.99).text, "two, ${name}");
eq("a stranger with a name → the shared list, named", pickQuote(q, { email: "bob@example.com", name: "Bob Smith" }, () => 0).filled, "one, Bob");
eq("the person → their own list", pickQuote(q, { email: "Amy@Example.com", name: "Amy" }, () => 0.5), { text: "Amy only, ${name}", filled: "Amy only, Amy", fallback: "", own: true });
eq("show off → nothing", pickQuote({ ...q, show: false }, { email: "amy@example.com" }), null);
eq("no lines anywhere → nothing", pickQuote({ show: true, list: [], people: {} }, {}), null);
eq("fallback rides along for the page", pickQuote({ ...q, fallback: "friend" }, {}, () => 0).filled, "one, friend");

// --- what the file gets: no people
eq("file view carries no email addresses", quotesFileView(q), { show: true, fallback: "", list: q.list });

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
