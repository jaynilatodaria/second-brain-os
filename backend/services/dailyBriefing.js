const fs = require("fs").promises;
const path = require("path");
const { readJson } = require("../utils/storage");
const { sendMessage } = require("../utils/telegram");
const { run: briefingAgent } = require("../agents/briefingAgent");

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const JOURNAL_PATH = path.join(DATA_DIR, "journal.md");

async function getRecentJournal(entryCount = 5) {
  try {
    const content = await fs.readFile(JOURNAL_PATH, "utf-8");
    // Split by entry separator and take the last N
    const entries = content.split("\n\n---\n").filter(Boolean);
    return entries.slice(-entryCount).join("\n\n---\n");
  } catch {
    return "(none)";
  }
}

async function run(type) {
  try {
    const [projects, tasks, people, session] = await Promise.all([
      readJson("projects.json"),
      readJson("memory.json"),
      readJson("people.json"),
      readJson("sessionContext.json"),
    ]);

    const recentJournal = await getRecentJournal(5);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 21);

    const activeTasks = (tasks?.entries || []).filter(t =>
      t.status !== "done" &&
      (!t.updatedAt || new Date(t.updatedAt) > cutoff || t.dueDate) &&
      (!t.dueDate || new Date(t.dueDate) <= horizon)
    );

    // Only include projects that have at least one task in the 3-week window, or updated recently
    const activeProjectNames = new Set(activeTasks.map(t => t.project).filter(Boolean));
    const activeProjects = (projects?.projects || []).filter(p =>
      !p.archived && (activeProjectNames.has(p.name) || !p.updatedAt || new Date(p.updatedAt) > cutoff)
    );

    // Summarise project history into readable signals for the briefing agent
    const projectHistorySummary = activeProjects
      .filter(p => Array.isArray(p.history) && p.history.length > 0)
      .map(p => {
        const recent = p.history.slice(-5); // last 5 events
        const blockerCount = p.history.filter(e => e.event === "blocker_added").length;
        const deadlinePushes = p.history.filter(e => e.event === "updated" && e.changes?.goals).length;
        const lines = recent.map(e => `  [${e.ts.split("T")[0]}] ${e.event}${e.changes?.blockers ? `: ${JSON.stringify(e.changes.blockers.to)}` : ""}`);
        return `${p.name}: ${blockerCount} blocker(s) total, ${deadlinePushes} deadline change(s)\n${lines.join("\n")}`;
      }).join("\n\n") || "(none)";

    const ctx = {
      projects: activeProjects,
      tasks:    activeTasks,
      people:   people?.people    || [],
      history:  (session?.history || []).slice(-10),
      recentJournal,
      projectHistorySummary,
    };

    // Skip if nothing to brief on
    if (!ctx.projects.length && !ctx.tasks.length) {
      console.log(`[dailyBriefing] ${type}: nothing to brief on`);
      return;
    }

    console.log(`[dailyBriefing] running ${type} briefing...`);
    const message = await briefingAgent(type, ctx);

    if (!message) {
      console.warn(`[dailyBriefing] ${type}: agent returned nothing`);
      return;
    }

    await sendMessage(message);
    console.log(`[dailyBriefing] ${type} briefing sent`);
  } catch (err) {
    console.error(`[dailyBriefing] ${type} failed:`, err.message);
  }
}

module.exports = { run };
