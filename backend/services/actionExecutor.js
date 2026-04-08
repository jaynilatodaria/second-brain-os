const { readJson, writeJson } = require("../utils/storage");
const { upsertVector } = require("./qdrantSync");
const { v4: uuidv4 } = require("uuid");

// Arrays that should be merged (union) rather than overwritten
const MERGE_ARRAYS = new Set(["members", "projects", "tasks", "goals", "tags"]);

// Merge incoming fields into existing record — skips null/empty, never overwrites id/createdAt
// Array fields in MERGE_ARRAYS are unioned rather than replaced
function mergeFields(existing, incoming) {
  const result = { ...existing };
  for (const [key, val] of Object.entries(incoming)) {
    if (key === "id" || key === "createdAt") continue;
    if (val === null || val === undefined || val === "") continue;
    if (MERGE_ARRAYS.has(key) && Array.isArray(val)) {
      const existing_arr = Array.isArray(result[key]) ? result[key] : [];
      result[key] = [...new Set([...existing_arr, ...val])];
    } else {
      result[key] = val;
    }
  }
  result.updatedAt = new Date().toISOString();
  return result;
}

// Fuzzy name match — Jaccard similarity on meaningful words (ignores stop words)
// Returns true if two names refer to the same thing (threshold: 40% overlap)
const STOP_WORDS = new Set(["a","an","the","with","to","for","of","in","on","at","and","or","my","our","i","we"]);
function fuzzyMatch(a, b) {
  if (!a || !b) return false;
  const tokenize = str => str.toLowerCase().split(/\s+/).filter(w => w.length > 1 && !STOP_WORDS.has(w));
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return false;
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return (intersection / union) >= 0.4;
}

// Derive top-level source: "user" if any field in _source is "user", else "ai_inferred"
function resolveSource(sourceMap) {
  if (!sourceMap || typeof sourceMap !== "object") return "ai_inferred";
  return Object.values(sourceMap).includes("user") ? "user" : "ai_inferred";
}

function buildEmbeddingText(type, record) {
  if (type === "tasks") {
    return [record.title, record.notes, record.project, ...(record.tags || [])].filter(Boolean).join(" ");
  }
  if (type === "projects") {
    return [record.name, record.description, record.goals].filter(Boolean).join(" ");
  }
  if (type === "people") {
    return [record.name, record.role, record.relationship, record.notes].filter(Boolean).join(" ");
  }
  return "";
}

// Append a history event to a record's history array
function addHistoryEvent(record, event) {
  const history = Array.isArray(record.history) ? record.history : [];
  history.push({ ts: new Date().toISOString(), ...event });
  return { ...record, history };
}

// Diff two objects and return only changed keys (excluding meta fields)
const SKIP_DIFF = new Set(["updatedAt", "createdAt", "history", "lastMentioned"]);
function diffFields(before, after) {
  const changes = {};
  for (const key of Object.keys(after)) {
    if (SKIP_DIFF.has(key)) continue;
    const bVal = JSON.stringify(before[key]);
    const aVal = JSON.stringify(after[key]);
    if (bVal !== aVal) changes[key] = { from: before[key], to: after[key] };
  }
  return changes;
}

function syncToQdrant(collection, record, rawUserMessage) {
  const embeddingText = buildEmbeddingText(collection, record);
  const payload = {
    ...record,
    source: resolveSource(record._source),
    raw_user_message: rawUserMessage,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    updated_by: resolveSource(record._source) === "user" ? "user" : "ai",
  };
  upsertVector(collection, record.id, embeddingText, payload)
    .catch(err => console.warn(`[qdrant] Sync failed (${collection}/${record.id}):`, err.message));
}

// Assign a fallback dueDate based on priority if none provided
function fallbackDueDate(priority) {
  const d = new Date();
  const days = priority === "high" ? 7 : priority === "medium" ? 14 : 30;
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

// Infer project for a task by fuzzy-matching its title/notes against known project names
function inferProject(task, projectNames) {
  if (task.project) return task.project;
  if (!projectNames?.length) return null;
  const text = [task.title, task.notes].filter(Boolean).join(" ").toLowerCase();
  for (const name of projectNames) {
    const words = name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (words.some(w => text.includes(w))) return name;
  }
  return null;
}

// After all actions: repair any orphaned task.project / person.projects refs
async function runConsistencyPass(log) {
  const [memory, projects, people] = await Promise.all([
    readJson("memory.json"),
    readJson("projects.json"),
    readJson("people.json"),
  ]);

  const canonicalNames = (projects.projects || []).map(p => p.name);
  const nameSet = new Set(canonicalNames);
  let memChanged = false;
  let pplChanged = false;

  for (const task of memory.entries || []) {
    if (task.project && !nameSet.has(task.project)) {
      const match = canonicalNames.find(n => fuzzyMatch(task.project, n)) || null;
      if (task.project !== match) { task.project = match; memChanged = true; }
    }
  }

  for (const person of people.people || []) {
    if (!Array.isArray(person.projects)) continue;
    const fixed = [...new Set(
      person.projects.map(pName => nameSet.has(pName) ? pName : (canonicalNames.find(n => fuzzyMatch(pName, n)) || null))
        .filter(Boolean)
    )];
    if (JSON.stringify(fixed) !== JSON.stringify(person.projects)) {
      person.projects = fixed;
      pplChanged = true;
    }
  }

  if (memChanged) await writeJson("memory.json", memory);
  if (pplChanged) await writeJson("people.json", people);
  if (memChanged || pplChanged) log.push({ type: "CONSISTENCY_PASS", result: "fixed_orphaned_refs" });
}

async function executeActions(actions, rawUserMessage = "", projectNames = []) {
  const log = [];

  for (const action of actions) {
    try {
      switch (action.type) {

        case "ADD_TASK": {
          const memory = await readJson("memory.json");
          const p = { ...action.payload };
          if (!p.project) p.project = inferProject(p, projectNames);
          const idx = memory.entries.findIndex(e =>
            e.title?.toLowerCase() === p.title?.toLowerCase() || fuzzyMatch(e.title, p.title)
          );
          if (idx >= 0) {
            const merged = mergeFields(memory.entries[idx], p);
            memory.entries[idx] = merged;
            await writeJson("memory.json", memory);
            syncToQdrant("tasks", merged, rawUserMessage);
            log.push({ type: "ADD_TASK", result: "merged", title: p.title, id: merged.id });
            break;
          }
          const now = new Date().toISOString();
          if (!p.dueDate) p.dueDate = fallbackDueDate(p.priority);
          const entry = { id: uuidv4(), status: "active", ...p, createdAt: now, updatedAt: now };
          memory.entries.push(entry);
          await writeJson("memory.json", memory);
          syncToQdrant("tasks", entry, rawUserMessage);
          log.push({ type: "ADD_TASK", result: "created", title: p.title, id: entry.id });
          break;
        }

        case "UPDATE_TASK": {
          const memory = await readJson("memory.json");
          const { title, fields } = action.payload;
          let idx = memory.entries.findIndex(e => e.title?.toLowerCase() === title?.toLowerCase());

          // Exact match failed — try fuzzy before giving up
          if (idx < 0) {
            idx = memory.entries.findIndex(e => fuzzyMatch(e.title, title));
          }

          if (idx < 0) {
            // Genuine fallback: create new entry
            console.warn(`[executor] UPDATE_TASK: "${title}" not found — creating instead`);
            const now = new Date().toISOString();
            const entry = { id: uuidv4(), status: "active", title, ...fields, createdAt: now, updatedAt: now };
            memory.entries.push(entry);
            await writeJson("memory.json", memory);
            syncToQdrant("tasks", entry, rawUserMessage);
            log.push({ type: "UPDATE_TASK", result: "fallback_created", title });
            break;
          }

          const updated = { ...memory.entries[idx], ...fields, updatedAt: new Date().toISOString() };
          // If dueDate changed, strip stale date text from title (e.g. "for May 15th", "on April 10")
          if (fields.dueDate && updated.title) {
            updated.title = updated.title
              .replace(/\s+(?:for|on|by)\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+\d{4})?/gi, "")
              .replace(/\s+(?:for|on|by)\s+\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/gi, "")
              .trim();
          }
          if (fields.status === "done" && !updated.completedAt) {
            updated.completedAt = updated.updatedAt;
          }
          memory.entries[idx] = updated;
          await writeJson("memory.json", memory);
          syncToQdrant("tasks", updated, rawUserMessage);
          log.push({ type: "UPDATE_TASK", result: "updated", title });
          break;
        }

        case "ADD_PROJECT": {
          const projects = await readJson("projects.json");
          const p = action.payload;
          const idx = projects.projects.findIndex(proj =>
            proj.name?.toLowerCase() === p.name?.toLowerCase() || fuzzyMatch(proj.name, p.name)
          );
          if (idx >= 0) {
            const merged = mergeFields(projects.projects[idx], p);
            projects.projects[idx] = merged;
            await writeJson("projects.json", projects);
            syncToQdrant("projects", merged, rawUserMessage);
            log.push({ type: "ADD_PROJECT", result: "merged", name: p.name });
            break;
          }
          const now = new Date().toISOString();
          if (!p.deadline) p.deadline = fallbackDueDate("medium"); // default 14 days
          let project = { id: uuidv4(), status: "active", ...p, createdAt: now, updatedAt: now };
          project = addHistoryEvent(project, { event: "created", status: project.status });
          projects.projects.push(project);
          await writeJson("projects.json", projects);
          syncToQdrant("projects", project, rawUserMessage);
          log.push({ type: "ADD_PROJECT", result: "created", name: p.name });
          break;
        }

        case "UPDATE_PROJECT": {
          const projects = await readJson("projects.json");
          const { name, fields } = action.payload;
          let idx = projects.projects.findIndex(proj => proj.name?.toLowerCase() === name?.toLowerCase());

          // Exact match failed — try fuzzy before giving up
          if (idx < 0) {
            idx = projects.projects.findIndex(proj => fuzzyMatch(proj.name, name));
          }

          if (idx < 0) {
            console.warn(`[executor] UPDATE_PROJECT: "${name}" not found — creating instead`);
            const now = new Date().toISOString();
            const project = { id: uuidv4(), status: "active", name, ...fields, createdAt: now, updatedAt: now };
            projects.projects.push(project);
            await writeJson("projects.json", projects);
            syncToQdrant("projects", project, rawUserMessage);
            log.push({ type: "UPDATE_PROJECT", result: "fallback_created", name });
            break;
          }

          const before = projects.projects[idx];
          let updated = { ...before, ...fields, updatedAt: new Date().toISOString() };
          if (fields.status === "done" && !updated.archivedAt) {
            updated.archived = true;
            updated.archivedAt = updated.updatedAt;
          }
          // Build history event from meaningful changes
          const changes = diffFields(before, updated);
          if (Object.keys(changes).length > 0) {
            const event = { event: "updated", changes };
            if (changes.status) event.event = "status_changed";
            else if (changes.blockers) event.event = changes.blockers.to?.length > (changes.blockers.from?.length || 0) ? "blocker_added" : "blocker_resolved";
            else if (changes.members) event.event = "member_added";
            updated = addHistoryEvent(updated, event);
          }
          projects.projects[idx] = updated;
          await writeJson("projects.json", projects);
          syncToQdrant("projects", updated, rawUserMessage);
          log.push({ type: "UPDATE_PROJECT", result: "updated", name });

          // Cascade rename: if project name changed, update all task.project and person.projects refs
          if (fields.name && fields.name !== before.name) {
            const memory = await readJson("memory.json");
            let taskChanged = false;
            for (const task of memory.entries || []) {
              if (task.project === before.name) { task.project = fields.name; taskChanged = true; }
            }
            if (taskChanged) await writeJson("memory.json", memory);

            const people = await readJson("people.json");
            let peopleChanged = false;
            for (const person of people.people || []) {
              if (Array.isArray(person.projects)) {
                const i = person.projects.indexOf(before.name);
                if (i >= 0) { person.projects[i] = fields.name; peopleChanged = true; }
              }
            }
            if (peopleChanged) await writeJson("people.json", people);
            log.push({ type: "CASCADE_RENAME", from: before.name, to: fields.name });
          }
          break;
        }

        case "ADD_PERSON": {
          const people = await readJson("people.json");
          const p = { ...action.payload, lastMentioned: new Date().toISOString().split("T")[0] };
          let idx = people.people.findIndex(person =>
            person.name?.toLowerCase() === p.name?.toLowerCase() || fuzzyMatch(person.name, p.name)
          );
          // Also dedup by relationship — prevents creating "Rachy" when "Girlfriend" placeholder exists
          if (idx < 0 && p.relationship) {
            idx = people.people.findIndex(person =>
              person.relationship?.toLowerCase() === p.relationship?.toLowerCase()
            );
          }
          if (idx >= 0) {
            const merged = mergeFields(people.people[idx], p);
            people.people[idx] = merged;
            await writeJson("people.json", people);
            syncToQdrant("people", merged, rawUserMessage);
            log.push({ type: "ADD_PERSON", result: "merged", name: p.name });
            break;
          }
          const now = new Date().toISOString();
          const person = { id: uuidv4(), ...p, createdAt: now, updatedAt: now };
          people.people.push(person);
          await writeJson("people.json", people);
          syncToQdrant("people", person, rawUserMessage);
          log.push({ type: "ADD_PERSON", result: "created", name: p.name });
          break;
        }

        case "UPDATE_PERSON": {
          const people = await readJson("people.json");
          const { name, fields } = action.payload;
          let idx = people.people.findIndex(person => person.name?.toLowerCase() === name?.toLowerCase());

          // Exact match failed — try relationship match, then fuzzy name match
          if (idx < 0) {
            const nameLower = name.toLowerCase();
            idx = people.people.findIndex(person =>
              person.relationship?.toLowerCase() === nameLower ||
              fuzzyMatch(person.name, name)
            );
          }

          if (idx < 0) {
            console.warn(`[executor] UPDATE_PERSON: "${name}" not found — creating instead`);
            const now = new Date().toISOString();
            const person = { id: uuidv4(), name, ...fields, createdAt: now, updatedAt: now };
            people.people.push(person);
            await writeJson("people.json", people);
            syncToQdrant("people", person, rawUserMessage);
            log.push({ type: "UPDATE_PERSON", result: "fallback_created", name });
            break;
          }

          const beforePerson = people.people[idx];
          const updated = { ...beforePerson, ...fields, lastMentioned: new Date().toISOString().split("T")[0], updatedAt: new Date().toISOString() };
          people.people[idx] = updated;
          await writeJson("people.json", people);
          syncToQdrant("people", updated, rawUserMessage);
          log.push({ type: "UPDATE_PERSON", result: "updated", name });
          break;
        }

        case "ASK": {
          const pending = {
            question: action.payload.question,
            context: action.payload.context,
            clarificationRound: action.payload.clarificationRound || 1,
            createdAt: new Date().toISOString(),
          };
          await writeJson("pendingInquiry.json", pending);
          log.push({ type: "ASK", result: "saved", round: pending.clarificationRound });
          break;
        }

        case "CLEAR_ASK": {
          await writeJson("pendingInquiry.json", null);
          log.push({ type: "CLEAR_ASK", result: "cleared" });
          break;
        }

        default:
          log.push({ type: action.type, result: "unknown_action_type" });
      }
    } catch (err) {
      log.push({ type: action.type, result: "error", error: err.message });
    }
  }

  await runConsistencyPass(log);
  return log;
}

module.exports = { executeActions };
