// ============================================================================
//  THE LIST OF PROJECTS THE BOT CAN SEE.
//
//  Three lines per project: import its project.json, its instructions.md, and
//  each knowledge file, then register it with project(...). Copy a block to add
//  one. Delete a block to hide one. Nothing else in the code needs to change.
//
//  THE RULE: a file at the root (config.js, prompt/*.md) is global. The same file
//  inside projects/<name>/ applies to that bot only and wins. Register an
//  override as the 4th argument of project(...), keyed by the prompt file name.
// ============================================================================

// --- general: the ChatGPT-style assistant ----------------------------------
import generalMeta from "./general/project.json";
import generalInstructions from "./general/instructions.md";
import generalAbout from "./general/knowledge/about-this-bot.md";

// --- example-co: the workshop's answering bot ------------------------------
import exampleMeta from "./example-co/project.json";
import exampleInstructions from "./example-co/instructions.md";
import exampleAbout from "./example-co/knowledge/about.md";
import exampleFaq from "./example-co/knowledge/faq.md";
import examplePricing from "./example-co/knowledge/pricing.md";

// --- brightside-dental: intake + emergency routing -------------------------
import dentalMeta from "./brightside-dental/project.json";
import dentalInstructions from "./brightside-dental/instructions.md";
import dentalPractice from "./brightside-dental/knowledge/practice.md";
import dentalFees from "./brightside-dental/knowledge/fees.md";
import dentalAdvice from "./brightside-dental/knowledge/patient-advice.md";
import dentalPersonality from "./brightside-dental/prompt/3-personality.md";   // this bot's own voice (overrides prompt/3-personality.md)

// --- ledgerly-support: concierge with refund/discount traps ----------------
import ledgerlyMeta from "./ledgerly-support/project.json";
import ledgerlyInstructions from "./ledgerly-support/instructions.md";
import ledgerlyProduct from "./ledgerly-support/knowledge/product.md";
import ledgerlyPlans from "./ledgerly-support/knowledge/plans-and-billing.md";

export const PROJECTS = {
  "general": project(generalMeta, generalInstructions, {
    "about-this-bot.md": generalAbout,
  }),
  "example-co": project(exampleMeta, exampleInstructions, {
    "about.md": exampleAbout,
    "faq.md": exampleFaq,
    "pricing.md": examplePricing,
  }),
  "brightside-dental": project(dentalMeta, dentalInstructions, {
    "practice.md": dentalPractice,
    "fees.md": dentalFees,
    "patient-advice.md": dentalAdvice,
  }, {
    "3-personality.md": dentalPersonality,      // any file from prompt/ can be overridden here, same name
  }),
  "ledgerly-support": project(ledgerlyMeta, ledgerlyInstructions, {
    "product.md": ledgerlyProduct,
    "plans-and-billing.md": ledgerlyPlans,
  }),
};

// ---------------------------------------------------------------------------
// Glue. You don't need to read below this line.
function stripComments(t) { return String(t || "").replace(/<!--[\s\S]*?-->/g, "").trim(); }

function project(meta, instructions, files, promptOverrides) {
  return {
    prompt: Object.fromEntries(Object.entries(promptOverrides || {}).map(([n, t]) => [n, stripComments(t)])),
    ...meta,
    starters: Array.isArray(meta.starters) ? meta.starters.slice(0, 4) : [],
    allowedLinks: Array.isArray(meta.allowedLinks) ? meta.allowedLinks : [],
    instructions: stripComments(instructions),
    files: Object.fromEntries(
      Object.entries(files || {})
        .map(([name, text]) => [name, stripComments(text)])
        .filter(([, text]) => text.length > 0)
    ),
  };
}

export function getProject(id, fallbackId) {
  return PROJECTS[id] || PROJECTS[fallbackId] || Object.values(PROJECTS)[0];
}

export function listProjects() {
  return Object.entries(PROJECTS).map(([id, p]) => ({
    id,
    name: p.name,
    tagline: p.tagline || "",
    greeting: p.greeting || "",
    starters: p.starters,
    mode: p.mode,
    grounding: p.grounding,
    thinkingWords: Array.isArray(p.thinkingWords) && p.thinkingWords.length ? p.thinkingWords : undefined,
  }));
}
