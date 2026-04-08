const { sliceForPeople, sliceForProjects, sliceForPlanning, sliceForTasks, sliceForComposer } = require("./agentContext");
const peopleAgent   = require("../agents/peopleAgent");
const projectsAgent = require("../agents/projectsAgent");
const planningAgent = require("../agents/planningAgent");
const tasksAgent    = require("../agents/tasksAgent");
const composerAgent = require("../agents/composerAgent");

async function run(message, context) {
  // Step 1: People + Projects in parallel — each self-gates, returns [] if not relevant
  const [peopleOutput, projectsOutput] = await Promise.all([
    peopleAgent.run(message, sliceForPeople(context)),
    projectsAgent.run(message, sliceForProjects(context)),
  ]);
  console.log(`[orchestrator] people=${peopleOutput.actions.length} projects=${projectsOutput.actions.length}`);

  // Step 2: Planning — generates suggestions (think) + project updates (act)
  const mergedEarly = [...peopleOutput.actions, ...projectsOutput.actions];
  const planningOutput = await planningAgent.run(message, sliceForPlanning(context, mergedEarly));
  console.log(`[orchestrator] planning suggestions=${planningOutput.suggestions?.length || 0} actions=${planningOutput.actions.length}`);

  // Step 3: Tasks — receives planning suggestions, executes them + catches completions
  const domainOutputs = {
    people:   peopleOutput,
    projects: projectsOutput,
    planning: planningOutput,
  };
  const tasksOutput = await tasksAgent.run(message, sliceForTasks(context, domainOutputs));
  console.log(`[orchestrator] tasks=${tasksOutput.actions.length}`);

  // Step 5: Merge all real actions — suggestions are not actions, filter META types
  const META_TYPES = new Set(["ASK", "CLEAR_ASK"]);
  const allDomainActions = [
    ...mergedEarly,
    ...planningOutput.actions,
    ...tasksOutput.actions,
  ].filter(a => !META_TYPES.has(a.type));

  // Step 6: Composer — writes reply + decides on single optional ASK
  const allReasoning = {
    people:   peopleOutput.reasoning,
    projects: projectsOutput.reasoning,
    planning: planningOutput.reasoning,
    tasks:    tasksOutput.reasoning,
  };
  const composerOutput = await composerAgent.compose(
    message,
    sliceForComposer(context, allDomainActions, allReasoning)
  );

  // Step 7: Append ASK/CLEAR_ASK — mandatory asks bypass the 2-round cap
  const finalActions = [...allDomainActions];
  const currentRound = context.pendingInquiry?.clarificationRound || 0;
  const isMandatory = composerOutput.askAction?.mandatory === true;
  const canAsk = currentRound < 2 || isMandatory;

  if (composerOutput.askAction && canAsk) {
    if (context.pendingInquiry?.question) {
      finalActions.push({ type: "CLEAR_ASK", payload: {} });
    }
    finalActions.push({
      type: "ASK",
      payload: { ...composerOutput.askAction, clarificationRound: currentRound + 1 },
    });
  } else if (context.pendingInquiry?.question) {
    finalActions.push({ type: "CLEAR_ASK", payload: {} });
  }

  return {
    reply:         composerOutput.reply || "Done.",
    actions:       finalActions,
    contextSource: context.contextSource,
  };
}

module.exports = { run };
