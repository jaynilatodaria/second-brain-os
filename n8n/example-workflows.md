# n8n Workflow Blueprints for Second Brain OS

These are the three recommended workflows to set up in your n8n instance.
All of them POST to `http://localhost:3000/api/n8n`.

---

## Workflow 1: Daily Digest (7:00 AM)

**Trigger:** Cron — every day at 07:00  
**Node:** HTTP Request  
- Method: POST  
- URL: `http://localhost:3000/api/n8n`  
- Body (JSON):
```json
{ "event": "daily_digest" }
```
**Result:** Brain summarises open tasks and surfaces today's priorities.

---

## Workflow 2: Reminder Check (Every 2 hours)

**Trigger:** Cron — every 2 hours  
**Node:** HTTP Request  
- Method: POST  
- URL: `http://localhost:3000/api/n8n`  
- Body:
```json
{ "event": "reminder" }
```
**Result:** Brain checks for anything urgent or overdue and flags it.

---

## Workflow 3: Weekly Review (Friday 6:00 PM)

**Trigger:** Cron — every Friday at 18:00  
**Node:** HTTP Request  
- Method: POST  
- URL: `http://localhost:3000/api/n8n`  
- Body:
```json
{ "event": "weekly_review" }
```
**Result:** Brain summarises the week and proposes next week's priorities.

---

## Connecting the n8n route in server.js

Uncomment these two lines in `backend/server.js` when you're ready:

```js
const n8nRouter = require('./n8n/webhook-handler');
app.use('/api/n8n', n8nRouter);
```

---

## Optional: WhatsApp integration via WAHA

If you're running WAHA (your existing stack), you can forward WhatsApp
messages to `/api/message` by adding an HTTP Request node after your
WAHA trigger node:

- URL: `http://localhost:3000/api/message`
- Body: `{ "message": "{{$json.body.data.body}}" }`

The brain's reply will come back in the response and you can forward it
back to WhatsApp via another WAHA node.
