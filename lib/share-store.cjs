const crypto = require('crypto');

const SHARE_MAX_BYTES = 512 * 1024;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const STRING_FIELDS = ['city', 'color', 'date', 'title', 'kicker', 'intro', 'packing', 'quote'];
const ARRAY_FIELDS = ['overview', 'highlights', 'routes', 'food', 'accommodation', 'daily_stays'];
const RICH_FIELDS = ['date', 'title', 'kicker', 'intro', 'overview', 'highlights', 'routes', 'food', 'accommodation', 'daily_stays', 'packing', 'quote'];

class ShareError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ShareError';
    this.code = code;
    this.status = status;
  }
}

function encodedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function validateText(value, field, maxLength = 20_000) {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new ShareError('INVALID_SHARED_PLAN', `共享规划字段 ${field} 格式不正确。`);
  }
  return value;
}

function normalizePlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ShareError('INVALID_SHARED_PLAN', '共享规划格式不正确。');
  }
  const plan = {};
  for (const field of STRING_FIELDS) {
    if (value[field] !== undefined) plan[field] = validateText(value[field], field, field === 'intro' || field === 'packing' ? 40_000 : 4_000);
  }
  if (!plan.city || !plan.city.trim()) throw new ShareError('INVALID_SHARED_PLAN', '共享规划必须包含目的地。');
  for (const field of ARRAY_FIELDS) {
    if (value[field] === undefined) continue;
    if (!Array.isArray(value[field]) || value[field].length > 30) throw new ShareError('INVALID_SHARED_PLAN', `共享规划字段 ${field} 格式不正确。`);
    plan[field] = value[field].map((item, index) => validateText(item, `${field}[${index}]`, 20_000));
  }
  if (value.richSections !== undefined) {
    if (!value.richSections || typeof value.richSections !== 'object' || Array.isArray(value.richSections)) {
      throw new ShareError('INVALID_SHARED_PLAN', '共享规划富文本格式不正确。');
    }
    plan.richSections = {};
    for (const field of RICH_FIELDS) {
      if (value.richSections[field] !== undefined) plan.richSections[field] = validateText(value.richSections[field], `richSections.${field}`, 450_000);
    }
  }
  if (encodedBytes(plan) > SHARE_MAX_BYTES) {
    throw new ShareError('SHARED_PLAN_TOO_LARGE', '共享规划超过 512 KiB，请压缩或移除较大的本地图片。', 413);
  }
  return plan;
}

function newShareId() {
  return crypto.randomBytes(18).toString('base64url');
}

function newEditToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashEditToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function tokenMatches(token, expectedHash) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128 || typeof expectedHash !== 'string') return false;
  const actual = Buffer.from(hashEditToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function publicShare(item) {
  return { id: item.id, plan: item.plan, version: item.version, created_at: item.createdAt, updated_at: item.updatedAt };
}

function createMemoryShareStore() {
  const items = new Map();
  return {
    kind: 'memory',
    async create(item) {
      if (items.has(item.id)) throw new ShareError('SHARE_ID_COLLISION', '无法创建分享，请重试。', 409);
      const stored = { ...item, _etag: crypto.randomUUID() };
      items.set(item.id, stored);
      return { ...stored };
    },
    async read(id) {
      const item = items.get(id);
      return item ? { ...item } : null;
    },
    async update(id, expectedVersion, editTokenHash, plan, now) {
      const item = items.get(id);
      if (!item) return null;
      if (item.version !== expectedVersion) throw new ShareError('SHARE_CONFLICT', '这份规划已有新修改，请加载最新版后重试。', 409);
      const updated = { ...item, plan, editTokenHash, version: item.version + 1, updatedAt: now, _etag: crypto.randomUUID() };
      items.set(id, updated);
      return { ...updated };
    }
  };
}

function createCosmosShareStore(options = {}) {
  const endpoint = options.endpoint || process.env.COSMOS_ENDPOINT;
  const databaseId = options.databaseId || process.env.COSMOS_DATABASE || 'voyageai';
  const containerId = options.containerId || process.env.COSMOS_CONTAINER || 'sharedPlans';
  if (!endpoint) throw new Error('COSMOS_ENDPOINT is required');
  let containerPromise;
  async function container() {
    if (!containerPromise) {
      containerPromise = (async () => {
        const { CosmosClient } = require('@azure/cosmos');
        const { DefaultAzureCredential } = require('@azure/identity');
        const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
        return client.database(databaseId).container(containerId);
      })();
    }
    return containerPromise;
  }
  return {
    kind: 'cosmos',
    async create(item) {
      try {
        const response = await (await container()).items.create(item);
        return response.resource;
      } catch (error) {
        if (error.code === 409) throw new ShareError('SHARE_ID_COLLISION', '无法创建分享，请重试。', 409);
        throw error;
      }
    },
    async read(id) {
      try {
        const response = await (await container()).item(id, id).read();
        return response.resource || null;
      } catch (error) {
        if (error.code === 404) return null;
        throw error;
      }
    },
    async update(id, expectedVersion, editTokenHash, plan, now) {
      const target = await this.read(id);
      if (!target) return null;
      if (target.version !== expectedVersion) throw new ShareError('SHARE_CONFLICT', '这份规划已有新修改，请加载最新版后重试。', 409);
      const next = { ...target, plan, editTokenHash, version: target.version + 1, updatedAt: now };
      delete next._rid; delete next._self; delete next._attachments; delete next._ts;
      try {
        const response = await (await container()).item(id, id).replace(next, {
          accessCondition: { type: 'IfMatch', condition: target._etag }
        });
        return response.resource;
      } catch (error) {
        if (error.code === 412) throw new ShareError('SHARE_CONFLICT', '这份规划已有新修改，请加载最新版后重试。', 409);
        if (error.code === 404) return null;
        throw error;
      }
    }
  };
}

module.exports = {
  SHARE_MAX_BYTES, SHARE_ID_PATTERN, ShareError, normalizePlan, newShareId, newEditToken,
  hashEditToken, tokenMatches, publicShare, createMemoryShareStore, createCosmosShareStore
};
