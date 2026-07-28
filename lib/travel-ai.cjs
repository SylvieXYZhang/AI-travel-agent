const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-5.6-terra';
const DEFAULT_TIMEOUT_MS = 300000;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_CONVERSATION_TURNS = 12;
const SKILL_CONTRACT = require('../skills/build-travel-ai-qa/scripts/travel-ai-contract.cjs');

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const nullableInteger = { anyOf: [{ type: 'integer', minimum: 1, maximum: 30 }, { type: 'null' }] };
const nullableStringArray = { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] };

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'intent', 'assistant_message', 'requires_confirmation', 'missing_fields', 'proposal', 'results', 'citations', 'warnings'],
  properties: {
    mode: { type: 'string', enum: ['EXPLORE', 'PLAN', 'CLARIFY'] },
    intent: { type: 'string', enum: ['recommend_destinations', 'create_plan', 'modify_current', 'answer_question', 'update_profile', 'clarify'] },
    assistant_message: { type: 'string' },
    requires_confirmation: { type: 'boolean' },
    missing_fields: { type: 'array', items: { type: 'string' } },
    proposal: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['operation', 'target_id', 'destination', 'duration_days', 'patch', 'preserve_unmentioned', 'summary'],
          properties: {
            operation: { type: 'string', enum: ['create_plan', 'modify_current', 'update_profile'] },
            target_id: nullableString,
            destination: nullableString,
            duration_days: nullableInteger,
            preserve_unmentioned: { type: 'boolean' },
            summary: { type: 'string' },
            patch: {
              type: 'object',
              additionalProperties: false,
              required: ['plan', 'profile'],
              properties: {
                plan: {
                  anyOf: [
                    { type: 'null' },
                    {
                      type: 'object',
                      additionalProperties: false,
                      required: ['destination', 'duration_days', 'waypoint', 'title', 'kicker', 'intro', 'overview', 'highlights', 'routes', 'food', 'packing', 'quote'],
                      properties: {
                        destination: nullableString,
                        duration_days: nullableInteger,
                        waypoint: nullableString,
                        title: nullableString,
                        kicker: nullableString,
                        intro: nullableString,
                        overview: nullableStringArray,
                        highlights: nullableStringArray,
                        routes: nullableStringArray,
                        food: nullableStringArray,
                        packing: nullableString,
                        quote: nullableString
                      }
                    }
                  ]
                },
                profile: {
                  anyOf: [
                    { type: 'null' },
                    {
                      type: 'object',
                      additionalProperties: false,
                      required: ['allow_repeat_destinations', 'travel_preferences', 'travel_preference_other', 'travel_style'],
                      properties: {
                        allow_repeat_destinations: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
                        travel_preferences: nullableStringArray,
                        travel_preference_other: nullableString,
                        travel_style: nullableString
                      }
                    }
                  ]
                }
              }
            }
          }
        }
      ]
    },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'title', 'summary', 'destination', 'details'],
        properties: {
          type: { type: 'string', enum: ['destination', 'day', 'answer'] },
          title: { type: 'string' },
          summary: { type: 'string' },
          destination: nullableString,
          details: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'url', 'provider', 'retrieved_at', 'supports'],
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' },
          provider: { type: 'string' }, retrieved_at: { type: 'string' },
          supports: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    warnings: { type: 'array', items: { type: 'string' } }
  }
};

class TravelAIError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function getConfig(env = process.env) {
  const allowedModels = String(env.LLM_ALLOWED_MODELS || '').split(',').map(item => item.trim()).filter(Boolean);
  const timeoutMs = Math.max(1000, Number(env.LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  return {
    provider: env.LLM_PROVIDER || 'openai',
    apiKey: env.LLM_API_KEY || env.OPENAI_API_KEY || '',
    baseUrl: (env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ''),
    model: env.LLM_MODEL || DEFAULT_MODEL,
    timeoutMs,
    testTimeoutMs: Math.min(29000, Math.max(1000, Number(env.LLM_TEST_TIMEOUT_MS) || 25000)),
    webSearchTool: env.LLM_WEB_SEARCH_TOOL || 'web_search',
    webSearchEnabled: String(env.LLM_WEB_SEARCH_ENABLED || 'true').toLowerCase() !== 'false',
    allowedModels
  };
}

function validateConfig(config) {
  if (!config.apiKey) throw new TravelAIError('LLM_NOT_CONFIGURED', '服务端尚未配置 LLM_API_KEY。');
  if (!config.model || /^auto$/i.test(config.model)) throw new TravelAIError('INVALID_MODEL_CONFIG', '必须配置明确的 LLM_MODEL，当前服务不支持 Auto 模式。', 500);
  if (config.allowedModels.length && !config.allowedModels.includes(config.model)) throw new TravelAIError('INVALID_MODEL_CONFIG', 'LLM_MODEL 不在允许的模型列表中。', 500);
}

function objectDepth(value, depth = 0) {
  if (!value || typeof value !== 'object') return depth;
  if (depth > 8) return depth;
  return Math.max(depth, ...Object.values(value).slice(0, 100).map(item => objectDepth(item, depth + 1)));
}

function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TravelAIError('INVALID_REQUEST', '请求格式不正确。', 400);
  if (objectDepth(body) > 8) throw new TravelAIError('INVALID_REQUEST', '请求嵌套层级过深。', 400);
  if (typeof body.message !== 'string' || !body.message.trim()) throw new TravelAIError('INVALID_MESSAGE', '请输入旅行问题。', 400);
  if (body.message.length > MAX_MESSAGE_LENGTH) throw new TravelAIError('MESSAGE_TOO_LONG', `问题不能超过 ${MAX_MESSAGE_LENGTH} 个字符。`, 400);
  if (body.conversation !== undefined && !Array.isArray(body.conversation)) throw new TravelAIError('INVALID_CONVERSATION', '对话历史格式不正确。', 400);
  return {
    message: body.message.trim(),
    conversation: (body.conversation || []).slice(-MAX_CONVERSATION_TURNS).map(item => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: String(item?.content || '').slice(0, MAX_MESSAGE_LENGTH)
    })),
    profile: body.profile && typeof body.profile === 'object' ? body.profile : {},
    current_plan: body.current_plan && typeof body.current_plan === 'object' ? body.current_plan : null,
    locale: typeof body.locale === 'string' ? body.locale.slice(0, 20) : 'zh-CN',
    timezone: typeof body.timezone === 'string' ? body.timezone.slice(0, 50) : 'Asia/Shanghai'
  };
}

function enforceResponseLimits(value) {
  const tooLong = text => typeof text === 'string' && text.length > 4000;
  if (tooLong(value.assistant_message)) throw new TravelAIError('INVALID_MODEL_RESPONSE', '模型回答超过长度限制。');
  if (Array.isArray(value.results) && value.results.length > 10) throw new TravelAIError('INVALID_MODEL_RESPONSE', '模型返回了过多结果。');
  if (Array.isArray(value.warnings) && value.warnings.length > 10) throw new TravelAIError('INVALID_MODEL_RESPONSE', '模型返回了过多警告。');
  const plan = value.proposal?.patch?.plan;
  if (plan) {
    for (const key of ['overview', 'highlights', 'routes', 'food']) {
      if (Array.isArray(plan[key]) && plan[key].length > 30) throw new TravelAIError('INVALID_MODEL_RESPONSE', `模型字段 ${key} 超过长度限制。`);
    }
  }
}

function extractOutputText(payload) {
  if (typeof payload.output_text === 'string' && payload.output_text) return payload.output_text;
  for (const item of payload.output || []) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) if (content.type === 'output_text' && typeof content.text === 'string') return content.text;
  }
  throw new TravelAIError('EMPTY_MODEL_RESPONSE', '模型没有返回可解析的回答。');
}

function collectSources(payload) {
  const sources = new Map();
  const add = (url, title = '') => {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url) || sources.has(url)) return;
    sources.set(url, { id: `source-${sources.size + 1}`, title: title || new URL(url).hostname, url, provider: 'openai-web-search', retrieved_at: new Date().toISOString(), supports: [] });
  };
  for (const item of payload.output || []) {
    if (item.type === 'web_search_call') for (const source of item.action?.sources || []) add(source.url, source.title);
    if (item.type === 'message') for (const content of item.content || []) for (const annotation of content.annotations || []) add(annotation.url, annotation.title);
  }
  return [...sources.values()].slice(0, 12);
}

async function callOpenAIResponses(context, config, fetchImpl) {
  validateConfig(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const requestBody = {
      model: config.model,
      instructions: SKILL_CONTRACT.SYSTEM_PROMPT,
      input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(context) }] }],
      text: { format: { type: 'json_schema', name: 'travel_ai_response', strict: true, schema: SKILL_CONTRACT.RESPONSE_SCHEMA }, verbosity: 'low' }
    };
    if (config.webSearchEnabled) {
      requestBody.tools = [{ type: config.webSearchTool }];
      requestBody.tool_choice = 'auto';
      requestBody.include = ['web_search_call.action.sources'];
    }
    const response = await fetchImpl(`${config.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new TravelAIError('LLM_PROVIDER_ERROR', payload.error?.message || 'LLM 服务暂时不可用。', response.status === 429 ? 429 : 503);
    return { value: JSON.parse(extractOutputText(payload)), sources: collectSources(payload), raw: payload };
  } catch (error) {
    if (error instanceof TravelAIError) throw error;
    if (error.name === 'AbortError') throw new TravelAIError('LLM_TIMEOUT', `复杂检索超过 ${Math.round(config.timeoutMs / 1000)} 秒，请缩小问题范围或稍后重试。`);
    if (error instanceof SyntaxError) throw new TravelAIError('INVALID_MODEL_JSON', '模型返回了无法解析的结构化结果。');
    throw new TravelAIError('LLM_NETWORK_ERROR', '无法连接到 AI 服务。');
  } finally {
    clearTimeout(timer);
  }
}

async function testOpenAIConnection(config, fetchImpl) {
  validateConfig(config);
  if (!config.webSearchEnabled) throw new TravelAIError('INVALID_LLM_CONFIG', '连接测试要求开启 Web Search。', 400);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.testTimeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        input: '使用 Web Search 查找北京故宫博物院官方网站。只回复 OK。',
        tools: [{ type: config.webSearchTool }],
        tool_choice: 'required',
        include: ['web_search_call.action.sources'],
        max_output_tokens: 64
      }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new TravelAIError('LLM_PROVIDER_ERROR', payload.error?.message || 'LLM 服务暂时不可用。', response.status === 429 ? 429 : 503);
    return {
      ok: true,
      model: config.model,
      web_search_enabled: true,
      source_count: collectSources(payload).length
    };
  } catch (error) {
    if (error instanceof TravelAIError) throw error;
    if (error.name === 'AbortError') throw new TravelAIError('LLM_TEST_TIMEOUT', '连接测试超过 25 秒，请更换更快的模型或稍后重试。', 504);
    throw new TravelAIError('LLM_NETWORK_ERROR', '无法连接到 AI 服务。');
  } finally {
    clearTimeout(timer);
  }
}

async function callMockProvider(context) {
  const destination = context.current_plan?.city || context.current_plan?.destination || '当前目的地';
  return {
    value: {
      mode: 'PLAN', intent: 'answer_question',
      assistant_message: `Mock provider 已收到关于${destination}的问题：${context.message}`,
      requires_confirmation: false, missing_fields: [], proposal: null,
      results: [{ type: 'answer', title: '测试回答', summary: '用于本地端到端测试，不代表真实旅行信息。', destination, details: [] }],
      citations: [], warnings: ['当前使用 LLM_PROVIDER=mock，仅用于自动化测试。']
    },
    sources: []
  };
}

async function createTravelAI(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const validator = await import('../skills/build-travel-ai-qa/scripts/validate-travel-response.mjs');
  return {
    async testConnection(env = process.env) {
      const config = getConfig(env);
      if (config.provider === 'mock') return { ok: true, model: 'mock', web_search_enabled: false, source_count: 0 };
      return testOpenAIConnection(config, fetchImpl);
    },
    async chat(body, env = process.env) {
      const context = validateRequest(body);
      const config = getConfig(env);
      const result = config.provider === 'mock'
        ? await callMockProvider(context)
        : await callOpenAIResponses(context, config, fetchImpl);
      const value = result.value;
      if (['create_plan', 'modify_current', 'update_profile'].includes(value.intent)) value.requires_confirmation = true;
      value.citations = result.sources;
      enforceResponseLimits(value);
      const errors = validator.validateTravelResponse(value, result.sources);
      if (errors.length) throw new TravelAIError('INVALID_MODEL_RESPONSE', `模型结果未通过校验：${errors.join('; ')}`);
      return value;
    }
  };
}

module.exports = { createTravelAI, getConfig, validateConfig, validateRequest, enforceResponseLimits, testOpenAIConnection, RESPONSE_SCHEMA: SKILL_CONTRACT.RESPONSE_SCHEMA, SYSTEM_PROMPT: SKILL_CONTRACT.SYSTEM_PROMPT, TravelAIError };
