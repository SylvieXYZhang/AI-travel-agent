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
                      required: ['destination', 'duration_days', 'waypoint', 'title', 'kicker', 'intro', 'overview', 'highlights', 'routes', 'food', 'accommodation', 'daily_stays', 'packing', 'quote'],
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
                        accommodation: nullableStringArray,
                        daily_stays: nullableStringArray,
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

function responseSchemaForContext(context) {
  if (context?.action !== 'apply_answer_to_current_plan') return SKILL_CONTRACT.RESPONSE_SCHEMA;
  const schema = JSON.parse(JSON.stringify(SKILL_CONTRACT.RESPONSE_SCHEMA));
  schema.properties.mode.enum = ['PLAN'];
  schema.properties.intent.enum = ['modify_current'];
  schema.properties.requires_confirmation.enum = [true];
  const proposal = schema.properties.proposal.anyOf[1];
  schema.properties.proposal = proposal;
  proposal.properties.operation.enum = ['modify_current'];
  const plan = proposal.properties.patch.properties.plan.anyOf[1];
  proposal.properties.patch.properties.plan = plan;
  for (const field of ['overview', 'highlights', 'routes', 'food', 'accommodation', 'daily_stays']) {
    plan.properties[field] = { type: 'array', items: { type: 'string' } };
  }
  return schema;
}

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
    xhsSearchEnabled: String(env.XHS_SEARCH_ENABLED || 'false').toLowerCase() === 'true',
    xhsBaseUrl: String(env.XHS_MCP_BASE_URL || '').replace(/\/$/, ''),
    xhsTimeoutMs: Math.min(60000, Math.max(1000, Number(env.XHS_TIMEOUT_MS) || 15000)),
    xhsDetailLimit: Math.min(5, Math.max(1, Number(env.XHS_DETAIL_LIMIT) || 3)),
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
  const applyAnswer = body.action === 'apply_answer_to_current_plan';
  const answerContext = applyAnswer && body.answer_context && typeof body.answer_context === 'object'
    ? {
        assistant_message: String(body.answer_context.assistant_message || '').slice(0, 4000),
        results: Array.isArray(body.answer_context.results) ? body.answer_context.results.slice(0, 10).map(item => ({
          title: String(item?.title || '').slice(0, 200),
          summary: String(item?.summary || '').slice(0, 1000),
          details: Array.isArray(item?.details) ? item.details.slice(0, 10).map(detail => String(detail).slice(0, 500)) : []
        })) : [],
        citations: Array.isArray(body.answer_context.citations) ? body.answer_context.citations.slice(0, 12).map(item => ({
          title: String(item?.title || '').slice(0, 200),
          url: String(item?.url || '').slice(0, 2000),
          provider: String(item?.provider || '').slice(0, 100)
        })) : []
      }
    : null;
  if (applyAnswer && !answerContext?.results.length) throw new TravelAIError('INVALID_ANSWER_CONTEXT', '没有可用于修改行程的 AI 建议。', 400);
  return {
    message: body.message.trim(),
    conversation: (body.conversation || []).slice(-MAX_CONVERSATION_TURNS).map(item => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: String(item?.content || '').slice(0, MAX_MESSAGE_LENGTH)
    })),
    profile: body.profile && typeof body.profile === 'object' ? body.profile : {},
    current_plan: body.current_plan && typeof body.current_plan === 'object' ? body.current_plan : null,
    action: applyAnswer ? 'apply_answer_to_current_plan' : null,
    answer_context: answerContext,
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
    for (const key of ['overview', 'highlights', 'routes', 'food', 'accommodation', 'daily_stays']) {
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

function wantsXiaohongshu(message) {
  return /小红书|红薯|red\s*note|xiaohongshu|\bxhs\b/i.test(String(message || '')) || isAccommodationRequest(message);
}

function isAccommodationRequest(message) {
  return /住宿|酒店|饭店|旅馆|旅店|客栈|民宿|青旅|hotel|hostel|accommodation|lodging/i.test(String(message || ''));
}

function hasAccommodationBudget(context) {
  const userHistory = (context?.conversation || []).filter(item => item.role === 'user').map(item => item.content).join(' ');
  const text = `${context?.message || ''} ${userHistory} ${JSON.stringify(context?.profile || {})}`;
  return /(?:预算|价位|价格|每晚|一晚|每夜|per\s*night|nightly).{0,24}(?:\d|不限|无上限|都可以|经济|中档|舒适|高端|豪华)|(?:¥|￥|RMB|CNY|USD|JPY|EUR|HKD|THB|\$|元|人民币|日元|美元|欧元).{0,12}\d|\d[\d,.]*\s*(?:-|–|—|~|至|到)\s*(?:¥|￥|\$)?\s*\d[\d,.]*\s*(?:元|人民币|日元|美元|欧元)?|(?:经济型|中档|舒适型|高端|豪华|预算不限|价格不限)/i.test(text);
}

function accommodationQueryMessage(context) {
  const priorRequest = [...(context?.conversation || [])].reverse()
    .find(item => item.role === 'user' && isAccommodationRequest(item.content))?.content || '';
  return `${priorRequest} ${context?.message || ''}`.trim();
}

function buildXiaohongshuQuery(message) {
  const compact = String(message || '')
    .replace(/(?:小红书|红薯|red\s*note|xiaohongshu|\bxhs\b)(?:上(?:的)?)?/gi, ' ')
    .replace(/帮我|请|一下|上面|上|查找|查询|查|搜索|搜搜|搜|看看|攻略|笔记/gi, ' ')
    .replace(/[，。！？、,.!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (compact || String(message || '').trim()).slice(0, 120);
}

function buildXiaohongshuWebSearchQuery(message) {
  const terms = String(message || '')
    .replace(/site\s*:\s*xiaohongshu\.com/gi, ' ')
    .replace(/(?:小红书|红薯|red\s*note|xiaohongshu|\bxhs\b)(?:上(?:的)?)?/gi, ' ')
    .replace(/使用现有|web\s*search|帮我|请|一下|上面|上|查找|查询|查|搜索|搜搜|搜|看看/gi, ' ')
    .replace(/[，。！？、,.!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const topic = (terms || buildXiaohongshuQuery(message)).slice(0, 120);
  return `site:xiaohongshu.com ${topic}${isAccommodationRequest(message) ? ' 酒店 避雷 踩雷' : ''}`;
}

function buildAccommodationPriceWebSearchQuery(message) {
  const topic = buildXiaohongshuQuery(message).replace(/避雷|踩雷/gi, ' ').replace(/\s+/g, ' ').trim();
  const explicitForeignCurrency = /JPY|USD|EUR|HKD|THB|日元|美元|欧元|港币|泰铢/i.test(String(message || ''));
  return `${topic} 酒店 官网 每晚价格${explicitForeignCurrency ? '' : ' 人民币'}`.slice(0, 160);
}

function xhsFeedUrl(feedId, token) {
  const url = new URL(`https://www.xiaohongshu.com/explore/${encodeURIComponent(feedId)}`);
  if (token) url.searchParams.set('xsec_token', token);
  url.searchParams.set('xsec_source', 'pc_search');
  return url.toString();
}

function normalizeXhsEvidence(feed, detail, index, retrievedAt) {
  const card = feed?.noteCard || {};
  const note = detail?.data?.data?.note || detail?.data?.note || {};
  const feedId = String(feed?.id || note.noteId || '');
  if (!feedId) return null;
  const token = String(feed?.xsecToken || note.xsecToken || '');
  const title = String(note.title || card.displayTitle || `小红书笔记 ${index + 1}`).slice(0, 200);
  const author = note.user?.nickname || note.user?.nickName || card.user?.nickname || card.user?.nickName || '';
  const interact = note.interactInfo || card.interactInfo || {};
  const summary = String(note.desc || '').slice(0, 1800);
  return {
    evidence: {
      id: `xhs-${index + 1}`,
      provider: 'xiaohongshu-mcp',
      title,
      url: xhsFeedUrl(feedId, token),
      retrieved_at: retrievedAt,
      author: String(author).slice(0, 100),
      published_at: Number.isFinite(Number(note.time)) ? new Date(Number(note.time)).toISOString() : null,
      summary,
      engagement: {
        likes: String(interact.likedCount || ''),
        favorites: String(interact.collectedCount || ''),
        comments: String(interact.commentCount || '')
      }
    },
    source: {
      id: `xhs-${index + 1}`,
      title,
      url: xhsFeedUrl(feedId, token),
      provider: 'xiaohongshu-mcp',
      retrieved_at: retrievedAt,
      supports: summary ? [summary.slice(0, 240)] : [title]
    }
  };
}

async function searchXiaohongshu(message, config, fetchImpl) {
  if (!wantsXiaohongshu(message)) return { requested: false, status: 'not_requested', evidence: [], sources: [] };
  if (!config.xhsSearchEnabled || !config.xhsBaseUrl) {
    return { requested: true, status: 'unavailable', reason: 'not_configured', query: buildXiaohongshuQuery(message), evidence: [], sources: [] };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.xhsTimeoutMs);
  try {
    const searchResponse = await fetchImpl(`${config.xhsBaseUrl}/api/v1/feeds/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        keyword: buildXiaohongshuQuery(message),
        filters: { sort_by: '综合', note_type: '图文', publish_time: '半年内', search_scope: '不限', location: '不限' }
      }),
      signal: controller.signal
    });
    const searchPayload = await searchResponse.json().catch(() => ({}));
    if (!searchResponse.ok || searchPayload.success === false) throw new Error('search_failed');
    const feeds = (searchPayload.data?.feeds || []).slice(0, config.xhsDetailLimit);
    const details = await Promise.all(feeds.map(async feed => {
      const response = await fetchImpl(`${config.xhsBaseUrl}/api/v1/feeds/detail`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feed_id: feed.id, xsec_token: feed.xsecToken, load_all_comments: false }),
        signal: controller.signal
      });
      if (!response.ok) return null;
      return response.json().catch(() => null);
    }));
    const retrievedAt = new Date().toISOString();
    const normalized = feeds.map((feed, index) => normalizeXhsEvidence(feed, details[index], index, retrievedAt)).filter(Boolean);
    return {
      requested: true,
      status: normalized.length ? 'ok' : 'empty',
      query: buildXiaohongshuQuery(message),
      evidence: normalized.map(item => item.evidence),
      sources: normalized.map(item => item.source)
    };
  } catch (error) {
    return {
      requested: true,
      status: 'unavailable',
      reason: error?.name === 'AbortError' ? 'timeout' : 'request_failed',
      query: buildXiaohongshuQuery(message),
      evidence: [],
      sources: []
    };
  } finally {
    clearTimeout(timer);
  }
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
      text: { format: { type: 'json_schema', name: 'travel_ai_response', strict: true, schema: responseSchemaForContext(context) }, verbosity: 'low' }
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
  if (context.action === 'apply_answer_to_current_plan') {
    const current = context.current_plan || {};
    const suggestions = context.answer_context?.results || [];
    const suggestionLines = suggestions.flatMap(result => [result.title, result.summary, ...(result.details || [])]).filter(Boolean);
    const unique = values => [...new Set(values.filter(Boolean))];
    const overview = unique([...(current.overview || []), ...suggestionLines.slice(0, 2)]);
    const dailyStays = Array.from({ length: overview.length }, (_, index) => current.daily_stays?.[index]
      || `Day ${index + 1}｜${destination}交通便利区域住宿｜人民币价格待检索`);
    return {
      value: {
        mode: 'PLAN', intent: 'modify_current', assistant_message: `已根据上一轮建议重新整理${destination}行程。`,
        requires_confirmation: true, missing_fields: [],
        proposal: {
          operation: 'modify_current', target_id: current.id || null, destination, duration_days: null,
          preserve_unmentioned: true, summary: `将 ${suggestions.length} 条 AI 建议整合进当前行程`,
          patch: { profile: null, plan: {
            destination: null, duration_days: null, waypoint: null, title: current.title || null, kicker: current.kicker || null,
            intro: current.intro || null,
            overview,
            highlights: unique([...(current.highlights || []), ...suggestionLines.slice(0, 4)]),
            routes: unique([...(current.routes || []), ...suggestionLines.slice(0, 3)]),
            food: unique([...(current.food || []), ...suggestionLines.slice(0, 2)]),
            accommodation: current.accommodation?.length ? current.accommodation : [`${destination}交通便利区域：优先选择靠近公共交通的住宿。`],
            daily_stays: dailyStays,
            packing: current.packing || null, quote: current.quote || null
          } }
        },
        results: [], citations: [], warnings: ['当前使用 LLM_PROVIDER=mock，仅用于自动化测试。']
      },
      sources: []
    };
  }
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
      const accommodationSearchMessage = accommodationQueryMessage(context);
      const accommodationRequest = isAccommodationRequest(accommodationSearchMessage);
      if (accommodationRequest && context.action !== 'apply_answer_to_current_plan' && !hasAccommodationBudget(context)) {
        return {
          mode: 'CLARIFY', intent: 'clarify',
          assistant_message: '为了筛选合适住宿并核对价格，请告诉我可接受的每晚住宿价格区间（例如 ¥600–1,000/晚）；未指定币种时默认使用人民币。',
          requires_confirmation: false, missing_fields: ['accommodation_price_range'], proposal: null,
          results: [], citations: [], warnings: []
        };
      }
      const xhs = config.provider === 'mock'
        ? { requested: false, status: 'not_requested', evidence: [], sources: [] }
        : await searchXiaohongshu(accommodationRequest ? accommodationSearchMessage : context.message, config, fetchImpl);
      if (xhs.requested) {
        const useWebSearchFallback = xhs.status !== 'ok' && config.webSearchEnabled;
        context.retrieval = context.retrieval || {};
        context.retrieval.xiaohongshu = {
          status: useWebSearchFallback ? 'web_search_fallback' : xhs.status,
          query: xhs.query || buildXiaohongshuQuery(accommodationRequest ? accommodationSearchMessage : context.message),
          web_search_query: config.webSearchEnabled && (useWebSearchFallback || accommodationRequest) ? buildXiaohongshuWebSearchQuery(accommodationRequest ? accommodationSearchMessage : context.message) : null,
          evidence: xhs.evidence
        };
      }
      if (accommodationRequest) {
        context.retrieval = context.retrieval || {};
        context.retrieval.accommodation = {
          purpose: 'verify_current_nightly_prices_with_general_web_search',
          price_web_search_query: buildAccommodationPriceWebSearchQuery(accommodationSearchMessage)
        };
      }
      const result = config.provider === 'mock'
        ? await callMockProvider(context)
        : await callOpenAIResponses(context, config, fetchImpl);
      result.sources = [...xhs.sources, ...result.sources].slice(0, 12);
      const value = result.value;
      if (context.action === 'apply_answer_to_current_plan' && (value.intent !== 'modify_current' || !value.proposal)) {
        throw new TravelAIError('INVALID_PLAN_UPDATE', 'AI 未能根据检索回答生成可应用的行程修改。');
      }
      if (context.action === 'apply_answer_to_current_plan') {
        const plan = value.proposal?.patch?.plan;
        const coreFields = ['overview', 'highlights', 'routes', 'food', 'accommodation', 'daily_stays'];
        const hasCompletePlan = value.proposal?.operation === 'modify_current' && plan
          && coreFields.every(field => Array.isArray(plan[field]) && plan[field].length > 0)
          && plan.daily_stays.length === plan.overview.length;
        const changed = hasCompletePlan && coreFields.some(field => JSON.stringify(plan[field]) !== JSON.stringify(context.current_plan?.[field] || []));
        if (!changed) throw new TravelAIError('INVALID_PLAN_UPDATE', 'AI 返回的行程与原记录相同，请重新生成。');
      }
      if (['create_plan', 'modify_current', 'update_profile'].includes(value.intent)) {
        value.requires_confirmation = true;
        // The application write path only applies fields present in the patch, so
        // unmentioned fields are always preserved. Assert that invariant on the
        // proposal instead of failing when the model omits the flag.
        if (value.proposal && typeof value.proposal === 'object' && !Array.isArray(value.proposal)) value.proposal.preserve_unmentioned = true;
        // Normalize an incompatible mode: create/modify plans belong to PLAN;
        // update_profile is valid under EXPLORE or PLAN (never CLARIFY).
        value.mode = value.intent === 'update_profile' ? (value.mode === 'PLAN' ? 'PLAN' : 'EXPLORE') : 'PLAN';
      }
      value.citations = result.sources;
      if (xhs.requested && xhs.status !== 'ok') {
        const message = config.webSearchEnabled
          ? '小红书站内检索未使用登录态；当前结果来自搜索引擎公开索引，覆盖范围可能不完整。'
          : '小红书数据源暂不可用，且 Web Search 未开启。';
        if (!value.warnings.includes(message)) value.warnings.push(message);
      }
      enforceResponseLimits(value);
      const errors = validator.validateTravelResponse(value, result.sources);
      if (errors.length) throw new TravelAIError('INVALID_MODEL_RESPONSE', `模型结果未通过校验：${errors.join('; ')}`);
      return value;
    }
  };
}

module.exports = { createTravelAI, getConfig, validateConfig, validateRequest, responseSchemaForContext, enforceResponseLimits, testOpenAIConnection, isAccommodationRequest, hasAccommodationBudget, accommodationQueryMessage, wantsXiaohongshu, buildXiaohongshuQuery, buildXiaohongshuWebSearchQuery, buildAccommodationPriceWebSearchQuery, searchXiaohongshu, RESPONSE_SCHEMA: SKILL_CONTRACT.RESPONSE_SCHEMA, SYSTEM_PROMPT: SKILL_CONTRACT.SYSTEM_PROMPT, TravelAIError };
