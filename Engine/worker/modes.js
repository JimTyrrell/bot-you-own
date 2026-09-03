// ============================================================================
//  THE JOBS (modes) — loader
//
//  Each job is a plain Markdown file in prompt/jobs/<mode>.md with three
//  headings: "# Role", "# What a good answer looks like", "# Done when".
//  A project picks one with "mode" in its project.json. One project = one job.
//  Want two jobs? Make two projects.
//
//  Adding a job: add a file to prompt/jobs/. That's it — scripts/discover.mjs
//  registers it at build. Mode-specific extras (intake questions, booking rules,
//  next steps) come from the project's project.json.
// ============================================================================

import { JOB_FILES } from "./jobs.generated.js";

const BLURBS = {
  assistant: "The ChatGPT-style clone. Helps with anything; uses the files first when they apply.",
  answer: "Answers the question you get eleven times a week. Start here.",
  intake: "Asks the questions you always ask before you can quote, then hands you a clean summary.",
  booking: "Works out whether a call makes sense, then sends the right people to your calendar.",
  concierge: "Answers the question, then points at the right next thing you offer.",
  internal: "Answers for your TEAM, not your customers. Policies, SOPs, how we do things here.",
  imported: "You had a custom GPT or a Project. Now it's yours, on your own infrastructure.",
};

export const MODES = Object.fromEntries(
  Object.entries(JOB_FILES).map(([id, md]) => [id, { id, label: id, blurb: BLURBS[id] || "", file: `YourBots/_prompt/jobs/${id}.md`, ...parseJob(md) }])
);

export function modeBlock(project) {
  const base = MODES[project.mode] || MODES.answer;
  const own = project.prompt?.[`jobs/${project.mode}.md`];   // YourBots/<name>/prompt/jobs/<mode>.md
  const mode = own ? { ...base, ...parseJob(own) } : base;
  const extras = [];
  if (project.mode === "intake" && project.intakeQuestions?.length) {
    extras.push(`What to collect, in this order, one at a time:\n` + project.intakeQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n"));
  }
  if (project.mode === "booking") {
    if (project.bookingFitRules) extras.push(`Who a call is for:\n${project.bookingFitRules}`);
    if (project.bookingUrl) extras.push(`The booking link: ${project.bookingUrl}`);
  }
  if (project.mode === "concierge" && project.nextSteps?.length) {
    extras.push(`What you may point people at:\n` + project.nextSteps.map((s) => `- ${s.name} — for ${s.who}. ${s.link || "(no link)"}`).join("\n"));
  }
  return `${mode.role}\n\nWhat a good answer looks like:\n${mode.shape}${extras.length ? "\n\n" + extras.join("\n\n") : ""}`;
}

// "# Role" / "# What a good answer looks like" / "# Done when" → { role, shape, done }
function parseJob(md) {
  const out = { role: "", shape: "", done: "" };
  const parts = String(md || "").replace(/<!--[\s\S]*?-->/g, "").split(/^#\s+/m).map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const heading = (nl < 0 ? part : part.slice(0, nl)).trim().toLowerCase();
    const body = nl < 0 ? "" : part.slice(nl + 1).trim();
    if (heading.startsWith("role")) out.role = body;
    else if (heading.startsWith("what a good answer")) out.shape = body;
    else if (heading.startsWith("done")) out.done = body;
  }
  return out;
}
