/**
 * n8n Webhook Handler
 *
 * Mount this as a route in server.js if you want n8n to push
 * scheduled triggers, reminders, or digest messages into the brain.
 *
 * In n8n: use an HTTP Request node to POST to http://localhost:3000/api/n8n
 * with a JSON body: { "event": "daily_digest" } or { "event": "reminder", "note": "..." }
 *
 * To activate: add this line to server.js:
 *   const n8nRouter = require('./routes/n8n');
 *   app.use('/api/n8n', n8nRouter);
 */

const express = require("express");
const router = express.Router();
const { loadContext } = require("../services/contextLoader");
const { interpret } = require("../services/interpreter");
const { executeActions } = require("../services/actionExecutor");
const { appendJournal } = require("../utils/journal");

// POST /api/n8n
router.post("/", async (req, res) => {
  const { event, note } = req.body;

  // Build a synthetic message based on event type
  let syntheticMessage = "";

  switch (event) {
    case "daily_digest":
      syntheticMessage = "Give me a quick summary of open tasks and anything I should focus on today.";
      break;
    case "reminder":
      syntheticMessage = note || "Remind me of anything urgent or overdue.";
      break;
    case "weekly_review":
      syntheticMessage = "It's end of week. Summarize what was done, what's pending, and suggest priorities for next week.";
      break;
    default:
      syntheticMessage = note || `System event received: ${event}`;
  }

  try {
    const context = await loadContext();
    const { reply, actions } = await interpret(syntheticMessage, context);
    const executionLog = await executeActions(actions);
    await appendJournal({ message: `[n8n:${event}] ${syntheticMessage}`, reply, actions, executionLog });

    res.json({ reply, actions, executionLog });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
