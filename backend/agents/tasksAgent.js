const { callAI } = require("../utils/callAI");

const SYSTEM_PROMPT = `
You are the Tasks Execution Agent for a personal second brain system.
The Planning Agent has already done the thinking. Your job: execute its suggestions
and catch anything it missed — especially completions and deadline changes from the user's message.

RESPONSE FORMAT — ONLY valid JSON, no prose outside it:
{
  "actions": [ { "type": "ACTION_TYPE", "payload": {...} } ],
  "reasoning": "one specific sentence: what you executed and why"
}

AVAILABLE ACTIONS:
ADD_TASK    payload: { title, project?, priority?, dueDate?, tags?, notes?, effort?, outcome?, _source? }
UPDATE_TASK payload: { title, fields: { status?, project?, priority?, dueDate?, tags?, notes?, effort?, outcome? } }

EXECUTION RULES:

1. PLANNING SUGGESTIONS — your primary input:
   - "add" suggestion → ADD_TASK (only if title not already in CURRENT TASKS)
   - "update" suggestion → UPDATE_TASK with the given fields
   - "complete" suggestion → UPDATE_TASK { fields: { status: "done" } }
   - Trust the planning agent's suggestions — execute them unless it's a clear duplicate

2. COMPLETION DETECTION — catch what planning missed:
   - "done with X", "finished X", "sorted X", "X is done", "just completed X" → UPDATE_TASK status: done
   - Scan CURRENT TASKS for the best match to what was completed
   - If no match found → set reasoning: "AMBIGUOUS_COMPLETION: [describe]"

3. DEADLINE CHANGES — catch what planning missed:
   - "X pushed to Y", "no rush on X", "X extended" → UPDATE_TASK on existing task
   - If the existing task title contains a specific date or detail now outdated (e.g. "Book flights for May 15th" when trip moved to July) → include fields.title with the corrected title
   - If no match found → set reasoning: "AMBIGUOUS_UPDATE: [describe]"

4. PENDING INQUIRY ANSWERS:
   - If PENDING INQUIRY exists and user message answers it → execute the intended action

FIELD RULES:
- ALWAYS include project field on ADD_TASK if a project is mentioned in context
- ALWAYS set priority — high / medium / low, never blank
- dueDate as ISO string YYYY-MM-DD only, never text
- Notes for context, not for dates (dates go in dueDate)
- effort: time estimate for the task — "15min", "1hr", "half-day", "full-day" — infer from task complexity if not stated
- outcome: one sentence defining what "done" looks like (e.g. "Lease agreement signed and filed") — always set this on ADD_TASK
- tags: array of relevant keywords (e.g. ["legal", "travel", "finance"]) — always extract from task title/notes/project context

DEADLINE EXTRACTION — mandatory:
- Any date in message or suggestions → set dueDate as YYYY-MM-DD
- Calculate from TODAY'S DATE provided
- "by April 10" → "2026-04-10" | "by Friday" → next Friday | "in 3 days" → TODAY + 3

Do NOT generate ASK, CLEAR_ASK, ADD_PERSON, or ADD_PROJECT actions.
If no task actions are needed, return actions: [].
`.trim();

// Fallback: extract dueDate from text if AI didn't set it
function extractDueDate(action, rawMessage) {
  const fields = action.type === "ADD_TASK" ? action.payload : (action.payload?.fields || {});
  if (fields.dueDate) return action;

  const text = [rawMessage, fields.notes || "", action.payload?.title || ""].join(" ");

  const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return applyDueDate(action, isoMatch[1]);

  const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11,
    january:0,february:1,march:2,april:3,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };
  const monthDay = text.match(/\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:[,\s]+(\d{4}))?\b/i);
  if (monthDay) {
    const day   = parseInt(monthDay[1] || monthDay[4]);
    const mName = (monthDay[2] || monthDay[3]).toLowerCase().slice(0, 3);
    const month = MONTHS[mName];
    const year  = parseInt(monthDay[5]) || new Date().getFullYear();
    if (!isNaN(day) && month !== undefined) {
      const d = new Date(year, month, day);
      if (d < new Date()) d.setFullYear(d.getFullYear() + 1);
      return applyDueDate(action, d.toISOString().split("T")[0]);
    }
  }

  return action;
}

function applyDueDate(action, dueDate) {
  if (action.type === "ADD_TASK") {
    return { ...action, payload: { ...action.payload, dueDate } };
  }
  return { ...action, payload: { ...action.payload, fields: { ...action.payload.fields, dueDate } } };
}

async function run(message, agentCtx) {
  const historyBlock = (agentCtx.history || []).map(h => `You: ${h.user}\nBrain: ${h.assistant}`).join("\n\n") || "(none)";

  const pendingQ = agentCtx.pendingInquiry?.question
    ? `PENDING CLARIFICATION (user is answering this): "${agentCtx.pendingInquiry.question}"\n\n`
    : "";

  const today = new Date().toISOString().split("T")[0];

  const userPrompt = `TODAY: ${today}

${pendingQ}PLANNING SUGGESTIONS (execute these):
${JSON.stringify(agentCtx.planningSuggestions, null, 2)}

OTHER AGENT REASONING:
People:   ${agentCtx.domainReasoning.people   || "nothing relevant"}
Projects: ${agentCtx.domainReasoning.projects || "nothing relevant"}
Planning: ${agentCtx.domainReasoning.planning || "nothing relevant"}

CURRENT TASKS:
${JSON.stringify(agentCtx.tasks, null, 2)}

CURRENT PROJECTS:
${JSON.stringify((agentCtx.projects || []).map(p => ({ name: p.name, status: p.status, blockers: p.blockers, goals: p.goals })), null, 2)}
KNOWN PEOPLE:   ${agentCtx.peopleNames.join(", ") || "none"}

HISTORY (last 3 turns):
${historyBlock}

MESSAGE: "${message}"`;

  try {
    const parsed = await callAI({ model: "claude-sonnet-4-6", system: SYSTEM_PROMPT, userPrompt, maxTokens: 1200 });
    const actions = (parsed.actions || [])
      .filter(a => ["ADD_TASK", "UPDATE_TASK"].includes(a.type))
      .map(a => extractDueDate(a, message));
    return { actions, reasoning: parsed.reasoning || "" };
  } catch (err) {
    console.warn("[tasksAgent] failed:", err.stack);
    return { actions: [], reasoning: "" };
  }
}

module.exports = { run };
