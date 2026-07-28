const test = require('node:test');
const assert = require('node:assert/strict');
const { createTravelAI, getConfig, validateConfig, validateRequest } = require('../lib/travel-ai.cjs');
const { createServer } = require('../server.cjs');
const skillContract = require('../skills/build-travel-ai-qa/scripts/travel-ai-contract.cjs');
const { loadEnvFile } = require('../lib/load-env.cjs');

function responseValue(overrides = {}) {
  return {
    mode: 'PLAN', intent: 'answer_question', assistant_message: '这是回答。',
    requires_confirmation: false, missing_fields: [], proposal: null,
    results: [{ type: 'answer', title: '建议', summary: '测试建议', destination: '京都', details: [] }],
    citations: [], warnings: [], ...overrides
  };
}

function modifyProposal() {
  return {
    operation: 'modify_current', target_id: 'destination-0', destination: '京都', duration_days: 7,
    preserve_unmentioned: true, summary: '把京都行程调整为 7 天',
    patch: {
      profile: null,
      plan: {
        destination: null, duration_days: 7, waypoint: null, title: '京都7日旅行计划', kicker: null,
        intro: null, overview: null, highlights: null, routes: null, food: null, packing: null, quote: null
      }
    }
  };
}

test('request validation bounds and normalizes conversation', () => {
  assert.throws(() => validateRequest({ message: '' }), /请输入旅行问题/);
  const value = validateRequest({ message: ' 京都怎么玩？ ', conversation: Array.from({ length: 20 }, () => ({ role: 'user', content: 'x' })) });
  assert.equal(value.message, '京都怎么玩？');
  assert.equal(value.conversation.length, 12);
  let deep = {};
  for (let index = 0; index < 10; index += 1) deep = { child: deep };
  assert.throws(() => validateRequest({ message: 'test', profile: deep }), /嵌套层级过深/);
});

test('local env loading preserves existing process values and model config rejects Auto', t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-ai-env-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.env');
  fs.writeFileSync(file, 'LLM_API_KEY=test-secret\nLLM_MODEL=doubao-seed-2.1-turbo\n');
  const env = { LLM_MODEL: 'deepseek-v4-pro' };
  assert.equal(loadEnvFile(file, env), true);
  assert.equal(env.LLM_API_KEY, 'test-secret');
  assert.equal(env.LLM_MODEL, 'deepseek-v4-pro');
  assert.throws(() => validateConfig(getConfig({ LLM_API_KEY: 'x', LLM_MODEL: 'Auto' })), /不支持 Auto/);
  assert.throws(() => validateConfig(getConfig({ LLM_API_KEY: 'x', LLM_MODEL: 'unknown', LLM_ALLOWED_MODELS: 'glm-5.2' })), /不在允许/);
});

test('mock provider supports a dependency-free end-to-end answer', async () => {
  const ai = await createTravelAI();
  const value = await ai.chat({ message: '京都有什么推荐？', current_plan: { city: '京都' } }, { LLM_PROVIDER: 'mock' });
  assert.equal(value.intent, 'answer_question');
  assert.equal(value.requires_confirmation, false);
  assert.match(value.assistant_message, /京都/);
});

test('Responses API uses web search and enforces mutation confirmation', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true, status: 200,
      json: async () => ({ output_text: JSON.stringify(responseValue({
        intent: 'modify_current', requires_confirmation: false, proposal: modifyProposal(), results: []
      })), output: [] })
    };
  };
  const ai = await createTravelAI({ fetchImpl });
  const value = await ai.chat({ message: '把当前行程改为7天', current_plan: { city: '京都' } }, { LLM_API_KEY: 'test-key', LLM_MODEL: 'test-model' });
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.body.tools[0].type, 'web_search');
  assert.equal(request.body.text.format.type, 'json_schema');
  assert.equal(request.body.instructions, skillContract.SYSTEM_PROMPT);
  assert.deepEqual(request.body.text.format.schema, skillContract.RESPONSE_SCHEMA);
  assert.equal(value.requires_confirmation, true);
});

test('Responses API omits web search fields when retrieval is disabled', async () => {
  let requestBody;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true, status: 200,
      json: async () => ({ output_text: JSON.stringify(responseValue()), output: [] })
    };
  };
  const ai = await createTravelAI({ fetchImpl });
  await ai.chat({ message: '京都有什么推荐？' }, {
    LLM_API_KEY: 'test-key',
    LLM_MODEL: 'test-model',
    LLM_WEB_SEARCH_ENABLED: 'false'
  });
  assert.equal('tools' in requestBody, false);
  assert.equal('tool_choice' in requestBody, false);
  assert.equal('include' in requestBody, false);
});

test('connection test uses a bounded lightweight Web Search request', async () => {
  let requestBody;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true, status: 200,
      json: async () => ({ output: [{ type: 'web_search_call', action: { sources: [{ url: 'https://www.dpm.org.cn/', title: '故宫博物院' }] } }] })
    };
  };
  const ai = await createTravelAI({ fetchImpl });
  const result = await ai.testConnection({ LLM_API_KEY: 'test-key', LLM_MODEL: 'test-model' });
  assert.equal(requestBody.tool_choice, 'required');
  assert.equal(requestBody.tools[0].type, 'web_search');
  assert.equal(requestBody.max_output_tokens, 64);
  assert.equal('text' in requestBody, false);
  assert.equal(result.source_count, 1);
});

test('web search timeout fails without a model-only fallback', async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const error = new Error('timed out');
    error.name = 'AbortError';
    throw error;
  };
  const ai = await createTravelAI({ fetchImpl });
  await assert.rejects(() => ai.chat({ message: '推荐三个自然风景目的地' }, {
    LLM_API_KEY: 'test-key',
    LLM_MODEL: 'test-model'
  }), error => error.code === 'LLM_TIMEOUT');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tools[0].type, 'web_search');
});

test('retrieval sources are normalized into trusted citations', async () => {
  const sourceUrl = 'https://example.com/kyoto';
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({
      output_text: JSON.stringify(responseValue()),
      output: [{ type: 'web_search_call', action: { sources: [{ url: sourceUrl, title: 'Kyoto guide' }] } }]
    })
  });
  const ai = await createTravelAI({ fetchImpl });
  const value = await ai.chat({ message: '京都最近有什么活动？' }, { LLM_API_KEY: 'test-key' });
  assert.equal(value.citations.length, 1);
  assert.equal(value.citations[0].url, sourceUrl);
  assert.equal(value.citations[0].provider, 'openai-web-search');
});

test('HTTP endpoint connects the demo request to the AI service', async t => {
  const server = createServer({ env: { LLM_PROVIDER: 'mock' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '京都怎么安排？', current_plan: { city: '京都' } })
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.intent, 'answer_question');
});

test('HTTP endpoint fails closed when no API key is configured', async t => {
  const server = createServer({ env: { LLM_PROVIDER: 'openai', LLM_API_KEY: '' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '推荐目的地' })
  });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error.code, 'LLM_NOT_CONFIGURED');
  assert.doesNotMatch(JSON.stringify(payload), /Bearer|api[_-]?key.*[A-Za-z0-9]{8}/i);
});

test('local LLM config endpoint stores the key in server memory without returning it', async t => {
  let authorization = '';
  const server = createServer({
    env: {
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: '',
      LLM_MODEL: 'doubao-seed-2.1-turbo',
      LLM_ALLOWED_MODELS: 'doubao-seed-2.0-lite,doubao-seed-2.1-turbo'
    },
    fetchImpl: async (_url, options) => {
      authorization = options.headers.authorization;
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(responseValue()), output: [] }) };
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/api/llm/config`;
  const initial = await (await fetch(endpoint)).json();
  assert.equal(initial.configured, false);
  assert.equal('api_key' in initial, false);
  const savedResponse = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: 'memory-only-secret', base_url: 'https://ark.cn-beijing.volces.com/api/plan/v3', model: 'doubao-seed-2.0-lite' })
  });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.configured, true);
  assert.equal(saved.model, 'doubao-seed-2.0-lite');
  assert.doesNotMatch(JSON.stringify(saved), /memory-only-secret/);
  const testResponse = await fetch(`${endpoint}/test`, { method: 'POST' });
  assert.equal(testResponse.status, 200);
  const tested = await testResponse.json();
  assert.equal(tested.ok, true);
  assert.equal(tested.model, 'doubao-seed-2.0-lite');
  await fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '京都有什么推荐？' })
  });
  assert.equal(authorization, 'Bearer memory-only-secret');
});

test('static server never exposes environment or backend source files', async t => {
  const server = createServer({ env: { LLM_PROVIDER: 'mock' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  for (const pathname of ['/.env', '/.env.example', '/server.cjs', '/lib/travel-ai.cjs']) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
    assert.equal(response.status, 404, pathname);
  }
});

test('browser code calls the backend and no longer invokes the keyword mock', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /fetch\('\/api\/ai\/chat'/);
  assert.match(html, /fetch\('\/api\/llm\/config'/);
  assert.match(html, /fetch\('\/api\/llm\/config\/test'/);
  assert.match(html, /data-ai-action="dismiss-response"/);
  assert.match(html, /if \(!open\) \$\('#aiResponse'\)\.classList\.remove\('show'\)/);
  assert.match(html, /id="apiSettingsButton"[^>]*>API 设置<\/button>/);
  assert.match(html, /id="apiModal"[^>]*hidden/);
  assert.match(html, />保存并测试<\/button>/);
  assert.match(html, /id="apiModelInput"[^>]*name="model"[^>]*type="text"/);
  assert.doesNotMatch(html, /id="apiModelSelect"/);
  assert.doesNotMatch(html, /apiModelSuggestions|<datalist/);
  assert.doesNotMatch(html, /火山方舟/);
  assert.doesNotMatch(html, /id="aiConfig"/);
  assert.doesNotMatch(html, /localStorage\.setItem\([^\n]*api[_-]?key/i);
  assert.doesNotMatch(html, /function classifyAIRequest/);
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});
