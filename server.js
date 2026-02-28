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

// ── SSE helper: yield parsed JSON events from a Cerebras/OpenAI streaming response ──
async function* parseSSEStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') return;
        try { yield JSON.parse(raw); } catch (_) { console.warn('[SSE] JSON parse error:', raw.slice(0, 80)); }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Web search tool definition ──
const MAX_TOOL_CALL_TURNS = 10;
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

  // Set SSE headers immediately so the client can start reading events
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function sendEvt(obj) {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  // Build system prompt based on mode
  const systemParts = ['You are MacAI, a highly capable AI assistant.'];
  if (doSearch) {
    systemParts.push('You are in Search Mode. You MUST use the web_search tool to gather current, accurate information before answering. Search thoroughly: collect 10–60 sources total depending on question complexity — use more searches for complex or multi-faceted questions. You may call web_search multiple times with different queries to fully cover the topic. Do NOT list or cite your sources at the end of your response; the sources are already displayed automatically below your message.');
  } else if (doFast) {
    systemParts.push('You are in Fast Mode. Respond quickly and concisely. Only use the web_search tool if the question strictly requires real-time or very recent information that you cannot answer from training data. If you do search, use at most one query and collect 0–3 sources. Do not perform multiple searches. Do NOT list or cite your sources at the end of your response; the sources are already displayed automatically below your message.');
  } else if (doThink) {
    systemParts.push('You are in Think Mode. Reason carefully and thoroughly before responding. Use the web_search tool when you need current or specific information to support your reasoning. Collect 20–50 sources total depending on question complexity — use multiple queries for thorough research on complex topics. Do NOT list or cite your sources at the end of your response; the sources are already displayed automatically below your message.');
  } else {
    systemParts.push('Use the web_search tool when you need current information, recent events, or specific facts to give an accurate and helpful answer. Typically 3–6 searches are sufficient; use more only when the question is genuinely complex or multi-faceted. After gathering enough information, ALWAYS provide a complete answer to the user — do NOT stop after searching without responding. Do NOT list or cite your sources at the end of your response; the sources are already displayed automatically below your message.');
  }

  const systemMessage = { role: 'system', content: systemParts.join('\n\n') };
  let toolMessages = [systemMessage, ...messages];
  const allSources = [];

  // Determine initial tool_choice based on mode
  let toolChoice = 'auto';
  if (doSearch && !noSearch) toolChoice = 'required';

  console.log(`→ model:${MODEL} search:${!!doSearch} think:${!!doThink} fast:${!!doFast} noSearch:${!!noSearch} toolChoice:${toolChoice}`);

  const t0 = Date.now();

  try {
    // Multi-turn tool call loop (max MAX_TOOL_CALL_TURNS turns to prevent runaway)
    for (let turn = 0; turn < MAX_TOOL_CALL_TURNS; turn++) {
      const requestBody = {
        model: MODEL,
        messages: toolMessages,
        max_tokens: doThink ? 16000 : 8192,
        stream: true,
      };

      // Attach tools unless search is disabled
      if (!noSearch) {
        requestBody.tools = [WEB_SEARCH_TOOL];
        // On the final allowed turn, force a text response so the model cannot
        // exhaust all turns with searches and leave the user without an answer.
        requestBody.tool_choice = (turn === MAX_TOOL_CALL_TURNS - 1) ? 'none' : toolChoice;
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

      if (!cr.ok) {
        const data = await cr.json();
        const errMsg = data?.error?.message || `HTTP ${cr.status}`;
        console.error('✗', errMsg);
        sendEvt({ type: 'error', message: errMsg });
        return res.end();
      }

      // Stream and accumulate this turn's response
      let content = '';
      let reasoning = '';
      const toolMap = {};   // index → {id, type, function: {name, arguments}}
      let isTextTurn = null; // null=unknown, true=text response, false=tool-call response

      for await (const evt of parseSSEStream(cr)) {
        const delta = evt.choices?.[0]?.delta;
        if (!delta) continue;

        // Detect turn type from first meaningful delta
        if (isTextTurn === null) {
          if (delta.tool_calls) isTextTurn = false;
          else if (delta.content != null || delta.reasoning != null) isTextTurn = true;
        }

        // Accumulate and forward content chunks for text turns only
        if (delta.content) {
          content += delta.content;
          if (isTextTurn) sendEvt({ type: 'chunk', text: delta.content });
        }

        // Accumulate reasoning (think mode only; not forwarded per-chunk)
        if (delta.reasoning) reasoning += delta.reasoning;

        // Reconstruct streamed tool_calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index;
            if (!toolMap[i]) toolMap[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) toolMap[i].id = tc.id;
            if (tc.function?.name)      toolMap[i].function.name      += tc.function.name;
            if (tc.function?.arguments) toolMap[i].function.arguments += tc.function.arguments;
          }
        }
      }

      const toolCalls = Object.keys(toolMap).length > 0 ? Object.values(toolMap) : null;

      if (toolCalls) {
        // Tool-call turn: append assistant message, execute each tool, continue loop
        toolMessages.push({
          role: 'assistant',
          content: content || null,
          tool_calls: toolCalls,
        });

        // After first required search, allow auto for subsequent turns
        toolChoice = 'auto';

        for (const call of toolCalls) {
          if (call.function.name === 'web_search') {
            let args;
            try { args = JSON.parse(call.function.arguments); } catch (_) { args = {}; }
            const query = args.query || '';
            let resultCount;
            if (doFast)        resultCount = 3;
            else if (doSearch) resultCount = 20;
            else if (doThink)  resultCount = 25;
            else               resultCount = 8;
            console.log(`⌕ web_search (${resultCount} results): "${query.slice(0, 80)}"`);
            // Notify client so the status step can update
            sendEvt({ type: 'search', query: query.slice(0, 80) });
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

      // Final text response — chunks were already streamed above
      let reply = content;
      // Only expose thinking/reasoning when think mode is explicitly enabled.
      // Also strip any stray <think> tags that the model may emit in non-think mode.
      const thinking = doThink ? (reasoning || null) : null;
      if (!doThink) {
        reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      }
      console.log(`✓ reply ${reply.length} chars${thinking ? ', reasoning ' + thinking.length + ' chars' : ''} sources:${allSources.length}`);

      // Send metadata events after the content stream
      if (thinking) sendEvt({ type: 'thinking', text: thinking });
      sendEvt({ type: 'sources', data: allSources });
      sendEvt({ type: 'done', responseMs: Date.now() - t0 });
      return res.end();
    }

    // Fallback if the loop exhausted without a final response
    sendEvt({ type: 'sources', data: allSources });
    sendEvt({ type: 'done', responseMs: Date.now() - t0 });
    res.end();
  } catch (err) {
    console.error('✗', err.message);
    sendEvt({ type: 'error', message: err.message });
    res.end();
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
