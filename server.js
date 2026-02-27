import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY || '';

// Load .env manually (no dotenv dependency needed)
try {
  const env = readFileSync(path.join(__dirname, '.env'), 'utf8');
  env.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const [key, ...val] = line.split('=');
    if (key && !process.env[key]) process.env[key] = val.join('=').trim();
  });
} catch (_) { /* .env optional */ }

const CEREBRAS_KEY_RESOLVED = process.env.CEREBRAS_API_KEY || CEREBRAS_KEY;

// Only model available
const MODEL = 'gpt-oss-120b';

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── SearXNG search (local instance, no API key needed) ──
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8888';

app.get('/ping', (req, res) => res.json({ ok: true }));

app.get('/api/search-health', async (_req, res) => {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(`${SEARXNG_URL}/healthz`, { signal: ctrl.signal });
    clearTimeout(timer);
    res.json({ ok: resp.ok, searxng: SEARXNG_URL });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message, searxng: SEARXNG_URL });
  }
});

async function searxngSearch(query, count = 5) {
  try {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      safesearch: '0',
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const resp = await fetch(`${SEARXNG_URL}/search?${params}`, {
      signal: ctrl.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'MacAI/1.0',
      },
    });
    clearTimeout(timer);

    if (!resp.ok) throw new Error(`SearXNG HTTP ${resp.status}`);
    const data = await resp.json();

    const hits = (data.results || []).slice(0, count).map(r => ({
      title: r.title   || '',
      url:   r.url     || '',
      desc:  r.content || '',
    }));

    return { results: hits };
  } catch (err) {
    console.warn('SearXNG search error:', err.message);
    if (err.name === 'AbortError') {
      console.warn('  → Request timed out. Is SearXNG running? Check: docker compose up -d');
    } else if (err.cause?.code === 'ECONNREFUSED') {
      console.warn(`  → Connection refused at ${SEARXNG_URL}. Start SearXNG: docker compose up -d`);
    }
    return { results: [], error: err.message };
  }
}

// ── Web search tool definition ──
const MAX_TOOL_CALL_TURNS = 6;
const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    strict: true,
    description: 'Search the web for current information, recent events, or specific facts. Use this tool whenever the question requires up-to-date data beyond your training knowledge.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to look up on the web.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

app.post('/api/chat', async (req, res) => {
  const { messages, search: doSearch, think: doThink, fast: doFast, noSearch } = req.body;

  if (!Array.isArray(messages) || !messages.length)
    return res.status(400).json({ error: 'messages array required' });

  if (!CEREBRAS_KEY_RESOLVED)
    return res.status(500).json({ error: 'CEREBRAS_API_KEY not set' });

  // Build system prompt based on mode
  const systemParts = ['You are MacAI, a highly capable AI assistant.'];
  if (doSearch) {
    systemParts.push('You are in Search Mode. You MUST use the web_search tool to gather current, accurate information before answering. Always search before responding to ensure your answer is up-to-date. You may call web_search multiple times with different queries if needed to fully answer the question.');
  } else if (doFast) {
    systemParts.push('You are in Fast Mode. Respond quickly and concisely. Only use the web_search tool if the question strictly requires real-time or very recent information that you cannot answer from training data.');
  } else if (doThink) {
    systemParts.push('You are in Think Mode. Reason carefully and thoroughly before responding. Use the web_search tool when you need current or specific information to support your reasoning. Take your time to think through the problem deeply.');
  } else {
    systemParts.push('Use the web_search tool when you need current information, recent events, or specific facts to give an accurate and helpful answer.');
  }

  const systemMessage = { role: 'system', content: systemParts.join('\n\n') };
  let toolMessages = [systemMessage, ...messages];
  const allSources = [];

  // Determine initial tool_choice based on mode
  // search mode: force LLM to search; noSearch (greetings etc.): no tools
  let toolChoice = 'auto';
  if (doSearch && !noSearch) toolChoice = 'required';

  console.log(`→ model:${MODEL} search:${!!doSearch} think:${!!doThink} fast:${!!doFast} noSearch:${!!noSearch} toolChoice:${toolChoice}`);

  try {
    // Multi-turn tool call loop (max MAX_TOOL_CALL_TURNS turns to prevent runaway)
    for (let turn = 0; turn < MAX_TOOL_CALL_TURNS; turn++) {
      const requestBody = {
        model: MODEL,
        messages: toolMessages,
        max_tokens: doThink ? 16000 : 8192,
      };

      // Attach tools unless search is disabled
      if (!noSearch) {
        requestBody.tools = [WEB_SEARCH_TOOL];
        requestBody.tool_choice = toolChoice;
      }

      // Enable reasoning for think mode
      if (doThink) {
        requestBody.reasoning_format = 'parsed';
      }

      const cr = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CEREBRAS_KEY_RESOLVED}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const data = await cr.json();
      if (!cr.ok) {
        const msg = data?.error?.message || `HTTP ${cr.status}`;
        console.error('✗', msg);
        return res.status(cr.status).json({ error: msg });
      }

      const msg = data.choices?.[0]?.message;
      if (!msg) break;

      // Handle tool calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Append the assistant's tool-call turn
        toolMessages.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.tool_calls,
        });

        // After first required search, allow auto for subsequent turns
        toolChoice = 'auto';

        // Execute each requested tool call
        for (const call of msg.tool_calls) {
          if (call.function.name === 'web_search') {
            let args;
            try { args = JSON.parse(call.function.arguments); } catch (_) { args = {}; }
            const query = args.query || '';
            const resultCount = doFast ? 3 : doSearch ? 8 : 5;
            console.log(`⌕ web_search (${resultCount} results): "${query.slice(0, 80)}"`);
            const { results, error } = await searxngSearch(query, resultCount);
            if (results.length) allSources.push(...results);
            const searchResult = results.length
              ? results.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.desc}`).join('\n\n')
              : `No results found${error ? ': ' + error : ''}`;
            toolMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: searchResult,
            });
          }
        }
        // Continue loop to get the final response
        continue;
      }

      // No tool calls — final response
      const reply = msg.content || '';
      const thinking = msg.reasoning || null;
      console.log(`✓ reply ${reply.length} chars${thinking ? ', reasoning ' + thinking.length + ' chars' : ''} sources:${allSources.length}`);
      return res.json({ reply, sources: allSources, thinking });
    }

    // Fallback if the loop exhausted without a final response
    return res.json({ reply: '', sources: allSources, thinking: null });
  } catch (err) {
    console.error('✗', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✓ http://localhost:${PORT}`);
  if (!CEREBRAS_KEY_RESOLVED) console.warn('⚠  CEREBRAS_API_KEY not set');

  // Check SearXNG connectivity on startup
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const resp = await fetch(`${SEARXNG_URL}/healthz`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (resp.ok) console.log(`✓ SearXNG reachable at ${SEARXNG_URL}`);
    else console.warn(`⚠  SearXNG returned HTTP ${resp.status} at ${SEARXNG_URL}`);
  } catch (_) {
    console.warn(`⚠  SearXNG not reachable at ${SEARXNG_URL} — run: docker compose up -d`);
  }
});
