const axios = require("axios");
const { readJson, writeJson } = require("./storage");

// Cost per million tokens (USD)
const PRICING = {
  "claude-sonnet-4-6":          { input: 3.00, output: 15.00 },
  "claude-haiku-4-5-20251001":  { input: 0.80, output:  4.00 },
};

async function trackUsage(model, inputTokens, outputTokens) {
  try {
    const rates = PRICING[model] || { input: 3.00, output: 15.00 };
    const cost = (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;

    const data = (await readJson("usage.json")) || { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, by_model: {} };
    data.calls = (data.calls || 0) + 1;
    data.input_tokens = (data.input_tokens || 0) + inputTokens;
    data.output_tokens = (data.output_tokens || 0) + outputTokens;
    data.cost_usd = Math.round(((data.cost_usd || 0) + cost) * 1_000_000) / 1_000_000;
    data.by_model = data.by_model || {};
    data.by_model[model] = data.by_model[model] || { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
    data.by_model[model].calls += 1;
    data.by_model[model].input_tokens += inputTokens;
    data.by_model[model].output_tokens += outputTokens;
    data.by_model[model].cost_usd = Math.round((data.by_model[model].cost_usd + cost) * 1_000_000) / 1_000_000;
    data.updated_at = new Date().toISOString();
    await writeJson("usage.json", data);
  } catch (err) {
    console.warn("[usage] failed to track:", err.message);
  }
}

async function callAI({ model, system, userPrompt, maxTokens = 800, rawText = false }) {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userPrompt }],
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    }
  );

  const usage = response.data.usage;
  if (usage) trackUsage(model, usage.input_tokens || 0, usage.output_tokens || 0);

  const raw = response.data.content?.[0]?.text || "";
  if (rawText) return raw.trim();
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

module.exports = { callAI };
