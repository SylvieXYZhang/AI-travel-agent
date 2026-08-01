const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, checkRateLimit } = require('../server.cjs');
const { createMemoryShareStore, normalizePlan } = require('../lib/share-store.cjs');

function samplePlan(overrides = {}) {
  return {
    city: '京都', color: '#ead0af', date: '2026年旅行手账', title: '京都三日计划', kicker: '慢慢旅行',
    intro: '一份可以共同修改的计划。', overview: ['Day 1｜抵达'], highlights: ['清水寺'],
    routes: ['🚆|机场 → 京都站'], food: ['汤豆腐'], accommodation: ['京都站附近'],
    daily_stays: ['Day 1｜京都站酒店｜人民币 ¥700/晚'], packing: '舒适步行鞋', quote: '慢慢走。',
    ...overrides
  };
}

async function withServer(run) {
  const server = createServer({ env: { LLM_PROVIDER: 'mock', SHARE_RATE_LIMIT_PER_MINUTE: '100' }, shareStore: createMemoryShareStore() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('shared plan can be created, publicly read, and edited with its secret', async () => {
  await withServer(async base => {
    const createdResponse = await fetch(`${base}/api/shares`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: samplePlan() })
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.match(created.id, /^[A-Za-z0-9_-]{20,64}$/);
    assert.ok(created.edit_token.length >= 32);
    assert.equal(created.version, 1);

    const read = await (await fetch(`${base}/api/shares/${created.id}`)).json();
    assert.equal(read.plan.city, '京都');
    assert.equal(read.edit_token, undefined);

    const updatedResponse = await fetch(`${base}/api/shares/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.edit_token}` },
      body: JSON.stringify({ version: 1, plan: samplePlan({ title: '好友修改后的京都计划' }) })
    });
    assert.equal(updatedResponse.status, 200);
    const updated = await updatedResponse.json();
    assert.equal(updated.version, 2);
    assert.equal(updated.plan.title, '好友修改后的京都计划');
  });
});

test('shared plan rejects missing permissions and stale updates without overwriting', async () => {
  await withServer(async base => {
    const created = await (await fetch(`${base}/api/shares`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: samplePlan() })
    })).json();
    const forbidden = await fetch(`${base}/api/shares/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer invalid-token-value-that-is-long-enough-1234' },
      body: JSON.stringify({ version: 1, plan: samplePlan({ title: '不应保存' }) })
    });
    assert.equal(forbidden.status, 403);

    await fetch(`${base}/api/shares/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${created.edit_token}` },
      body: JSON.stringify({ version: 1, plan: samplePlan({ title: '版本二' }) })
    });
    const conflict = await fetch(`${base}/api/shares/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${created.edit_token}` },
      body: JSON.stringify({ version: 1, plan: samplePlan({ title: '过期修改' }) })
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, 'SHARE_CONFLICT');
    assert.equal((await (await fetch(`${base}/api/shares/${created.id}`)).json()).plan.title, '版本二');
  });
});

test('shared plan validation rejects invalid and oversized content', () => {
  assert.throws(() => normalizePlan({ title: '没有目的地' }), /必须包含目的地/);
  assert.throws(() => normalizePlan(samplePlan({ overview: Array.from({ length: 31 }, () => 'x') })), /overview/);
  assert.throws(() => normalizePlan(samplePlan({ richSections: { intro: 'x'.repeat(450_001) } })), /richSections.intro/);
});

test('share IDs are validated and write rate limiting is bounded', async () => {
  await withServer(async base => {
    const missing = await fetch(`${base}/api/shares/not-a-valid-id`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'SHARE_NOT_FOUND');
  });
  const key = `share-test-${Date.now()}-${Math.random()}`;
  assert.equal(checkRateLimit(key, 1_000, 2), true);
  assert.equal(checkRateLimit(key, 1_001, 2), true);
  assert.equal(checkRateLimit(key, 1_002, 2), false);
});

test('health endpoint reports the configured share store', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', share_store: 'memory', account_store: 'memory', public_demo_enabled: false });
  });
});

test('browser UI exposes separate read and edit links and a dedicated shared-page mode', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="sharePlanButton"/);
  assert.match(html, /id="readShareUrl"/);
  assert.match(html, /id="editShareUrl"/);
  assert.match(html, /new URLSearchParams\(location\.search\)\.get\('share'\)/);
  assert.match(html, /new URLSearchParams\(location\.hash/);
  assert.match(html, /body\.classList\.add\('shared-mode'\)/);
  assert.match(html, /authorization':`Bearer \$\{info\.token\}`/);
});
