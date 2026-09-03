# Projects — this folder is your bot's brain

A **project** is exactly what ChatGPT calls a Project (and what a custom GPT was):
a set of **instructions**, some **files**, and a few **starter prompts**. One folder each.

```
projects/
  your-project/
    project.json       ← name, greeting, starters, which job it does, the links it may share
    instructions.md    ← what you'd have typed into the Instructions box in ChatGPT
    knowledge/         ← what you'd have uploaded as files (Markdown / plain text)
      about.md
      faq.md
      pricing.md
  index.js             ← the list of projects the bot can see (3 lines per project)
```

**Everything your bot knows is in `knowledge/`. In `strict` mode it is not allowed
to say anything that isn't.** In `open` mode it behaves like ChatGPT and uses the
files as its first source.

## Make your own (five minutes)
1. Copy `_template/` to a new folder, e.g. `my-shop/`.
2. Fill in `project.json`. The important fields are `mode`, `grounding`,
   `allowedLinks` and `handoffContact`. `thinkingWords` is the fun one: what the
   page says while it waits for the first word ("Checking the files", "One moment"…).
   Any number of them; leave it out to use the list in `config.js`.
3. Paste your instructions into `instructions.md` — **raw**, don't tidy them.
4. Put your material in `knowledge/`. The best material is the emails you've
   already written answering the same question for the tenth time.
5. Add it to `index.js` (copy an existing block, change the folder name).
6. Set `defaultProject: "my-shop"` in `config.js`. Commit. Done.

## The samples
| Folder | Job | Grounding | What it's testing |
|---|---|---|---|
| `general` | a ChatGPT-style general assistant | `open` | the "clone": tone, formatting, honesty about no tools |
| `example-co` | answer bot for a machine-servicing firm | `strict` | the workshop's Hire #1. Handoff instead of guessing |
| `brightside-dental` | intake bot for a dental practice | `strict` | one question at a time, emergency routing, no invented prices |
| `ledgerly-support` | concierge for a bookkeeping SaaS | `strict` | refund/discount traps, answer-before-pitch, link allowlist |

Delete the ones you don't need from `index.js` before you go live. Leaving the
folders costs nothing.

⚠️ **Don't put anything in `knowledge/` you wouldn't put on your website.** Assume
every word can be read by anyone who talks to the bot. Ownership changes who
controls it; it doesn't make text unreadable.
