const axios   = require("axios");
const { loadContext }    = require("./contextLoader");
const { run }            = require("./orchestrator");
const { executeActions } = require("./actionExecutor");
const { appendJournal }  = require("../utils/journal");
const { readJson, writeJson } = require("../utils/storage");

const TOKEN         = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID       = process.env.TELEGRAM_CHAT_ID?.toString();
const SESSION_LIMIT = 25;

// Persistent reply keyboard — always visible above the text input
const PERSISTENT_KEYBOARD = {
  keyboard: [
    [{ text: "Tasks" }, { text: "Focus" }],
    [{ text: "Projects" }, { text: "People" }],
  ],
  resize_keyboard: true,
  persistent: true,
};

// Map keyboard button labels to slash commands
const KEYBOARD_MAP = {
  "tasks":    "/tasks",
  "focus":    "/today",
  "projects": "/projects",
  "people":   "/people",
};

// Action types that are data writes (require confirmation)
const DATA_ACTION_TYPES = new Set([
  "ADD_TASK", "UPDATE_TASK",
  "ADD_PROJECT", "UPDATE_PROJECT",
  "ADD_PERSON", "UPDATE_PERSON",
]);

// Action types that are conversation meta (execute immediately, no confirmation needed)
const META_ACTION_TYPES = new Set(["ASK", "CLEAR_ASK"]);

let offset = 0;

async function sendReply(text) {
  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id:      CHAT_ID,
    text,
    parse_mode:   "Markdown",
    reply_markup: PERSISTENT_KEYBOARD,
  });
}

async function sendQuestion(text) {
  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id:    CHAT_ID,
    text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[{ text: "Skip", callback_data: "skip_inquiry" }]],
    },
  });
}

async function sendConfirmPrompt(text) {
  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id:    CHAT_ID,
    text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[
        { text: "Confirm ✓", callback_data: "confirm_actions" },
        { text: "Cancel ✗",  callback_data: "cancel_actions"  },
      ]],
    },
  });
}

async function sendTyping() {
  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendChatAction`, {
    chat_id: CHAT_ID,
    action:  "typing",
  }).catch(() => {});
}

// ── SLASH COMMANDS ──────────────────────────────────────────────────────────

async function handleSlashCommand(cmd, fullText) {
  if (cmd === "/today") {
    const memory   = await readJson("memory.json");
    const today    = new Date().toISOString().split("T")[0];
    const now      = new Date(); now.setHours(0,0,0,0);
    const tasks    = (memory?.entries || []).filter(t => t.status !== "done");
    const overdue  = tasks.filter(t => t.dueDate && new Date(t.dueDate) < now);
    const dueToday = tasks.filter(t => t.dueDate && t.dueDate.split("T")[0] === today);
    const dueWeek  = tasks.filter(t => {
      if (!t.dueDate) return false;
      const d = new Date(t.dueDate);
      const diff = Math.round((d - now) / 86400000);
      return diff > 0 && diff <= 7;
    });

    let lines = ["*Today's focus*\n"];
    if (overdue.length)  lines.push(`⚠️ *Overdue*\n${overdue.map(t => `• ${t.title}`).join("\n")}`);
    if (dueToday.length) lines.push(`🔴 *Due today*\n${dueToday.map(t => `• ${t.title}`).join("\n")}`);
    if (dueWeek.length)  lines.push(`🔵 *This week*\n${dueWeek.map(t => `• ${t.title} _(${Math.round((new Date(t.dueDate)-now)/86400000)}d)_`).join("\n")}`);
    if (lines.length === 1) lines.push("Nothing urgent. Good.");
    await sendReply(lines.join("\n\n"));
    return;
  }

  if (cmd === "/tasks") {
    const memory = await readJson("memory.json");
    const tasks  = (memory?.entries || []).filter(t => t.status !== "done");
    if (!tasks.length) { await sendReply("No open tasks."); return; }

    const now = new Date(); now.setHours(0,0,0,0);
    const keyboard = tasks.map(t => {
      const overdue = t.dueDate && new Date(t.dueDate) < now;
      const label   = (overdue ? "⚠️ " : "") + (t.title.length > 42 ? t.title.slice(0, 41) + "…" : t.title);
      return [{ text: label, callback_data: `task:${t.id}` }];
    });

    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id:      CHAT_ID,
      text:         `*Tasks (${tasks.length} open)* — tap one for details`,
      parse_mode:   "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
    return;
  }

  if (cmd === "/projects") {
    const projects = await readJson("projects.json");
    const active   = (projects?.projects || []).filter(p => !p.archived);
    if (!active.length) { await sendReply("No active projects."); return; }

    const keyboard = active.map(p => {
      const blocked = Array.isArray(p.blockers) && p.blockers.filter(Boolean).length > 0;
      const label   = (blocked ? "🔴 " : "") + (p.name.length > 42 ? p.name.slice(0, 41) + "…" : p.name);
      return [{ text: label, callback_data: `project:${p.id}` }];
    });

    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id:      CHAT_ID,
      text:         `*Projects (${active.length})* — tap one for details`,
      parse_mode:   "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
    return;
  }

  if (cmd === "/people") {
    const people = await readJson("people.json");
    const list   = people?.people || [];
    if (!list.length) { await sendReply("No people tracked yet."); return; }

    const keyboard = list.map(p => {
      const label = p.name + (p.relationship ? ` (${p.relationship})` : "");
      return [{ text: label.length > 45 ? label.slice(0, 44) + "…" : label, callback_data: `person:${p.id}` }];
    });

    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id:      CHAT_ID,
      text:         `*People (${list.length})* — tap one for details`,
      parse_mode:   "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
    return;
  }

  if (cmd === "/briefing") {
    const dailyBriefing = require("./dailyBriefing");
    const hour = new Date().getHours();
    const type = hour < 14 ? "morning" : "evening";
    await sendReply(`_Running ${type} briefing…_`);
    await dailyBriefing.run(type);
    return;
  }

  if (cmd === "/help") {
    await sendReply(
      "*engine. — commands*\n\n" +
      "/today — overdue + due today + this week\n" +
      "/tasks — all open tasks by project\n" +
      "/projects — active projects + blockers\n" +
      "/people — everyone tracked\n" +
      "/briefing — run morning or evening briefing now\n" +
      "/health — system status\n" +
      "/fresh — wipe all memory (requires confirm)\n\n" +
      "_Anything else → just talk naturally._"
    );
    return;
  }

  if (cmd === "/health") {
    const { healthCheck } = require("./qdrantSync");
    const [memory, projects, people, watcher, session] = await Promise.all([
      readJson("memory.json"),
      readJson("projects.json"),
      readJson("people.json"),
      readJson("watcherState.json"),
      readJson("sessionContext.json"),
    ]);
    const qdrantOk  = await healthCheck();
    const tasks     = (memory?.entries || []);
    const open      = tasks.filter(t => t.status !== "done").length;
    const done      = tasks.filter(t => t.status === "done").length;
    const now       = new Date(); now.setHours(0,0,0,0);
    const overdue   = tasks.filter(t => t.status !== "done" && t.dueDate && new Date(t.dueDate) < now).length;
    const active    = (projects?.projects || []).filter(p => !p.archived).length;
    const people_n  = (people?.people || []).length;
    const history_n = (session?.history || []).length;
    const lastRun   = watcher?.lastRun ? new Date(watcher.lastRun).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "never";
    const cooldowns = Object.keys(watcher?.notified || {}).length;
    await sendReply([
      "*engine. — health*\n",
      `• Qdrant: ${qdrantOk ? "✅ ok" : "❌ unreachable"}`,
      `• Tasks: ${open} open, ${done} done${overdue ? `, ⚠️ ${overdue} overdue` : ""}`,
      `• Projects: ${active} active`,
      `• People: ${people_n} tracked`,
      `• Session: ${history_n} turns`,
      `• Watcher last run: ${lastRun}`,
      `• Active cooldowns: ${cooldowns}`,
    ].join("\n"));
    return;
  }

  if (cmd === "/fresh") {
    const confirmed = fullText.trim().toLowerCase() === "/fresh confirm";
    if (!confirmed) {
      await sendReply(
        "*engine. — fresh start*\n\n" +
        "This will permanently wipe:\n" +
        "• All tasks, projects, people\n" +
        "• All conversation history\n" +
        "• All Qdrant vectors\n\n" +
        "Send `/fresh confirm` to proceed."
      );
      return;
    }
    await sendReply("_Wiping everything…_");
    const { resetCollections } = require("./qdrantSync");
    await Promise.all([
      writeJson("memory.json",         { entries: [] }),
      writeJson("projects.json",       { projects: [] }),
      writeJson("people.json",         { people: [] }),
      writeJson("sessionContext.json", { history: [] }),
      writeJson("pendingInquiry.json", null),
      writeJson("pendingActions.json", null),
      writeJson("watcherState.json",   { notified: {}, lastRun: null }),
    ]);
    await resetCollections();
    await sendReply("*engine. — fresh start*\n\nAll clear. Start talking.");
    return;
  }

  return false;
}

// ── CALLBACK QUERY HANDLER ───────────────────────────────────────────────────

async function handleCallbackQuery(callbackQuery) {
  // Acknowledge immediately to remove loading state on the button
  await axios.post(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
    callback_query_id: callbackQuery.id,
  }).catch(() => {});

  if (callbackQuery.data === "skip_inquiry") {
    await writeJson("pendingInquiry.json", null);
    await sendReply("_Skipped._");
    return;
  }

  if (callbackQuery.data === "confirm_actions") {
    const pending = await readJson("pendingActions.json");
    if (!pending) {
      await sendReply("_Nothing pending._");
      return;
    }
    await writeJson("pendingActions.json", null);

    const { dataActions, metaActions, message, projectNames, reply } = pending;

    // Execute data actions first, then meta
    const allActions = [...(dataActions || []), ...(metaActions || [])];
    await executeActions(allActions, message, projectNames);
    await appendJournal({ message, reply, actions: allActions });

    // Send any follow-up question that was deferred
    const inquiry = await readJson("pendingInquiry.json");
    if (inquiry?.question) {
      await sendQuestion(`_${inquiry.question}_`);
    } else {
      await sendReply("_Done._");
    }
    return;
  }

  if (callbackQuery.data === "cancel_actions") {
    await writeJson("pendingActions.json", null);
    await sendReply("_Cancelled._");
    return;
  }

  if (callbackQuery.data.startsWith("project:")) {
    const projectId = callbackQuery.data.slice(8);
    const projects  = await readJson("projects.json");
    const p         = (projects?.projects || []).find(p => p.id === projectId);
    if (!p) { await sendReply("Project not found."); return; }

    const blockers = Array.isArray(p.blockers) ? p.blockers.filter(Boolean) : [];
    const tasks    = await readJson("memory.json");
    const linked   = (tasks?.entries || []).filter(t => t.project === p.name && t.status !== "done");

    const lines = [
      `*${p.name}*`,
      ``,
      p.status    ? `⚙️  Status: ${p.status}${p.health ? ` · ${p.health}` : ""}`  : null,
      p.deadline  ? `📅  Deadline: ${p.deadline}`                                   : null,
      p.nextAction? `➡️  Next: ${p.nextAction}`                                     : null,
      blockers.length ? `\n⚠️  *Blockers*\n${blockers.map(b => `• ${b}`).join("\n")}` : null,
      p.members?.length ? `\n👥  ${p.members.join(", ")}`                           : null,
      linked.length ? `\n📋  *Open tasks (${linked.length})*\n${linked.map(t => `• ${t.title}`).join("\n")}` : null,
      p.goals?.length ? `\n🎯  *Goals*\n${(Array.isArray(p.goals) ? p.goals : [p.goals]).map(g => `• ${g}`).join("\n")}` : null,
    ].filter(l => l !== null);

    await sendReply(lines.join("\n"));
    return;
  }

  if (callbackQuery.data.startsWith("person:")) {
    const personId = callbackQuery.data.slice(7);
    const people   = await readJson("people.json");
    const p        = (people?.people || []).find(p => p.id === personId);
    if (!p) { await sendReply("Person not found."); return; }

    const lines = [
      `*${p.name}*`,
      ``,
      p.relationship  ? `🤝  ${p.relationship}`                              : null,
      p.role          ? `💼  ${p.role}`                                      : null,
      p.lastContact   ? `📞  Last contact: ${p.lastContact}`                 : null,
      p.nextMeeting   ? `📅  Next meeting: ${p.nextMeeting}`                 : null,
      p.lastMentioned ? `🕐  Last mentioned: ${p.lastMentioned}`             : null,
      p.projects?.length ? `\n📁  ${p.projects.join(", ")}`                  : null,
      p.notes         ? `\n${p.notes}`                                       : null,
    ].filter(l => l !== null);

    await sendReply(lines.join("\n"));
    return;
  }

  if (callbackQuery.data.startsWith("task:")) {
    const taskId = callbackQuery.data.slice(5);
    const memory = await readJson("memory.json");
    const task   = (memory?.entries || []).find(t => t.id === taskId);
    if (!task) { await sendReply("Task not found."); return; }

    const now = new Date(); now.setHours(0,0,0,0);
    const overdue = task.dueDate && new Date(task.dueDate) < now;
    const daysUntil = task.dueDate ? Math.round((new Date(task.dueDate) - now) / 86400000) : null;

    const lines = [
      `*${task.title}*`,
      ``,
      task.project  ? `📁  ${task.project}`                                              : null,
      task.priority ? `🔺  Priority: ${task.priority}`                                   : null,
      task.status   ? `⚙️  Status: ${task.status}`                                       : null,
      task.dueDate  ? `📅  Due: ${task.dueDate}${overdue ? " ⚠️ overdue" : daysUntil !== null ? ` (${daysUntil}d)` : ""}` : null,
      task.effort   ? `⏱  Effort: ${task.effort}`                                        : null,
      task.outcome  ? `\n🎯  _${task.outcome}_`                                          : null,
      task.notes    ? `\n${task.notes}`                                                   : null,
    ].filter(l => l !== null);

    await sendReply(lines.join("\n"));
    return;
  }
}

// ── MESSAGE HANDLER ─────────────────────────────────────────────────────────

async function handleMessage(text) {
  if (!text?.trim()) return;

  // Map persistent keyboard buttons to their slash commands
  const mappedCmd = KEYBOARD_MAP[text.trim().toLowerCase()];
  if (mappedCmd) {
    try {
      await handleSlashCommand(mappedCmd, mappedCmd);
    } catch (err) {
      console.error("[telegramBot] keyboard button error:", err.message);
      await sendReply("Something went wrong. Try again.");
    }
    return;
  }

  // Handle slash commands
  if (text.startsWith("/")) {
    const cmd = text.split(" ")[0].toLowerCase();
    try {
      const handled = await handleSlashCommand(cmd, text);
      if (handled !== false) return;
    } catch (err) {
      console.error("[telegramBot] slash command error:", err.message);
      await sendReply("Something went wrong. Try again.");
      return;
    }
  }

  // Discard any previously unconfirmed actions — new message supersedes them
  await writeJson("pendingActions.json", null);

  sendTyping();
  const typingInterval = setInterval(sendTyping, 4000);

  try {
    const context = await loadContext(text);
    const { reply, actions } = await run(text, context);
    const projectNames = (context.projects?.projects || []).map(p => p.name);

    // Split actions into data writes vs conversation meta
    const dataActions = actions.filter(a => DATA_ACTION_TYPES.has(a.type));
    const metaActions = actions.filter(a => META_ACTION_TYPES.has(a.type));

    // Update session history immediately (conversation state, not business data)
    const session = await readJson("sessionContext.json");
    const history = session.history || [];
    history.push({ ts: new Date().toISOString(), user: text, assistant: reply });
    if (history.length > SESSION_LIMIT) history.splice(0, history.length - SESSION_LIMIT);
    await writeJson("sessionContext.json", { history });

    clearInterval(typingInterval);

    if (dataActions.length > 0) {
      // Store actions for confirmation — do NOT execute yet
      await writeJson("pendingActions.json", {
        dataActions,
        metaActions,
        message:      text,
        projectNames,
        reply,
        ts:           new Date().toISOString(),
      });
      await sendConfirmPrompt(reply);
    } else {
      // No data changes — execute meta actions immediately and reply normally
      await executeActions(metaActions, text, projectNames);
      await appendJournal({ message: text, reply, actions: metaActions });
      await sendReply(reply);

      // Send any follow-up question
      const inquiry = await readJson("pendingInquiry.json");
      if (inquiry?.question) {
        await sendQuestion(`_${inquiry.question}_`);
      }
    }
  } catch (err) {
    clearInterval(typingInterval);
    console.error("[telegramBot] handleMessage error:", err.message);
    await sendReply("Something went wrong. Try again.");
  }
}

async function poll() {
  try {
    const res = await axios.get(`https://api.telegram.org/bot${TOKEN}/getUpdates`, {
      params: { offset, timeout: 10, allowed_updates: ["message", "callback_query"] },
      timeout: 15000,
    });
    const updates = res.data.result || [];
    for (const update of updates) {
      offset = update.update_id + 1;

      if (update.callback_query) {
        if (update.callback_query.from.id.toString() === CHAT_ID) {
          await handleCallbackQuery(update.callback_query);
        }
        continue;
      }

      const msg = update.message;
      if (!msg || msg.chat.id.toString() !== CHAT_ID) continue;
      if (!msg.text) continue;
      await handleMessage(msg.text);
    }
    setTimeout(poll, 500);
  } catch (err) {
    const status = err.response?.status;
    if (status === 409) {
      console.warn("[telegramBot] 409 conflict — waiting 12s");
      setTimeout(poll, 12000);
    } else if (err.message?.includes("timeout") || status === 429) {
      setTimeout(poll, 2000);
    } else {
      console.warn("[telegramBot] poll error:", err.message);
      setTimeout(poll, 3000);
    }
  }
}

async function waitForClearSlot() {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await axios.get(`https://api.telegram.org/bot${TOKEN}/getUpdates`, {
        params: { offset, timeout: 0 },
        timeout: 5000,
      });
      return;
    } catch (err) {
      if (err.response?.status === 409) {
        console.warn(`[telegramBot] startup: 409 conflict (attempt ${attempt}) — waiting 12s`);
        await new Promise(r => setTimeout(r, 12000));
      } else {
        return;
      }
    }
  }
}

async function registerKeyboard() {
  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id:      CHAT_ID,
    text:         "_engine. ready_",
    parse_mode:   "Markdown",
    reply_markup: PERSISTENT_KEYBOARD,
  }).catch(() => {});
}

function start() {
  if (!TOKEN || !CHAT_ID) {
    console.warn("[telegramBot] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID — skipping");
    return;
  }
  console.log("[telegramBot] Listening for messages...");
  waitForClearSlot().then(async () => {
    await registerKeyboard();
    setTimeout(poll, 2000);
  });
}

module.exports = { start };
