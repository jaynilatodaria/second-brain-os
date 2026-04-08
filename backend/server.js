require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const express    = require("express");
const cors       = require("cors");
const { ensureCollections, healthCheck } = require("./services/qdrantSync");
const dailyBriefing = require("./services/dailyBriefing");
const stateWatcher  = require("./services/stateWatcher");
const telegramBot   = require("./services/telegramBot");
const cron          = require("node-cron");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/api/health", async (req, res) => {
  const qdrantOk = await healthCheck();
  res.json({ status: "ok", time: new Date().toISOString(), qdrant: qdrantOk ? "ok" : "unreachable" });
});

app.get("/api/usage", async (req, res) => {
  const { readJson } = require("./utils/storage");
  res.json(await readJson("usage.json"));
});

ensureCollections()
  .then(() => console.log("✓ Qdrant collections ready"))
  .catch(err => console.warn("⚠ Qdrant unavailable:", err.message));

app.listen(PORT, () => console.log(`engine. running on port ${PORT}`));

telegramBot.start();

const CRON_TZ = { timezone: "Asia/Kolkata" };

cron.schedule("0 * * * *", async () => {
  console.log("[cron] hourly — state watcher");
  await stateWatcher.run();
}, CRON_TZ);

cron.schedule("0 7 * * *", async () => {
  console.log("[cron] 7am IST — morning briefing");
  await dailyBriefing.run("morning");
}, CRON_TZ);

cron.schedule("0 21 * * *", async () => {
  console.log("[cron] 9pm IST — evening briefing");
  await dailyBriefing.run("evening");
}, CRON_TZ);
