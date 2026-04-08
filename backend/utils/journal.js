const fs = require("fs").promises;
const path = require("path");

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const JOURNAL_PATH = path.join(DATA_DIR, "journal.md");

/**
 * appendJournal({ message, reply, actions, executionLog })
 * Appends a timestamped entry to journal.md.
 */
async function appendJournal({ message, reply, actions, executionLog }) {
  const now = new Date().toISOString();
  const actionSummary = actions.length > 0
    ? actions.map(a => `- ${a.type}`).join("\n")
    : "- (no actions)";

  const entry = `
---
## ${now}

**User:** ${message}

**Reply:** ${reply}

**Actions:**
${actionSummary}

**Execution log:**
\`\`\`json
${JSON.stringify(executionLog, null, 2)}
\`\`\`
`.trim();

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(JOURNAL_PATH, "\n\n" + entry, "utf-8");
}

module.exports = { appendJournal };
