const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadEnvFile } = require('./lib/load-env.cjs');
const { createTravelAI, getConfig, validateConfig, TravelAIError } = require('./lib/travel-ai.cjs');
const {
  SHARE_MAX_BYTES, SHARE_ID_PATTERN, ShareError, normalizePlan, newShareId, newEditToken,
  hashEditToken, tokenMatches, publicShare, createMemoryShareStore, createCosmosShareStore
} = require('./lib/share-store.cjs');
const {
  AccountError, SESSION_COOKIE, normalizeEmail, accountIdForEmail, hashPassword, passwordMatches,
  newSessionToken, sessionIdForToken, parseCookies, sessionCookie, encryptConfig, decryptConfig, publicAccount,
  createMemoryAccountStore, createCosmosAccountStore
} = require('./lib/account-store.cjs');

loadEnvFile();

const root = __dirname;
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif'
};
const rateLimits = new Map();
const dailyLimits = new Map();
const placeImageCache = new Map();

function compactPlaceName(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s·•・—–\-_:：,，.。()（）【】\[\]]/g, '');
}

const PLACE_IMAGE_ALIASES = [
  ['金阁寺','鹿苑寺','金閣寺'],
  ['伏见稻荷大社','伏見稲荷大社','伏见稻荷'],
  ['祇园花见小路','祇園花見小路','花见小路','花見小路']
];

function placeImageNames(place) {
  const normalizedPlace = compactPlaceName(place);
  const aliases = PLACE_IMAGE_ALIASES.find(group => group.some(name => compactPlaceName(name) === normalizedPlace));
  return (aliases || [place]).map(compactPlaceName).filter(Boolean);
}

function placeImageTitleMatches(title, place) {
  const normalizedTitle = compactPlaceName(title);
  return normalizedTitle && placeImageNames(place).some(name => normalizedTitle === name || (name.length >= 3 && normalizedTitle.includes(name)));
}

async function searchPlaceImage(city, place, fetchImpl = globalThis.fetch) {
  const safeCity = String(city || '').trim().slice(0, 60);
  const safePlace = String(place || '').trim().replace(/[：:].*$/, '').slice(0, 100);
  if (!safePlace || typeof fetchImpl !== 'function') return null;
  const cacheKey = `${safeCity}|${safePlace}`;
  const cached = placeImageCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const endpoint = new URL('https://zh.wikipedia.org/w/api.php');
  endpoint.search = new URLSearchParams({
    action:'query', generator:'search', gsrsearch:`${safeCity} ${safePlace}`.trim(), gsrnamespace:'0', gsrlimit:'6',
    prop:'pageimages|pageterms', piprop:'thumbnail|original', pithumbsize:'1400', wbptterms:'description',
    format:'json', formatversion:'2', origin:'*'
  }).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(endpoint, {
      headers:{ 'user-agent':'VoyageAI-Travel-Planner/0.2 (place-card-image-match)' }, signal:controller.signal
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const pages = Array.isArray(payload?.query?.pages) ? payload.query.pages : [];
    const page = pages.find(candidate => {
      if (!candidate?.thumbnail?.source && !candidate?.original?.source) return false;
      return placeImageTitleMatches(candidate.title,safePlace);
    });
    if (!page) return null;
    const value = {
      matched:true,
      image_url:String(page.thumbnail?.source || page.original?.source || ''),
      article_title:String(page.title || safePlace),
      source_url:`https://zh.wikipedia.org/wiki/${encodeURIComponent(String(page.title || '').replace(/ /g, '_'))}`
    };
    if (!/^https:\/\//.test(value.image_url)) return null;
    placeImageCache.set(cacheKey,{ value, expiresAt:Date.now() + 12 * 60 * 60 * 1000 });
    return value;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function json(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  });
  res.end(JSON.stringify(payload));
}

function checkRateLimit(ip, now = Date.now(), limitOverride) {
  const windowMs = 60_000;
  const limit = Math.max(1, Number(limitOverride) || Number(process.env.AI_RATE_LIMIT_PER_MINUTE) || 20);
  const current = rateLimits.get(ip);
  if (!current || now - current.startedAt >= windowMs) {
    rateLimits.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

function checkDailyLimit(key, now = Date.now(), limitOverride) {
  const limit = Math.max(1, Number(limitOverride) || 100);
  const day = new Date(now).toISOString().slice(0, 10);
  const current = dailyLimits.get(key);
  if (!current || current.day !== day) {
    dailyLimits.set(key, { day, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

function publicDemoEnabled(env) {
  return String(env.PUBLIC_DEMO_ENABLED || 'false').toLowerCase() === 'true' && Boolean(getConfig(env).apiKey);
}

function clientAddress(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'local';
}

function readJson(req, maxBytesOverride) {
  const maxBytes = Math.max(1024, Number(maxBytesOverride) || Number(process.env.AI_MAX_BODY_BYTES) || 64 * 1024);
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
  const safeCodes = new Set(['INVALID_REQUEST', 'INVALID_MESSAGE', 'MESSAGE_TOO_LONG', 'INVALID_CONVERSATION', 'INVALID_MODULE_CONTEXT', 'BODY_TOO_LARGE', 'INVALID_JSON', 'INVALID_LLM_CONFIG', 'INVALID_MODEL_CONFIG', 'INVALID_PLAN_UPDATE', 'LLM_NOT_CONFIGURED', 'LLM_TIMEOUT', 'LLM_TEST_TIMEOUT', 'LLM_NETWORK_ERROR', 'INVALID_SHARED_PLAN', 'SHARED_PLAN_TOO_LARGE', 'SHARE_NOT_FOUND', 'SHARE_EDIT_FORBIDDEN', 'SHARE_CONFLICT', 'SHARE_ID_COLLISION', 'INVALID_EMAIL', 'INVALID_PASSWORD', 'ACCOUNT_EXISTS', 'INVALID_CREDENTIALS', 'AUTH_REQUIRED', 'ACCOUNT_ENCRYPTION_UNAVAILABLE', 'ACCOUNT_CONFIG_UNREADABLE']);
  return {
    status: error instanceof TravelAIError || error instanceof ShareError || error instanceof AccountError ? error.status : 500,
    code: error instanceof TravelAIError || error instanceof ShareError || error instanceof AccountError ? error.code : 'INTERNAL_ERROR',
    message: (error instanceof TravelAIError || error instanceof ShareError || error instanceof AccountError) && safeCodes.has(error.code) ? error.message : '服务暂时不可用，请稍后重试。'
  };
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

function accountLLMEnv(body, existing, runtimeEnv) {
  const target = {
    ...runtimeEnv,
    LLM_PROVIDER: 'openai',
    LLM_WEB_SEARCH_ENABLED: 'true',
    LLM_API_KEY: existing?.LLM_API_KEY || '',
    LLM_BASE_URL: existing?.LLM_BASE_URL || runtimeEnv.LLM_BASE_URL,
    LLM_MODEL: existing?.LLM_MODEL || runtimeEnv.LLM_MODEL
  };
  applyLLMConfig(body, target);
  return {
    LLM_PROVIDER: 'openai',
    LLM_API_KEY: target.LLM_API_KEY,
    LLM_BASE_URL: target.LLM_BASE_URL,
    LLM_MODEL: target.LLM_MODEL,
    LLM_WEB_SEARCH_ENABLED: 'true'
  };
}

function createServer(options = {}) {
  const runtimeEnv = { ...(options.env || process.env) };
  if (!runtimeEnv.ACCOUNT_ENCRYPTION_KEY && !runtimeEnv.COSMOS_ENDPOINT) runtimeEnv.ACCOUNT_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  const aiPromise = options.ai ? Promise.resolve(options.ai) : createTravelAI({ fetchImpl: options.fetchImpl });
  const placeImageFetchImpl = options.placeImageFetchImpl || globalThis.fetch;
  const shareStore = options.shareStore || (runtimeEnv.COSMOS_ENDPOINT
    ? createCosmosShareStore({ endpoint: runtimeEnv.COSMOS_ENDPOINT, databaseId: runtimeEnv.COSMOS_DATABASE, containerId: runtimeEnv.COSMOS_CONTAINER })
    : createMemoryShareStore());
  const accountStore = options.accountStore || (runtimeEnv.COSMOS_ENDPOINT
    ? createCosmosAccountStore({ endpoint: runtimeEnv.COSMOS_ENDPOINT, databaseId: runtimeEnv.COSMOS_DATABASE, containerId: runtimeEnv.COSMOS_ACCOUNT_CONTAINER })
    : createMemoryAccountStore());
  const sessionDays = Math.min(30, Math.max(1, Number(runtimeEnv.ACCOUNT_SESSION_DAYS) || 7));
  const sessionSeconds = sessionDays * 24 * 60 * 60;
  const secureCookies = runtimeEnv.NODE_ENV === 'production';

  async function authenticatedAccount(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const session = await accountStore.readSession(sessionIdForToken(token));
    if (!session || Date.parse(session.expiresAt) <= Date.now()) {
      if (session) await accountStore.deleteSession(session.id);
      return null;
    }
    const account = await accountStore.readAccount(session.accountId);
    return account ? { account, session } : null;
  }

  async function issueSession(account) {
    const token = newSessionToken();
    const now = Date.now();
    await accountStore.createSession({
      id: sessionIdForToken(token), type: 'session', accountId: account.id,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + sessionSeconds * 1000).toISOString(), ttl: sessionSeconds
    });
    return token;
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/health') {
        if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
        return json(res, 200, { status: 'ok', share_store: shareStore.kind, account_store: accountStore.kind, public_demo_enabled: publicDemoEnabled(runtimeEnv) });
      }
      if (url.pathname === '/api/place-image') {
        if (req.method !== 'GET') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
        if (!checkRateLimit(`place-image:${req.socket.remoteAddress || 'local'}`, Date.now(), 90)) return json(res, 429, { error: { code: 'RATE_LIMITED', message: '图片检索过于频繁，请稍后再试。' } });
        const city = String(url.searchParams.get('city') || '').trim();
        const place = String(url.searchParams.get('place') || '').trim();
        if (!place || place.length > 100 || city.length > 60) return json(res, 400, { error: { code: 'INVALID_REQUEST', message: '景点名称不正确。' } });
        const result = await searchPlaceImage(city,place,placeImageFetchImpl);
        return json(res, 200, result || { matched:false });
      }
      if (url.pathname === '/api/auth/session') {
        if (req.method !== 'GET') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
        const auth = await authenticatedAccount(req);
        const demoEnabled = publicDemoEnabled(runtimeEnv);
        return json(res, 200, auth
          ? { authenticated: true, account: publicAccount(auth.account), llm_configured: Boolean(auth.account.llmConfig), public_demo_enabled: demoEnabled }
          : { authenticated: false, public_demo_enabled: demoEnabled });
      }
      if (url.pathname === '/api/auth/register' || url.pathname === '/api/auth/login') {
        if (req.method !== 'POST') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
        if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) return json(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '请使用 application/json。' } });
        if (!checkRateLimit(`auth:${req.socket.remoteAddress || 'local'}`, Date.now(), runtimeEnv.AUTH_RATE_LIMIT_PER_MINUTE || 10)) return json(res, 429, { error: { code: 'RATE_LIMITED', message: '登录尝试过于频繁，请稍后再试。' } });
        const body = await readJson(req, 8 * 1024);
        const email = normalizeEmail(body?.email);
        const id = accountIdForEmail(email);
        let account;
        if (url.pathname.endsWith('/register')) {
          const password = await hashPassword(body?.password);
          const now = new Date().toISOString();
          account = await accountStore.createAccount({ id, type: 'account', email, passwordSalt: password.salt, passwordHash: password.hash, llmConfig: null, createdAt: now, updatedAt: now });
        } else {
          account = await accountStore.readAccount(id);
          if (!account || !await passwordMatches(body?.password, account)) throw new AccountError('INVALID_CREDENTIALS', '邮箱或密码不正确。', 401);
        }
        const token = await issueSession(account);
        return json(res, url.pathname.endsWith('/register') ? 201 : 200, { authenticated: true, account: publicAccount(account), llm_configured: Boolean(account.llmConfig), public_demo_enabled: publicDemoEnabled(runtimeEnv) }, {
          'set-cookie': sessionCookie(token, { secure: secureCookies, maxAge: sessionSeconds })
        });
      }
      if (url.pathname === '/api/auth/logout') {
        if (req.method !== 'POST') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (token) await accountStore.deleteSession(sessionIdForToken(token));
        return json(res, 200, { authenticated: false }, { 'set-cookie': sessionCookie('', { secure: secureCookies, maxAge: 0 }) });
      }
      if (url.pathname === '/api/shares') {
        if (req.method !== 'POST') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
        if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) return json(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '请使用 application/json。' } });
        if (!checkRateLimit(`share-create:${req.socket.remoteAddress || 'local'}`, Date.now(), runtimeEnv.SHARE_RATE_LIMIT_PER_MINUTE || 30)) return json(res, 429, { error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试。' } });
        const body = await readJson(req, SHARE_MAX_BYTES + 16 * 1024);
        const plan = normalizePlan(body?.plan);
        let item;
        let editToken;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const now = new Date().toISOString();
          editToken = newEditToken();
          try {
            item = await shareStore.create({ id: newShareId(), plan, editTokenHash: hashEditToken(editToken), version: 1, createdAt: now, updatedAt: now });
            break;
          } catch (error) {
            if (error.code !== 'SHARE_ID_COLLISION' || attempt === 2) throw error;
          }
        }
        return json(res, 201, { ...publicShare(item), edit_token: editToken });
      }
      const shareMatch = url.pathname.match(/^\/api\/shares\/([^/]+)$/);
      if (shareMatch) {
        const id = shareMatch[1];
        if (!SHARE_ID_PATTERN.test(id)) throw new ShareError('SHARE_NOT_FOUND', '分享不存在或已失效。', 404);
        if (req.method === 'GET' || req.method === 'HEAD') {
          const item = await shareStore.read(id);
          if (!item) throw new ShareError('SHARE_NOT_FOUND', '分享不存在或已失效。', 404);
          return json(res, 200, publicShare(item));
        }
        if (req.method !== 'PUT') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
        if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) return json(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '请使用 application/json。' } });
        if (!checkRateLimit(`share-write:${req.socket.remoteAddress || 'local'}`, Date.now(), runtimeEnv.SHARE_RATE_LIMIT_PER_MINUTE || 30)) return json(res, 429, { error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试。' } });
        const current = await shareStore.read(id);
        if (!current) throw new ShareError('SHARE_NOT_FOUND', '分享不存在或已失效。', 404);
        const authorization = String(req.headers.authorization || '');
        const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        if (!tokenMatches(token, current.editTokenHash)) throw new ShareError('SHARE_EDIT_FORBIDDEN', '此链接没有编辑权限。', 403);
        const body = await readJson(req, SHARE_MAX_BYTES + 16 * 1024);
        if (!Number.isSafeInteger(body?.version) || body.version < 1) throw new ShareError('INVALID_SHARED_PLAN', '共享规划版本无效。');
        const updated = await shareStore.update(id, body.version, current.editTokenHash, normalizePlan(body.plan), new Date().toISOString());
        if (!updated) throw new ShareError('SHARE_NOT_FOUND', '分享不存在或已失效。', 404);
        return json(res, 200, publicShare(updated));
      }
      if (url.pathname === '/api/llm/config/test') {
        if (req.method !== 'POST') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
        const auth = await authenticatedAccount(req);
        if (!auth) throw new AccountError('AUTH_REQUIRED', '请先登录账号。', 401);
        const saved = decryptConfig(auth.account.llmConfig, runtimeEnv.ACCOUNT_ENCRYPTION_KEY);
        if (!saved) throw new TravelAIError('LLM_NOT_CONFIGURED', '请先保存当前账号的模型配置。', 503);
        const ai = await aiPromise;
        return json(res, 200, await ai.testConnection({ ...runtimeEnv, ...saved }));
      }
      if (url.pathname === '/api/llm/config') {
        const auth = await authenticatedAccount(req);
        if (!auth) throw new AccountError('AUTH_REQUIRED', '请先登录账号。', 401);
        const saved = decryptConfig(auth.account.llmConfig, runtimeEnv.ACCOUNT_ENCRYPTION_KEY);
        if (req.method === 'GET') return json(res, 200, saved ? llmConfigStatus({ ...runtimeEnv, ...saved }) : {
          configured: false,
          base_url: '',
          model: '',
          web_search_enabled: true
        });
        if (req.method !== 'POST') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
        if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) return json(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '请使用 application/json。' } });
        const config = accountLLMEnv(await readJson(req), saved, runtimeEnv);
        auth.account.llmConfig = encryptConfig(config, runtimeEnv.ACCOUNT_ENCRYPTION_KEY);
        auth.account.updatedAt = new Date().toISOString();
        await accountStore.saveAccount(auth.account);
        return json(res, 200, llmConfigStatus({ ...runtimeEnv, ...config }));
      }
      if (req.method === 'POST' && url.pathname === '/api/ai/chat') {
        if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) return json(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '请使用 application/json。' } });
        if (!checkRateLimit(clientAddress(req))) return json(res, 429, { error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试。' } });
        const body = await readJson(req);
        const ai = await aiPromise;
        if (runtimeEnv.LLM_PROVIDER === 'mock') return json(res, 200, await ai.chat(body, runtimeEnv));
        const auth = await authenticatedAccount(req);
        const saved = auth ? decryptConfig(auth.account.llmConfig, runtimeEnv.ACCOUNT_ENCRYPTION_KEY) : null;
        const demoEnabled = publicDemoEnabled(runtimeEnv);
        if (!saved && !demoEnabled) {
          if (!auth) throw new AccountError('AUTH_REQUIRED', '请先登录并配置模型。', 401);
          throw new TravelAIError('LLM_NOT_CONFIGURED', '请先配置当前账号的模型 API。', 503);
        }
        if (!saved) {
          const demoIdentity = auth?.account?.id || clientAddress(req);
          const minuteLimit = runtimeEnv.PUBLIC_DEMO_RATE_LIMIT_PER_MINUTE || 3;
          const dailyLimit = runtimeEnv.PUBLIC_DEMO_DAILY_LIMIT || 100;
          if (!checkRateLimit(`public-demo:${demoIdentity}`, Date.now(), minuteLimit) || !checkDailyLimit('public-demo', Date.now(), dailyLimit)) {
            return json(res, 429, { error: { code: 'PUBLIC_DEMO_LIMIT_REACHED', message: '今天的公开体验额度已用完，请稍后再试。' } });
          }
        }
        return json(res, 200, await ai.chat(body, saved ? { ...runtimeEnv, ...saved } : runtimeEnv));
      }

      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (relative !== 'index.html' && !relative.startsWith(`assets${path.sep}`) && !relative.startsWith('assets/')) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
      const file = path.resolve(root, relative);
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) return json(res, 403, { error: { code: 'FORBIDDEN', message: 'Forbidden' } });
      fs.readFile(file, (error, data) => {
        if (error) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
        res.writeHead(200, {
          'content-type': types[path.extname(file)] || 'application/octet-stream',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        });
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
  const host = process.env.HOST || '0.0.0.0';
  server.listen(port, host, () => console.log(`Travel journal demo: http://${host}:${port}`));
}

module.exports = { createServer, readJson, checkRateLimit, applyLLMConfig, llmConfigStatus, accountLLMEnv, searchPlaceImage, compactPlaceName };
