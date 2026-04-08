# engine. — Second Brain OS

A personal AI-powered second brain that remembers your tasks, projects, and people through natural conversation. Talk to it like a journal. It organises everything automatically.

---

## What it does

You type naturally — "I need to plan my trip to Europe - flights, hotels, itinerary" — and the system:

- Creates a task with a deadline (`dueDate: 2026-04-25`)
- Creates a project for the Europe trip
- Adds relevant people or places mentioned to your data
- Escalates priority as the deadline approaches (daily sweep at 8am)
- Surfaces it as a recommendation on your Focus tab
- Asks one follow-up question if something is unclear ("Which cities are you visiting?")
- Waits for your answer before saving data

Everything is stored locally in JSON files. The only thing that leaves your machine is the message + context sent to Anthropic's API for AI processing.

---

## Prerequisites

- Node.js 18+
- Docker (for Qdrant)
- Anthropic API key
- OpenAI API key (for embeddings only)

---

## Setup

**1. Clone and install**
```bash
git clone <repo>
cd second-brain-os
npm install
```

**2. Start Qdrant**
```bash
docker run -p 6333:6333 qdrant/qdrant
```

**3. Create `.env` in the project root**
```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
QDRANT_URL=http://localhost:6333
PORT=3000
```

**4. Start the server**
```bash
npm start
```

**5. Open the app**
```
http://localhost:3000
```

---

## Project structure

```
second-brain-os/
├── backend/
│   ├── server.js                   # Express server + cron jobs
│   ├── agents/
│   │   ├── peopleAgent.js          # Manages people registry
│   │   ├── projectsAgent.js        # Manages projects registry
│   │   ├── planningAgent.js        # Adds deadlines and priorities
│   │   ├── tasksAgent.js           # Synthesises final task list
│   │   ├── composerAgent.js        # Writes reply + asks questions
│   │   └── recommendationsAgent.js # Runs twice daily, surfaces insights
│   ├── services/
│   │   ├── orchestrator.js         # Runs the agent pipeline
│   │   ├── agentContext.js         # Slices context for each agent
│   │   ├── contextLoader.js        # Loads Qdrant or JSON context
│   │   ├── actionExecutor.js       # Executes actions against storage
│   │   ├── deadlineSweep.js        # Daily deadline escalation (no AI)
│   │   └── qdrantSync.js           # Vector search via Qdrant + OpenAI embeddings
│   ├── routes/
│   │   ├── message.js              # POST /api/message (preview / confirm)
│   │   ├── data.js                 # GET /api/data
│   │   └── recommendations.js      # GET /api/recommendations
│   └── utils/
│       ├── callAI.js               # Anthropic API wrapper + usage tracking
│       ├── storage.js              # JSON file read/write
│       └── journal.js              # Append to journal.md
├── frontend/
│   └── index.html                  # Single-page app (vanilla JS)
├── data/                           # All persistent data (gitignored)
│   ├── memory.json                 # Tasks
│   ├── projects.json               # Projects
│   ├── people.json                 # People
│   ├── sessionContext.json         # Last 10 conversation turns
│   ├── pendingInquiry.json         # Active follow-up question
│   ├── recommendations.json        # AI recommendations
│   ├── usage.json                  # API cost tracking
│   └── journal.md                  # Append-only conversation log
└── scripts/
    └── reset-qdrant.js             # Wipe and recreate Qdrant collections
```

---

## The agent pipeline

Each message goes through a 5-agent pipeline. No router — each agent self-gates.

```
Message + Context
    │
    ├── [parallel] People Agent      → ADD_PERSON, UPDATE_PERSON
    ├── [parallel] Projects Agent    → ADD_PROJECT, UPDATE_PROJECT
    │
    └── Planning Agent               → UPDATE_TASK (deadlines/priority on existing tasks only)
          │
          └── Tasks Agent            → ADD_TASK, UPDATE_TASK
                │
                └── Composer Agent   → reply text + optional ASK
```

**People Agent** (Sonnet) — builds and maintains person profiles. Detects relationship labels ("my sister"), creates placeholders, deduplicates by name and relationship.

**Projects Agent** (Haiku) — tracks initiatives. Deduplicates by meaning ("Goa trip" = "relaxation trip"). Auto-updates status based on context.

**Planning Agent** (Haiku) — temporal intelligence only. Sets `dueDate` and escalates `priority` on tasks that already exist in storage. Never creates tasks or touches status. Returns `[]` most turns.

**Tasks Agent** (Sonnet) — reads all domain reasoning and synthesises the final task list. Extracts `dueDate` as an ISO field from natural language. Detects completions and ambiguous references.

**Composer Agent** (Sonnet) — writes a 1-2 sentence reply and decides on one optional follow-up question. The only agent that can generate `ASK`. Max 2 clarifying questions per topic.

---

## The ASK / deferred actions flow

When the Composer asks a question, data is **not saved until the question is answered**.

```
Turn 1:  "My sister is getting married"
         → People agent creates "Sister" placeholder
         → Composer: ASK "What's your sister's name?"
         → Data actions stored in pendingInquiry.deferredActions
         → Nothing written to storage yet

Turn 2:  "Her name is Priya"
         → CLEAR_ASK fires
         → Deferred actions prepended and executed
         → Sister renamed to Priya, project and tasks saved
```

---

## Deadlines

When you mention a date, the Tasks Agent extracts it as a structured `dueDate` field (`YYYY-MM-DD`). A code-level fallback in `tasksAgent.js` parses dates from notes/title text if the AI omits the field.

**Daily sweep (8am)** — `deadlineSweep.js` runs with no AI call:
- Overdue → `priority: high`, prepends "Overdue since YYYY-MM-DD." to notes
- Due within 2 days → `priority: high`
- Due within 7 days (if currently low) → `priority: medium`

**Recommendations (9am + 6pm)** — reads `dueDate` fields directly, generates actionable suggestions visible on the Focus tab.

---

## Scheduled jobs

| Time | Job |
|------|-----|
| 8:00am | Deadline sweep — escalate priorities based on dueDate |
| 9:00am | Recommendations — generate Focus tab insights |
| 6:00pm | Recommendations — evening refresh |

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/message` | Send message, execute immediately |
| `POST` | `/api/message/preview` | Interpret only, no execution |
| `POST` | `/api/message/confirm` | Execute pre-approved actions |
| `GET`  | `/api/data` | Full current state |
| `GET`  | `/api/data/journal` | Journal as plain text |
| `GET`  | `/api/recommendations` | Current recommendations |
| `GET`  | `/api/health` | Server + Qdrant status |
| `GET`  | `/api/usage` | API cost tracking |

---

## Context loading

Each message triggers a Qdrant semantic search before agents run:
- Top 8 tasks most similar to the message
- Top 5 projects most similar
- Top 5 people most similar

If Qdrant is unreachable, falls back to loading all JSON files in full. Session history (last 10 turns) and any pending inquiry are always loaded regardless.

---

## Data privacy

All data files are local. The agent pipeline sends your message + relevant context to **Anthropic's API** for processing. Embeddings are generated via **OpenAI's API**.

To make it fully local: replace `backend/utils/callAI.js` with a local model (Ollama, LM Studio) and replace the `embed()` function in `backend/services/qdrantSync.js` with a local embedding model.

---

## Resetting data

**JSON only:**
```bash
echo '{"entries":[]}' > data/memory.json
echo '{"projects":[]}' > data/projects.json
echo '{"people":[]}' > data/people.json
echo '{"history":[]}' > data/sessionContext.json
echo 'null' > data/pendingInquiry.json
echo '{"items":[]}' > data/recommendations.json
```

**Qdrant only:**
```bash
node scripts/reset-qdrant.js
```

---

## Modifying agent behaviour

| What to change | File | What to edit |
|----------------|------|-------------|
| People profiling rules | `agents/peopleAgent.js` | `SYSTEM_PROMPT` |
| Project status logic | `agents/projectsAgent.js` | `SYSTEM_PROMPT` |
| Deadline escalation rules | `agents/planningAgent.js` | `PLANNING PRINCIPLES` |
| Task completion detection | `agents/tasksAgent.js` | `TASK COMPLETION DETECTION` |
| Reply tone / question budget | `agents/composerAgent.js` | `SYSTEM_PROMPT` |
| Context window size | `services/contextLoader.js` | Numbers `8, 5, 5` on line 14 |
| Session history length | `routes/message.js` | `SESSION_LIMIT` constant |
| Clarifying question budget | `services/orchestrator.js` | `currentRound < 2` condition |
| Daily sweep thresholds | `services/deadlineSweep.js` | Day thresholds in `run()` |
