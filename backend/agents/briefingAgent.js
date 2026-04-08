const { callAI } = require("../utils/callAI");

const MORNING_SYSTEM = `
You are a personal situation analyst. Every morning you review the user's full context and
deliver a focused briefing via Telegram. You think in structured steps before writing output.

CHAIN OF THOUGHT — work through these steps internally before writing output:

STEP 1 — INVENTORY
  List all active projects. For each: tasks (grouped), blockers, members, due dates, health, nextAction.
  Count: total open tasks, overdue tasks, tasks due today, tasks due this week.
  Note any upcoming meetings (nextMeeting on people) and when you last heard from key contacts (lastContact).

STEP 2 — MOMENTUM
  For each project, use the health field first, then verify against PROJECT HISTORY and task completion:
  - on-track: progressing, no blockers
  - at-risk: deadline close, slow progress, or key contact not heard from recently
  - blocked: has explicit blockers or a person with lastContact >5 days ago linked to it
  Use blocker count and deadline change count from history to detect chronic issues.

STEP 3 — DEPENDENCIES
  What can't move until something else happens?
  Check: blockers array, people with lastContact >5 days on active projects, tasks with no effort estimate on urgent projects.
  If someone has a nextMeeting today or tomorrow — flag it.

STEP 4 — PRIORITIES
  Given urgency (due dates, effort) + impact (blocking others) + momentum (health, nextAction):
  Pick the top 5 things that actually matter today. Be specific — name the exact task, person, or action.
  Use nextAction field on projects as the single most important step if present.
  Use effort field on tasks to judge what's realistic today.

STEP 5 — CLOSING NOTE
  Name the single biggest risk today — a deadline, a stalled project, a person you need to hear from.

OUTPUT FORMAT (Telegram markdown):
*engine. — morning*

• [specific action — include name/deadline/effort if relevant]
• [specific action]
• [specific action]
• [specific action]
• [specific action]

~80 words across all bullets. Be specific — use real names, task titles, deadlines. No intros, no labels. Never ask a question.
`.trim();

const EVENING_SYSTEM = `
You are a personal situation analyst. Every evening you review the user's day and
help them close out and prepare for tomorrow. You think in structured steps before writing output.

CHAIN OF THOUGHT — work through these steps internally before writing output:

STEP 1 — INVENTORY
  What's the current state of all active projects and tasks?
  Check health field on each project. Check nextAction — is it still the right next step?
  Note who has nextMeeting tomorrow and who hasn't been contacted recently (lastContact).

STEP 2 — WHAT MOVED TODAY
  Compare recent session history against task/project state.
  What got done, updated, or progressed today? What was discussed but not actioned?
  Look for tasks with outcome defined — were they completed to that outcome?

STEP 3 — WHAT DIDN'T MOVE
  What was expected to move but didn't? Any overdue items not addressed?
  Any blocked projects where the blocker person has lastContact >5 days ago?
  Any tasks with effort "15min" or "1hr" that could have been done but weren't?

STEP 4 — TOMORROW SETUP
  Given what didn't get done + upcoming due dates + effort estimates:
  What are the 5 most important things for tomorrow? Use nextAction fields as guide.
  If someone has a nextMeeting tomorrow, flag it explicitly.

STEP 5 — RISK FLAG
  Name the single biggest risk for tomorrow — a deadline, a blocker, a person you need to hear from.

OUTPUT FORMAT (Telegram markdown):
*engine. — evening*

• [specific action for tomorrow — include name/deadline/effort if relevant]
• [specific action]
• [specific action]
• [specific action]
• [specific action]

~80 words across all bullets. Be specific — use real names, task titles, deadlines. No intros, no labels. Never ask a question.
`.trim();

async function run(type, ctx) {
  const system = type === "morning" ? MORNING_SYSTEM : EVENING_SYSTEM;
  const today  = new Date().toISOString().split("T")[0];
  const now    = new Date();
  now.setHours(0, 0, 0, 0);

  // Group tasks by project for richer context
  const tasksByProject = {};
  for (const task of ctx.tasks) {
    const key = task.project || "_unassigned";
    if (!tasksByProject[key]) tasksByProject[key] = [];
    tasksByProject[key].push(task);
  }

  // Compute due date clusters
  const overdue   = ctx.tasks.filter(t => t.status !== "done" && t.dueDate && new Date(t.dueDate) < now);
  const dueToday  = ctx.tasks.filter(t => t.status !== "done" && t.dueDate && new Date(t.dueDate).toISOString().split("T")[0] === today);
  const dueWeek   = ctx.tasks.filter(t => {
    if (t.status === "done" || !t.dueDate) return false;
    const d = new Date(t.dueDate);
    const days = Math.round((d - now) / 86400000);
    return days > 0 && days <= 7;
  });

  const userPrompt = `TODAY: ${today}
TYPE: ${type} briefing

PROJECTS (active):
${JSON.stringify(ctx.projects.map(p => ({
  name: p.name, status: p.status, health: p.health, nextAction: p.nextAction,
  blockers: p.blockers, members: p.members, goals: p.goals, deadline: p.deadline,
})), null, 2)}

PROJECT HISTORY (patterns over time):
${ctx.projectHistorySummary || "(none)"}

TASKS BY PROJECT:
${JSON.stringify(tasksByProject, null, 2)}

DUE DATE SUMMARY:
- Overdue: ${overdue.length} task(s) — ${overdue.map(t => `"${t.title}"`).join(", ") || "none"}
- Due today: ${dueToday.length} task(s) — ${dueToday.map(t => `"${t.title}"`).join(", ") || "none"}
- Due this week: ${dueWeek.length} task(s)

PEOPLE:
${JSON.stringify(ctx.people.map(p => ({
  name: p.name, relationship: p.relationship,
  lastContact: p.lastContact, nextMeeting: p.nextMeeting,
  lastMentioned: p.lastMentioned, projects: p.projects,
})), null, 2)}

RECENT SESSION HISTORY (last 10 turns):
${ctx.history.map(h => `You: ${h.user}\nBrain: ${h.assistant}`).join("\n\n") || "(none)"}

RECENT JOURNAL (last 5 entries):
${ctx.recentJournal || "(none)"}`;

  try {
    const result = await callAI({
      model:      "claude-sonnet-4-6",
      system,
      userPrompt,
      maxTokens:  1000,
      rawText:    true,
    });
    return result;
  } catch (err) {
    console.error("[briefingAgent] failed:", err.message);
    return null;
  }
}

module.exports = { run };
