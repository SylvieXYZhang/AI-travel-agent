const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadEnvFile } = require('./lib/load-env.cjs');
const { createTravelAI, getConfig, validateConfig, TravelAIError } = require('./lib/travel-ai.cjs');

loadEnvFile();

const root = __dirname;
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8'
};
const rateLimits = new Map();

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function checkRateLimit(ip, now = Date.now()) {
  const windowMs = 60_000;
  const limit = Math.max(1, Number(process.env.AI_RATE_LIMIT_PER_MINUTE) || 20);
  const current = rateLimits.get(ip);
  if (!current || now - current.startedAt >= windowMs) {
    rateLimits.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

function readJson(req) {
  const maxBytes = Math.max(1024, Number(process.env.AI_MAX_BODY_BYTES) || 64 * 1024);
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new TravelAIError('BODY_TOO_LARGE', '请求内容过大。', 413));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new TravelAIError('INVALID_JSON', '请求 JSON 格式不正确。', 400)); }
    });
    req.on('error', reject);
  });
}

function safeError(error) {
  const safeCodes = new Set(['INVALID_REQUEST', 'INVALID_MESSAGE', 'MESSAGE_TOO_LONG', 'INVALID_CONVERSATION', 'BODY_TOO_LARGE', 'INVALID_JSON', 'INVALID_LLM_CONFIG', 'INVALID_MODEL_CONFIG', 'LLM_NOT_CONFIGURED', 'LLM_TIMEOUT', 'LLM_TEST_TIMEOUT', 'LLM_NETWORK_ERROR']);
  return {
    status: error instanceof TravelAIError ? error.status : 500,
    code: error instanceof TravelAIError ? error.code : 'INTERNAL_ERROR',
    message: error instanceof TravelAIError && safeCodes.has(error.code) ? error.message : 'AI 服务暂时不可用，请稍后重试。'
  };
}

function isLoopback(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

function llmConfigStatus(env) {
  const config = getConfig(env);
  return {
    configured: Boolean(config.apiKey),
    base_url: config.baseUrl,
    model: config.model,
    web_search_enabled: config.webSearchEnabled
  };
}

function applyLLMConfig(body, env) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TravelAIError('INVALID_LLM_CONFIG', 'LLM 配置格式不正确。', 400);
  const next = { ...env, LLM_PROVIDER: 'openai', LLM_WEB_SEARCH_ENABLED: 'true' };
  if (body.api_key !== undefined) {
    if (typeof body.api_key !== 'string' || body.api_key.length > 500) throw new TravelAIError('INVALID_LLM_CONFIG', 'API Key 格式不正确。', 400);
    if (body.api_key.trim()) next.LLM_API_KEY = body.api_key.trim();
  }
  if (body.base_url !== undefined) {
    if (typeof body.base_url !== 'string' || body.base_url.length > 300) throw new TravelAIError('INVALID_LLM_CONFIG', 'Base URL 格式不正确。', 400);
    let url;
    try { url = new URL(body.base_url); } catch { throw new TravelAIError('INVALID_LLM_CONFIG', 'Base URL 格式不正确。', 400); }
    if (url.protocol !== 'https:') throw new TravelAIError('INVALID_LLM_CONFIG', 'Base URL 必须使用 HTTPS。', 400);
    next.LLM_BASE_URL = body.base_url.replace(/\/$/, '');
  }
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || body.model.length > 100) throw new TravelAIError('INVALID_LLM_CONFIG', '模型名称格式不正确。', 400);
    next.LLM_MODEL = body.model.trim();
  }
  validateConfig(getConfig(next));
  Object.assign(env, next);
  return llmConfigStatus(env);
}

function createServer(options = {}) {
  const runtimeEnv = { ...(options.env || process.env) };
  const aiPromise = options.ai ? Promise.resolve(options.ai) : createTravelAI({ fetchImpl: options.fetchImpl });
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/llm/config/test') {
        if (!isLoopback(req.socket.remoteAddress)) return json(res, 403, { error: { code: 'LOCAL_ONLY', message: 'LLM 配置仅允许在本机测试。' } });
        if (req.method !== 'POST') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
        const ai = await aiPromise;
        return json(res, 200, await ai.testConnection(runtimeEnv));
      }
      if (url.pathname === '/api/llm/config') {
        if (!isLoopback(req.socket.remoteAddress)) return json(res, 403, { error: { code: 'LOCAL_ONLY', message: 'LLM 配置仅允许在本机修改。' } });
        if (req.method === 'GET') return json(res, 200, llmConfigStatus(runtimeEnv));
        if (req.method !== 'POST') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
        if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) return json(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '请使用 application/json。' } });
        return json(res, 200, applyLLMConfig(await readJson(req), runtimeEnv));
      }
      if (req.method === 'POST' && url.pathname === '/api/ai/chat') {
        if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) return json(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '请使用 application/json。' } });
        if (!checkRateLimit(req.socket.remoteAddress || 'local')) return json(res, 429, { error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试。' } });
        const body = await readJson(req);
        const ai = await aiPromise;
        return json(res, 200, await ai.chat(body, runtimeEnv));
      }

      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (relative !== 'index.html' && !relative.startsWith(`assets${path.sep}`) && !relative.startsWith('assets/')) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
      const file = path.resolve(root, relative);
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) return json(res, 403, { error: { code: 'FORBIDDEN', message: 'Forbidden' } });
      fs.readFile(file, (error, data) => {
        if (error) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
        res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : data);
      });
    } catch (error) {
      const safe = safeError(error);
      json(res, safe.status, { error: { code: safe.code, message: safe.message } });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4173;
  const server = createServer();
  server.on('error', error => {
    if (error.code === 'EADDRINUSE') console.error(`端口 ${port} 已有服务运行，请直接访问 http://127.0.0.1:${port}`);
    else console.error(`服务启动失败：${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`Travel journal demo: http://127.0.0.1:${port}`));
}

module.exports = { createServer, readJson, checkRateLimit, applyLLMConfig, llmConfigStatus };
