const test = require('node:test');
const assert = require('node:assert/strict');
const { createTravelAI, getConfig, validateConfig, validateRequest, responseSchemaForContext, isAccommodationRequest, hasAccommodationBudget, accommodationQueryMessage, wantsXiaohongshu, buildXiaohongshuQuery, buildXiaohongshuWebSearchQuery, buildAccommodationPriceWebSearchQuery } = require('../lib/travel-ai.cjs');
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
        intro: null, overview: null, highlights: null, routes: null, food: null, accommodation: null, daily_stays: null, packing: null, quote: null
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
  const apply = validateRequest({
    message: '根据回答修改当前行程',
    action: 'apply_answer_to_current_plan',
    answer_context: {
      assistant_message: '京都新建议',
      results: [{ title: '清晨路线', summary: '避开人流', details: ['先去清水寺'] }],
      citations: [{ title: '公开攻略', url: 'https://example.com/guide', provider: 'web' }]
    }
  });
  assert.equal(apply.action, 'apply_answer_to_current_plan');
  assert.equal(apply.answer_context.results[0].title, '清晨路线');
  assert.throws(() => validateRequest({ message: '修改', action: 'apply_answer_to_current_plan', answer_context: { results: [] } }), /没有可用于修改行程/);
});

test('apply-answer requests require a complete non-null plan proposal', () => {
  const regular = responseSchemaForContext({ action: null });
  assert.equal(regular, skillContract.RESPONSE_SCHEMA);
  const apply = responseSchemaForContext({ action: 'apply_answer_to_current_plan' });
  assert.deepEqual(apply.properties.intent.enum, ['modify_current']);
  assert.deepEqual(apply.properties.proposal.properties.operation.enum, ['modify_current']);
  const plan = apply.properties.proposal.properties.patch.properties.plan;
  for (const field of ['overview', 'highlights', 'routes', 'food', 'accommodation', 'daily_stays']) {
    assert.equal(plan.properties[field].type, 'array');
  }
});

test('selected-text edits validate a bounded quote and force a modification proposal', () => {
  const request = validateRequest({
    message: '把这句话改得更简洁',
    action: 'edit_selected_text',
    current_plan: { id: 'destination-0', city: '京都', intro: '这是我期待已久的京都之旅。' },
    selection_context: { text: '期待已久的京都之旅', field: 'intro', field_label: '行程简介' }
  });
  assert.equal(request.action, 'edit_selected_text');
  assert.deepEqual(request.selection_context, { text: '期待已久的京都之旅', field: 'intro', field_label: '行程简介', item_index: null });
  assert.throws(() => validateRequest({
    message: '修改', action: 'edit_selected_text', current_plan: {}, selection_context: { text: 'x', field: 'unknown' }
  }), /引用的行程文字无效/);
  const schema = responseSchemaForContext(request);
  assert.deepEqual(schema.properties.intent.enum, ['modify_current']);
  assert.deepEqual(schema.properties.requires_confirmation.enum, [true]);
});

test('system prompt requires detailed evidence-backed accommodation research', () => {
  assert.match(skillContract.SYSTEM_PROMPT, /For any question or proposal involving accommodation, perform Web Search/);
  assert.match(skillContract.SYSTEM_PROMPT, /property name.*neighborhood.*lodging type.*nearest useful transit/i);
  assert.match(skillContract.SYSTEM_PROMPT, /official site and a reputable booking or map source/i);
  assert.match(skillContract.SYSTEM_PROMPT, /Do not claim live room availability/);
  assert.match(skillContract.SYSTEM_PROMPT, /default currency is CNY/);
  assert.match(skillContract.SYSTEM_PROMPT, /require the user's acceptable nightly price range/i);
  assert.match(skillContract.SYSTEM_PROMPT, /range without a currency.*CNY/i);
  assert.match(skillContract.SYSTEM_PROMPT, /always run the exact site-restricted query/);
  assert.match(skillContract.SYSTEM_PROMPT, /Exclude properties with credible material red flags/);
  assert.match(skillContract.SYSTEM_PROMPT, /price_web_search_query/);
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

test('xiaohongshu retrieval is explicitly triggered and produces a focused query', () => {
  assert.equal(wantsXiaohongshu('帮我查小红书上的京都咖啡店攻略'), true);
  assert.equal(wantsXiaohongshu('京都咖啡店攻略'), false);
  assert.equal(buildXiaohongshuQuery('帮我查小红书上的京都咖啡店攻略'), '京都咖啡店');
  assert.equal(buildXiaohongshuWebSearchQuery('帮我查小红书上的京都咖啡店攻略'), 'site:xiaohongshu.com 京都咖啡店攻略');
  assert.equal(buildXiaohongshuWebSearchQuery('使用现有 Web Search 搜索 site:xiaohongshu.com 京都攻略'), 'site:xiaohongshu.com 京都攻略');
  assert.equal(isAccommodationRequest('推荐京都酒店'), true);
  assert.equal(wantsXiaohongshu('推荐京都酒店'), true);
  assert.equal(hasAccommodationBudget({ message: '推荐京都酒店，每晚预算 ¥600–1,000', conversation: [], profile: {} }), true);
  assert.equal(buildXiaohongshuWebSearchQuery('京都酒店，每晚预算 ¥600–1,000'), 'site:xiaohongshu.com 京都酒店 每晚预算 ¥600–1 000 酒店 避雷 踩雷');
  assert.match(buildAccommodationPriceWebSearchQuery('京都酒店，每晚预算 ¥600–1,000'), /酒店 官网 每晚价格 人民币$/);
  assert.equal(accommodationQueryMessage({ message: '¥600–1,000/晚', conversation: [{ role: 'user', content: '推荐京都酒店' }] }), '推荐京都酒店 ¥600–1,000/晚');
});

test('accommodation search asks for a nightly budget before retrieval', async () => {
  let fetchCalls = 0;
  const ai = await createTravelAI({ fetchImpl: async () => { fetchCalls += 1; throw new Error('should not fetch'); } });
  const value = await ai.chat({ message: '推荐几家京都住宿', conversation: [], profile: {} }, {});
  assert.equal(value.intent, 'clarify');
  assert.deepEqual(value.missing_fields, ['accommodation_price_range']);
  assert.match(value.assistant_message, /未指定币种时默认使用人民币/);
  assert.equal(fetchCalls, 0);
});

test('priced accommodation search injects Xiaohongshu risk and general price queries', async () => {
  let synthesisContext;
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body);
    synthesisContext = JSON.parse(request.input[0].content[0].text);
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(responseValue()), output: [] }) };
  };
  const ai = await createTravelAI({ fetchImpl });
  await ai.chat({ message: '推荐京都酒店，每晚预算 ¥600–1,000' }, {
    LLM_API_KEY: 'test-key', LLM_MODEL: 'test-model', XHS_SEARCH_ENABLED: 'false', LLM_WEB_SEARCH_ENABLED: 'true'
  });
  assert.match(synthesisContext.retrieval.xiaohongshu.web_search_query, /^site:xiaohongshu\.com .*酒店 避雷 踩雷$/);
  assert.match(synthesisContext.retrieval.accommodation.price_web_search_query, /酒店 官网 每晚价格 人民币$/);
});

test('budget-only follow-up retains the prior accommodation search topic', async () => {
  let synthesisContext;
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body);
    synthesisContext = JSON.parse(request.input[0].content[0].text);
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(responseValue()), output: [] }) };
  };
  const ai = await createTravelAI({ fetchImpl });
  await ai.chat({
    message: '¥600–1,000/晚',
    conversation: [{ role: 'user', content: '推荐京都酒店' }, { role: 'assistant', content: '请提供每晚预算。' }]
  }, { LLM_API_KEY: 'test-key', LLM_MODEL: 'test-model', XHS_SEARCH_ENABLED: 'false', LLM_WEB_SEARCH_ENABLED: 'true' });
  assert.match(synthesisContext.retrieval.xiaohongshu.web_search_query, /京都酒店.*避雷 踩雷/);
  assert.match(synthesisContext.retrieval.accommodation.price_web_search_query, /京都酒店/);
});

test('xiaohongshu search and detail evidence are injected before synthesis', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (url.endsWith('/api/v1/feeds/search')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: {
            feeds: [{
              id: 'note-1', xsecToken: 'token-1',
              noteCard: { displayTitle: '京都咖啡店实测', user: { nickname: '旅人甲' }, interactInfo: { likedCount: '120' } }
            }]
          }
        })
      };
    }
    if (url.endsWith('/api/v1/feeds/detail')) {
      return {
        ok: true,
        json: async () => ({ success: true, data: { data: { note: {
          noteId: 'note-1', title: '京都咖啡店实测', desc: '三家适合早晨到访的咖啡店。', time: 1710000000000,
          user: { nickname: '旅人甲' }, interactInfo: { likedCount: '120', collectedCount: '60', commentCount: '8' }
        } } } })
      };
    }
    const context = JSON.parse(JSON.parse(options.body).input[0].content[0].text);
    assert.equal(context.retrieval.xiaohongshu.status, 'ok');
    assert.equal(context.retrieval.xiaohongshu.evidence[0].summary, '三家适合早晨到访的咖啡店。');
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(responseValue()), output: [] }) };
  };
  const ai = await createTravelAI({ fetchImpl });
  const value = await ai.chat({ message: '帮我查小红书上的京都咖啡店攻略' }, {
    LLM_API_KEY: 'test-key', LLM_MODEL: 'test-model',
    XHS_SEARCH_ENABLED: 'true', XHS_MCP_BASE_URL: 'http://127.0.0.1:18060'
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[0].body.keyword, '京都咖啡店');
  assert.equal(value.citations[0].provider, 'xiaohongshu-mcp');
  assert.match(value.citations[0].url, /xiaohongshu\.com\/explore\/note-1/);
});

test('xiaohongshu outage degrades with an explicit warning', async () => {
  let synthesisContext;
  const fetchImpl = async (url, options) => {
    if (url.includes('/api/v1/feeds/search')) return { ok: false, json: async () => ({}) };
    synthesisContext = JSON.parse(JSON.parse(options.body).input[0].content[0].text);
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(responseValue()), output: [] }) };
  };
  const ai = await createTravelAI({ fetchImpl });
  const value = await ai.chat({ message: '查一下小红书京都攻略' }, {
    LLM_API_KEY: 'test-key', LLM_MODEL: 'test-model',
    XHS_SEARCH_ENABLED: 'true', XHS_MCP_BASE_URL: 'http://127.0.0.1:18060'
  });
  assert.equal(synthesisContext.retrieval.xiaohongshu.status, 'web_search_fallback');
  assert.equal(synthesisContext.retrieval.xiaohongshu.web_search_query, 'site:xiaohongshu.com 京都攻略');
  assert.ok(value.warnings.some(item => item.includes('搜索引擎公开索引')));
});

test('mock provider supports a dependency-free end-to-end answer', async () => {
  const ai = await createTravelAI();
  const value = await ai.chat({ message: '京都有什么推荐？', current_plan: { city: '京都' } }, { LLM_PROVIDER: 'mock' });
  assert.equal(value.intent, 'answer_question');
  assert.equal(value.requires_confirmation, false);
  assert.match(value.assistant_message, /京都/);
});

test('mock provider edits only the field containing selected text', async () => {
  const ai = await createTravelAI();
  const value = await ai.chat({
    message: '改得更有画面感',
    action: 'edit_selected_text',
    current_plan: { id: 'destination-0', city: '京都', intro: '走进古老的街巷，听雨落在屋檐上。', quote: '保持原样' },
    selection_context: { text: '听雨落在屋檐上', field: 'intro', field_label: '行程简介' }
  }, { LLM_PROVIDER: 'mock' });
  assert.equal(value.intent, 'modify_current');
  assert.equal(value.requires_confirmation, true);
  assert.match(value.proposal.patch.plan.intro, /已按要求修改/);
  assert.equal(value.proposal.patch.plan.quote, null);
  const arrayValue = await ai.chat({
    message: '只改我选中的这一条',
    action: 'edit_selected_text',
    current_plan: { id: 'destination-0', city: '京都', overview: ['清晨出发', '清晨出发'] },
    selection_context: { text: '清晨出发', field: 'overview', field_label: '行程概览', item_index: 1 }
  }, { LLM_PROVIDER: 'mock' });
  assert.equal(arrayValue.proposal.patch.plan.overview[0], '清晨出发');
  assert.match(arrayValue.proposal.patch.plan.overview[1], /已按要求修改/);
});

test('mock provider applies answer suggestions as a material current-plan update', async () => {
  const ai = await createTravelAI();
  const currentPlan = {
    id: 'destination-0', city: '京都', title: '京都行程', intro: '原行程',
    overview: ['原概览'], highlights: ['原景点'], routes: ['原路线'], food: ['原美食'],
    accommodation: ['原住宿推荐'], daily_stays: ['Day 1｜原酒店｜¥500–800/晚'], packing: '原行李', quote: '原句'
  };
  const value = await ai.chat({
    message: '根据回答修改当前行程', action: 'apply_answer_to_current_plan', current_plan: currentPlan,
    answer_context: {
      assistant_message: '建议清晨出发',
      results: [{ title: '清晨路线', summary: '先去清水寺避开人流', details: ['下午前往祇园'] }],
      citations: []
    }
  }, { LLM_PROVIDER: 'mock' });
  assert.equal(value.intent, 'modify_current');
  assert.equal(value.proposal.operation, 'modify_current');
  assert.ok(value.proposal.patch.plan.highlights.includes('清晨路线'));
  assert.notDeepEqual(value.proposal.patch.plan.routes, currentPlan.routes);
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
  assert.match(html, /id="editPlanButton"[^>]*>编辑行程<\/button>/);
  assert.match(html, /id="inlineEditorToolbar"[^>]*hidden/);
  assert.match(html, /id="inlineEditorActions"[^>]*hidden/);
  assert.match(html, /class="save"[^>]*id="saveInlineEdit">保存修改<\/button>/);
  assert.match(html, /id="textColorMenu"/);
  assert.equal((html.match(/data-editor-color=/g) || []).length, 10);
  assert.match(html, /document\.execCommand\('foreColor',false,color\)/);
  assert.match(html, /EDITOR_TEXT_COLORS/);
  assert.match(html, /id="insertMenu"/);
  assert.match(html, /<summary>插入<\/summary>/);
  assert.match(html, /id="insertLinkButton">插入链接<\/button>/);
  assert.match(html, /id="insertImageUrlButton">网络图片<\/button>/);
  assert.match(html, /id="inlineImageUpload"[^>]*type="file"/);
  assert.match(html, /id="insertTableButton">插入 2×3 表格<\/button>/);
  assert.match(html, /<h3>V\. 住宿安排<\/h3>/);
  assert.match(html, /id="accommodationList"/);
  assert.match(html, /id="dailyStayList"/);
  assert.match(html, /function renderDailyStays\(items\)/);
  assert.match(html, /function buildDailyStays\(city,duration\)/);
  assert.match(html, /function deduplicateDestinations\(\)/);
  assert.match(html, /restoreTravelPlans\(\);\s*deduplicateDestinations\(\);/);
  assert.match(html, /const DEFAULT_CURRENCY = \{ code:'CNY', label:'人民币', symbol:'¥' \}/);
  assert.match(html, /ALLOWED_EDITOR_CLASSES/);
  assert.match(html, /function startInlineEditing\(\)/);
  assert.match(html, /function saveInlineEditing\(\)/);
  assert.match(html, /function sanitizeRichHTML\(value\)/);
  assert.match(html, /ALLOWED_EDITOR_TAGS/);
  assert.match(html, /\.editable-region\[contenteditable="true"\]/);
  assert.match(html, /localStorage\.setItem\(PLAN_STORAGE_KEY,JSON\.stringify\(destinations\)\)/);
  assert.match(html, /if \(!persistTravelPlans\(\)\)/);
  assert.doesNotMatch(html, /id="planEditorModal"/);
  assert.match(html, /data-ai-action="modify-from-answer">根据回答修改行程<\/button>/);
  assert.match(html, /async function modifyPlanFromAnswer\(response\)/);
  assert.match(html, /function planPatchChangesItem\(item,patch\)/);
  assert.match(html, /options\.selectionContext \? 'edit_selected_text'/);
  assert.match(html, /selection_context:options\.selectionContext/);
  assert.match(html, /id="aiSelectionTrigger"[^>]*hidden>问 AI<\/button>/);
  assert.match(html, /id="aiSelectionQuote"[^>]*hidden/);
  assert.match(html, /function captureAISelection\(\)/);
  assert.match(html, /answer_context:options\.answerContext/);
  assert.match(html, /pendingAIAction = \{\.\.\.payload\.proposal,targetIndex:options\.targetIndex\};\s*executePendingAIAction\(\)/);
  assert.match(html, /修改内容：\$\{escapeHTML\(proposal\.summary\)\}/);
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
