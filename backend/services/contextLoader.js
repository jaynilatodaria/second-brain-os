const { readJson } = require("../utils/storage");
const { searchVectors } = require("../services/qdrantSync");

async function loadContext(query = null) {
  // Always load these — small, always needed
  const [sessionContext, pendingInquiry] = await Promise.all([
    readJson("sessionContext.json"),
    readJson("pendingInquiry.json"),
  ]);

  // Projects + people always loaded in full — too small to filter, filtering causes dedup failures
  const [projects, people] = await Promise.all([
    readJson("projects.json"),
    readJson("people.json"),
  ]);
  if (projects?.projects) projects.projects = projects.projects.filter(p => !p.archived);

  // Tasks: use Qdrant semantic search if available, fall back to full JSON
  if (query) {
    const taskResults = await searchVectors("tasks", query, 8);
    if (taskResults !== null) {
      return {
        memory:        { entries: taskResults },
        projects:      projects || { projects: [] },
        people:        people   || { people: [] },
        sessionContext,
        pendingInquiry,
        contextSource: "qdrant_tasks",
      };
    }
  }

  // Full JSON fallback
  const memory = await readJson("memory.json");
  return {
    memory,
    projects,
    people,
    sessionContext,
    pendingInquiry,
    contextSource: "full_json",
  };
}

module.exports = { loadContext };
