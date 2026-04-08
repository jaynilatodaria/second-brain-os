function sliceForPeople(context) {
  return {
    people: context.people?.people || [],
    taskTitles: (context.memory?.entries || []).map(t => t.title),
    projectNames: (context.projects?.projects || []).map(p => p.name),
    history: (context.sessionContext?.history || []).slice(-3),
  };
}

function sliceForProjects(context) {
  return {
    projects: context.projects?.projects || [],
    taskTitles: (context.memory?.entries || []).map(t => t.title),
    peopleNames: (context.people?.people || []).map(p => p.name),
    history: (context.sessionContext?.history || []).slice(-3),
  };
}

function sliceForPlanning(context, mergedActions) {
  return {
    tasks: context.memory?.entries || [],
    projects: context.projects?.projects || [],
    history: (context.sessionContext?.history || []).slice(-5),
    mergedActions,
  };
}

function sliceForTasks(context, domainOutputs) {
  return {
    tasks: context.memory?.entries || [],
    projects: context.projects?.projects || [],
    peopleNames: (context.people?.people || []).map(p => p.name),
    history: (context.sessionContext?.history || []).slice(-3),
    pendingInquiry: context.pendingInquiry,
    planningSuggestions: domainOutputs.planning?.suggestions || [],
    domainReasoning: {
      people:   domainOutputs.people?.reasoning   || "",
      projects: domainOutputs.projects?.reasoning || "",
      planning: domainOutputs.planning?.reasoning || "",
    },
  };
}

function sliceForComposer(context, finalActions, reasoning) {
  const round = context.pendingInquiry?.clarificationRound || 0;
  const now = new Date(); now.setHours(0,0,0,0);
  const tasks = context.memory?.entries || [];
  const activeTasks = tasks.filter(t => t.status !== "done");
  const overdue = activeTasks.filter(t => t.dueDate && new Date(t.dueDate) < now).length;
  return {
    finalActions,
    domainReasoning: reasoning,
    history: (context.sessionContext?.history || []).slice(-5),
    pendingInquiry: context.pendingInquiry,
    clarificationRound: round,
    dataSnapshot: {
      totalTasks:    activeTasks.length,
      overdueTasks:  overdue,
      projects:      (context.projects?.projects || []).map(p => ({ name: p.name, status: p.status })),
      people:        (context.people?.people || []).map(p => p.name),
    },
  };
}

module.exports = { sliceForPeople, sliceForProjects, sliceForPlanning, sliceForTasks, sliceForComposer };
