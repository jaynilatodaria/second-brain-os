const { readJson, writeJson } = require("../utils/storage");
const { callAI } = require("../utils/callAI");
const { sendMessage } = require("../utils/telegram");
const { upsertVector } = require("./qdrantSync");

// ─── Cooldowns per condition type (ms) ────────────────────────────────────────
const COOLDOWNS = {
  upcoming_meeting:  2  * 3600000,   // 2 hours  — time-sensitive
  task_overdue:      24 * 3600000,   // 24 hours — once per day per task
  birthday:          24 * 3600000,   // 24 hours
  blocker_followup:  3  * 86400000,  // 3 days
  project_stalled:   3  * 86400000,  // 3 days
  high_task_stale:   3  * 86400000,  // 3 days
};

// Active window: only send between 11am–8pm IST
function isQuietHours() {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours();
  return h < 11 || h >= 20;
}

// ─── Priority escalation (data quality, no notifications) ─────────────────────
async function escalatePriorities(tasks, memory) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split("T")[0];
  let changed = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (task.status === "done" || !task.dueDate) continue;

    const due = new Date(task.dueDate); due.setHours(0, 0, 0, 0);
    const daysUntil = Math.round((due - today) / 86400000);

    let newPriority = task.priority;
    if (daysUntil < 0 || daysUntil <= 2)                         newPriority = "high";
    else if (daysUntil <= 7 && task.priority === "low")          newPriority = "medium";

    if (newPriority !== task.priority) {
      tasks[i] = { ...task, priority: newPriority, updatedAt: new Date().toISOString() };
      upsertVector("tasks", task.id, [task.title, task.notes, task.project].filter(Boolean).join(" "), tasks[i])
        .catch(() => {});
      changed++;
    }
  }

  if (changed > 0) {
    await writeJson("memory.json", { ...memory, entries: tasks });
    console.log(`[stateWatcher] Escalated priority on ${changed} task(s)`);
  }
  return tasks;
}

// ─── Condition detection (pure JS, no AI) ─────────────────────────────────────
function detectConditions(tasks, projects, people, now) {
  const today = now.toISOString().split("T")[0];
  const conditions = [];

  // 1. Upcoming meetings (within 3 hours)
  for (const person of people) {
    if (!person.nextMeeting) continue;
    const meetingTime = new Date(person.nextMeeting);
    const hoursUntil = (meetingTime - now) / 3600000;
    if (hoursUntil >= 0 && hoursUntil <= 3) {
      conditions.push({
        type: "upcoming_meeting",
        person: person.name,
        nextMeeting: person.nextMeeting,
        hoursUntil: Math.round(hoursUntil * 10) / 10,
        projects: person.projects || [],
      });
    }
  }

  // 2. Overdue tasks
  for (const task of tasks) {
    if (task.status === "done" || !task.dueDate) continue;
    if (task.dueDate < today) {
      const daysOverdue = Math.round((now - new Date(task.dueDate)) / 86400000);
      conditions.push({
        type: "task_overdue",
        taskId: task.id,
        title: task.title,
        dueDate: task.dueDate,
        daysOverdue,
        project: task.project || null,
        notes: task.notes || null,
      });
    }
  }

  // 3. Birthdays within 2 days
  for (const person of people) {
    if (!person.birthday) continue;
    const parts = person.birthday.split("-");
    let month, day;
    if (parts.length === 3)      [, month, day] = parts;
    else if (parts.length === 2) [month, day]   = parts;
    else continue;
    const thisYear = new Date(now.getFullYear(), parseInt(month) - 1, parseInt(day));
    const nextYear = new Date(now.getFullYear() + 1, parseInt(month) - 1, parseInt(day));
    const target   = thisYear >= now ? thisYear : nextYear;
    const daysUntil = Math.round((target - now) / 86400000);
    if (daysUntil <= 2) {
      conditions.push({ type: "birthday", person: person.name, daysUntil, birthday: person.birthday });
    }
  }

  // 4. Blocker follow-up: person mentioned in blockers, lastContact >7 days ago
  for (const project of projects) {
    if (!project.blockers?.length) continue;
    for (const blocker of project.blockers) {
      const mentioned = people.find(p => blocker.toLowerCase().includes(p.name.toLowerCase()));
      if (!mentioned?.lastContact) continue;
      const daysSince = Math.round((now - new Date(mentioned.lastContact)) / 86400000);
      if (daysSince >= 7) {
        conditions.push({
          type: "blocker_followup",
          person: mentioned.name,
          project: project.name,
          blocker,
          daysSince,
          lastContact: mentioned.lastContact,
        });
      }
    }
  }

  // 5. Stalled project: open tasks with no update in 5+ days
  for (const project of projects) {
    if (project.archived) continue;
    const openTasks = tasks.filter(t => t.project === project.name && t.status !== "done");
    if (!openTasks.length) continue;
    const lastUpdate = openTasks
      .map(t => new Date(t.updatedAt || t.createdAt || 0))
      .reduce((a, b) => (a > b ? a : b));
    const daysSince = Math.round((now - lastUpdate) / 86400000);
    if (daysSince >= 5) {
      conditions.push({
        type: "project_stalled",
        project: project.name,
        daysSince,
        openTasks: openTasks.length,
        nextAction: project.nextAction || null,
      });
    }
  }

  // 6. High-priority task with no update in 7+ days
  const sevenDaysAgo = new Date(now - 7 * 86400000).toISOString();
  for (const task of tasks) {
    if (task.status === "done" || task.priority !== "high") continue;
    if (task.dueDate && task.dueDate < today) continue; // already caught by overdue
    const lastUpdated = task.updatedAt || task.createdAt;
    if (lastUpdated && lastUpdated < sevenDaysAgo) {
      conditions.push({
        type: "high_task_stale",
        taskId: task.id,
        title: task.title,
        project: task.project || null,
        daysSince: Math.round((now - new Date(lastUpdated)) / 86400000),
      });
    }
  }

  return conditions;
}

// ─── Cooldown key per condition ────────────────────────────────────────────────
function conditionKey(c) {
  switch (c.type) {
    case "upcoming_meeting":  return `meeting_${c.person}`;
    case "task_overdue":      return `overdue_${c.taskId}`;
    case "birthday":          return `birthday_${c.person}`;
    case "blocker_followup":  return `blocker_${c.person}_${c.project}`;
    case "project_stalled":   return `stalled_${c.project}`;
    case "high_task_stale":   return `stale_${c.taskId}`;
    default:                  return `${c.type}`;
  }
}

// ─── AI composer ──────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are the State Watcher Agent for a personal second brain system.
You receive a list of triggered conditions (already filtered for urgency and cooldown).
Your job: compose concise, specific Telegram notifications. You may combine related conditions into one message.

RESPONSE FORMAT — ONLY valid JSON, no prose outside it:
{
  "notifications": [
    { "conditionKeys": ["key1", "key2"], "message": "Telegram markdown message" }
  ],
  "skip": ["key — reason"],
  "reasoning": "one sentence"
}

MESSAGE RULES:
- Use Telegram markdown (*bold*, _italic_)
- Start each with "*engine. — [label]*" where label reflects the type (heads up / meeting / birthday / stalled)
- Max 5 bullet lines per message. Be specific — use real names and task titles.
- If a condition is not actually actionable right now, put its key in skip with a reason.
- Never be generic. "Finalise lease agreement is overdue" beats "you have overdue tasks".
- Combine related conditions (e.g. same project, same person) into one message if it reads better.
`.trim();

async function composeNotifications(fresh, allContext) {
  const userPrompt = `TODAY: ${new Date().toISOString()}

TRIGGERED CONDITIONS:
${JSON.stringify(fresh, null, 2)}

CONTEXT:
${JSON.stringify(allContext, null, 2)}`;

  try {
    const parsed = await callAI({
      model: "claude-haiku-4-5-20251001",
      system: SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 600,
    });
    return parsed;
  } catch (err) {
    console.warn("[stateWatcher] AI compose failed:", err.message);
    return null;
  }
}

// ─── Main run ─────────────────────────────────────────────────────────────────
async function run() {
  try {
    if (isQuietHours()) {
      console.log("[stateWatcher] Quiet hours — skipping");
      return;
    }

    const [memory, projects, people, watcherState] = await Promise.all([
      readJson("memory.json"),
      readJson("projects.json"),
      readJson("people.json"),
      readJson("watcherState.json"),
    ]);

    let tasks = (memory?.entries || []).filter(t => t.status !== "done");
    const activeProjects = (projects?.projects || []).filter(p => !p.archived);
    const allPeople = people?.people || [];
    const notified  = watcherState?.notified || {};
    const now = new Date();

    if (!tasks.length && !activeProjects.length) {
      console.log("[stateWatcher] Nothing to watch");
      return;
    }

    // Step 1: Silently escalate task priorities (data quality)
    tasks = await escalatePriorities(tasks, memory);

    // Step 2: Detect all conditions
    const all = detectConditions(tasks, activeProjects, allPeople, now);
    if (!all.length) {
      console.log("[stateWatcher] No conditions triggered");
      return;
    }

    // Step 3: Filter by cooldown
    const fresh = all.filter(c => {
      const key  = conditionKey(c);
      const last = notified[key];
      if (!last) return true;
      const cooldown = COOLDOWNS[c.type] || 86400000;
      return (now - new Date(last)) > cooldown;
    });

    if (!fresh.length) {
      console.log(`[stateWatcher] ${all.length} condition(s) all within cooldown`);
      return;
    }

    console.log(`[stateWatcher] ${fresh.length} fresh condition(s):`, fresh.map(c => c.type));

    // Step 4: AI composes messages
    const allContext = {
      tasks:    tasks.slice(0, 20),
      projects: activeProjects,
      people:   allPeople,
    };
    const composed = await composeNotifications(fresh, allContext);
    if (!composed) return;

    // Step 5: Send notifications
    const notifications = composed.notifications || [];
    for (const n of notifications) {
      await sendMessage(n.message);
    }

    // Step 6: Update cooldown state for all fresh conditions
    for (const c of fresh) {
      notified[conditionKey(c)] = now.toISOString();
    }
    await writeJson("watcherState.json", { notified, lastRun: now.toISOString() });

    console.log(`[stateWatcher] Sent ${notifications.length} notification(s), skipped ${(composed.skip || []).length}`);
  } catch (err) {
    console.error("[stateWatcher] Failed:", err.message);
  }
}

module.exports = { run };
