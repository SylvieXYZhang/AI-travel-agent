const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_COOKIE = 'voyage_session';

class AccountError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
    this.status = status;
  }
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new AccountError('INVALID_EMAIL', '请输入有效的邮箱地址。');
  return email;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw new AccountError('INVALID_PASSWORD', '密码长度应为 8–128 个字符。');
  return value;
}

function accountIdForEmail(email) { return `account_${crypto.createHash('sha256').update(email).digest('hex')}`; }

async function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  const derived = await scrypt(validatePassword(password), salt, 64);
  return { salt, hash: Buffer.from(derived).toString('base64url') };
}

async function passwordMatches(password, account) {
  if (typeof password !== 'string' || !account?.passwordSalt || !account?.passwordHash) return false;
  const derived = await scrypt(password, account.passwordSalt, 64);
  const actual = Buffer.from(derived);
  const expected = Buffer.from(account.passwordHash, 'base64url');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function newSessionToken() { return crypto.randomBytes(32).toString('base64url'); }
function sessionIdForToken(token) { return `session_${crypto.createHash('sha256').update(String(token || '')).digest('hex')}`; }

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function sessionCookie(token, options = {}) {
  const secure = options.secure !== false;
  const maxAge = Math.max(0, Number(options.maxAge) || 0);
  return `${SESSION_COOKIE}=${encodeURIComponent(token || '')}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${maxAge}`;
}

function encryptionKey(value) {
  const raw = String(value || '').trim();
  let key;
  if (/^[a-f0-9]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else { try { key = Buffer.from(raw, 'base64'); } catch {} }
  if (!key || key.length !== 32) throw new AccountError('ACCOUNT_ENCRYPTION_UNAVAILABLE', '服务端尚未配置账号密钥加密，请联系管理员。', 503);
  return key;
}

function encryptConfig(config, keyValue) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(keyValue), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') };
}

function decryptConfig(value, keyValue) {
  if (!value) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(keyValue), Buffer.from(value.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64url')), decipher.final()]).toString('utf8'));
  } catch (error) {
    if (error instanceof AccountError) throw error;
    throw new AccountError('ACCOUNT_CONFIG_UNREADABLE', '账号模型配置无法解密，请重新保存配置。', 503);
  }
}

function publicAccount(account) { return { id: account.id, email: account.email, created_at: account.createdAt }; }

function createMemoryAccountStore() {
  const items = new Map();
  return {
    kind: 'memory',
    async createAccount(account) {
      if (items.has(account.id)) throw new AccountError('ACCOUNT_EXISTS', '该邮箱已注册。', 409);
      const stored = { ...account, _etag: crypto.randomUUID() };
      items.set(account.id, stored);
      return { ...stored };
    },
    async readAccount(id) { const item = items.get(id); return item?.type === 'account' ? { ...item } : null; },
    async saveAccount(account) {
      const current = items.get(account.id);
      if (account._etag && current?._etag !== account._etag) {
        throw new AccountError('ACCOUNT_CONFLICT', '账号已在其他位置更新，请重试。', 409);
      }
      const stored = { ...account, _etag: crypto.randomUUID() };
      items.set(account.id, stored);
      return { ...stored };
    },
    async createSession(session) { items.set(session.id, { ...session }); return { ...session }; },
    async readSession(id) { const item = items.get(id); return item?.type === 'session' ? { ...item } : null; },
    async deleteSession(id) { items.delete(id); }
  };
}

function createCosmosAccountStore(options = {}) {
  const endpoint = options.endpoint || process.env.COSMOS_ENDPOINT;
  const databaseId = options.databaseId || process.env.COSMOS_DATABASE || 'voyageai';
  const containerId = options.containerId || process.env.COSMOS_ACCOUNT_CONTAINER || 'accounts';
  if (!endpoint) throw new Error('COSMOS_ENDPOINT is required');
  let containerPromise;
  async function container() {
    if (!containerPromise) containerPromise = (async () => {
      const { CosmosClient } = require('@azure/cosmos');
      const { DefaultAzureCredential } = require('@azure/identity');
      const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
      return client.database(databaseId).container(containerId);
    })();
    return containerPromise;
  }
  async function read(id) {
    try { return (await (await container()).item(id, id).read()).resource || null; }
    catch (error) { if (error.code === 404) return null; throw error; }
  }
  return {
    kind: 'cosmos',
    async createAccount(account) { try { return (await (await container()).items.create(account)).resource; } catch (error) { if (error.code === 409) throw new AccountError('ACCOUNT_EXISTS', '该邮箱已注册。', 409); throw error; } },
    async readAccount(id) { const item = await read(id); return item?.type === 'account' ? item : null; },
    async saveAccount(account) {
      const clean = { ...account };
      delete clean._rid; delete clean._self; delete clean._etag; delete clean._attachments; delete clean._ts;
      try {
        if (account._etag) {
          return (await (await container()).item(account.id, account.id).replace(clean, {
            accessCondition: { type: 'IfMatch', condition: account._etag }
          })).resource;
        }
        return (await (await container()).items.upsert(clean)).resource;
      } catch (error) {
        if (error.code === 412) throw new AccountError('ACCOUNT_CONFLICT', '账号已在其他位置更新，请重试。', 409);
        throw error;
      }
    },
    async createSession(session) { return (await (await container()).items.upsert(session)).resource; },
    async readSession(id) { const item = await read(id); return item?.type === 'session' ? item : null; },
    async deleteSession(id) { try { await (await container()).item(id, id).delete(); } catch (error) { if (error.code !== 404) throw error; } }
  };
}

module.exports = {
  AccountError, SESSION_COOKIE, normalizeEmail, validatePassword, accountIdForEmail, hashPassword, passwordMatches,
  newSessionToken, sessionIdForToken, parseCookies, sessionCookie, encryptConfig, decryptConfig, publicAccount,
  createMemoryAccountStore, createCosmosAccountStore
};
