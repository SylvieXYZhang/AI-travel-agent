const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server.cjs');
const { accountIdForEmail, createMemoryAccountStore } = require('../lib/account-store.cjs');

async function withServer(run) {
  const server = createServer({
    env: { LLM_PROVIDER: 'openai', ACCOUNT_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), AUTH_RATE_LIMIT_PER_MINUTE: '100' },
    accountStore: createMemoryAccountStore()
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function cookieFrom(response) { return response.headers.get('set-cookie').split(';')[0]; }

test('register, session, logout, and password login use an HttpOnly session cookie', async () => {
  await withServer(async base => {
    const registered = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'User@Example.com', password: 'long-password-123' })
    });
    assert.equal(registered.status, 201);
    assert.match(registered.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    const cookie = cookieFrom(registered);
    const session = await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json();
    assert.equal(session.authenticated, true);
    assert.equal(session.account.email, 'user@example.com');
    assert.equal(session.llm_configured, false);

    const duplicate = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password: 'another-password' })
    });
    assert.equal(duplicate.status, 409);

    const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json()).authenticated, false);

    const wrong = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password: 'wrong-password' })
    });
    assert.equal(wrong.status, 401);
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password: 'long-password-123' })
    });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).account.email, 'user@example.com');
  });
});

test('model configuration endpoints never accept an unauthenticated caller', async () => {
  await withServer(async base => {
    for (const [path, method] of [['/api/llm/config', 'GET'], ['/api/llm/config', 'POST'], ['/api/llm/config/test', 'POST']]) {
      const response = await fetch(`${base}${path}`, { method, headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined, body: method === 'POST' && path.endsWith('config') ? '{}' : undefined });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal((await response.json()).error.code, 'AUTH_REQUIRED');
    }
  });
});

test('two accounts use different model credentials for AI requests', async () => {
  const authorizations = [];
  const server = createServer({
    env: { LLM_PROVIDER: 'openai', ACCOUNT_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'), AUTH_RATE_LIMIT_PER_MINUTE: '100', LLM_WEB_SEARCH_ENABLED: 'false' },
    accountStore: createMemoryAccountStore(),
    fetchImpl: async (_url, options) => {
      authorizations.push(options.headers.authorization);
      return { ok: true, status: 200, json: async () => ({
        output_text: JSON.stringify({ mode: 'PLAN', intent: 'answer_question', assistant_message: 'ok', requires_confirmation: false, missing_fields: [], proposal: null, results: [], citations: [], warnings: [] }), output: []
      }) };
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cookies = [];
    for (const email of ['one@example.com', 'two@example.com']) {
      const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password-12345' }) });
      cookies.push(cookieFrom(response));
    }
    for (const [index, cookie] of cookies.entries()) {
      const response = await fetch(`${base}/api/llm/config`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ api_key: `account-secret-${index + 1}`, base_url: 'https://models.example.com/v1', model: `model-${index + 1}` })
      });
      assert.equal(response.status, 200);
      await fetch(`${base}/api/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ message: '京都有什么推荐？' }) });
    }
    assert.deepEqual(authorizations, ['Bearer account-secret-1', 'Bearer account-secret-2']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('public demo uses only the server-side key and enforces its daily allowance', async () => {
  const authorizations = [];
  const server = createServer({
    env: {
      LLM_PROVIDER: 'openai', LLM_API_KEY: 'server-only-demo-key',
      LLM_BASE_URL: 'https://models.example.com/v1', LLM_MODEL: 'demo-model',
      LLM_WEB_SEARCH_ENABLED: 'false', PUBLIC_DEMO_ENABLED: 'true',
      PUBLIC_DEMO_RATE_LIMIT_PER_MINUTE: '100', PUBLIC_DEMO_DAILY_LIMIT: '1',
      AI_RATE_LIMIT_PER_MINUTE: '100'
    },
    fetchImpl: async (_url, options) => {
      authorizations.push(options.headers.authorization);
      return { ok: true, status: 200, json: async () => ({
        output_text: JSON.stringify({ mode: 'PLAN', intent: 'answer_question', assistant_message: 'ok', requires_confirmation: false, missing_fields: [], proposal: null, results: [], citations: [], warnings: [] }), output: []
      }) };
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const session = await (await fetch(`${base}/api/auth/session`)).json();
    assert.equal(session.authenticated, false);
    assert.equal(session.public_demo_enabled, true);
    assert.equal(JSON.stringify(session).includes('server-only-demo-key'), false);

    const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '京都三日游' }) };
    assert.equal((await fetch(`${base}/api/ai/chat`, request)).status, 200);
    const limited = await fetch(`${base}/api/ai/chat`, request);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, 'PUBLIC_DEMO_LIMIT_REACHED');
    assert.deepEqual(authorizations, ['Bearer server-only-demo-key']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('page state is account-scoped and starts separately from the shared cold-start page', async () => {
  await withServer(async base => {
    const anonymous = await fetch(`${base}/api/account/state`);
    assert.equal(anonymous.status, 401);

    const register = async email => {
      const response = await fetch(`${base}/api/auth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'long-password-123' })
      });
      assert.equal(response.status, 201);
      return cookieFrom(response);
    };
    const firstCookie = await register('state-one@example.com');
    const secondCookie = await register('state-two@example.com');

    const firstColdStart = await (await fetch(`${base}/api/account/state`, { headers: { cookie: firstCookie } })).json();
    const secondColdStart = await (await fetch(`${base}/api/account/state`, { headers: { cookie: secondCookie } })).json();
    assert.deepEqual(firstColdStart, { version: 0, state: null });
    assert.deepEqual(secondColdStart, { version: 0, state: null });

    const accountState = {
      plans: [{
        city: '京都', color: '#ffffff', title: '我的手动修改', intro: '仅属于账号一',
        overview: ['Day 1｜抵达'], highlights: ['哲学之道'], routes: ['⌁|步行'], food: ['豆腐料理'],
        accommodation: ['祇园'], daily_stays: ['Day 1｜祇园｜人民币 ¥800'], packing: '轻装', quote: '出发',
        content_origin: 'user-edit'
      }],
      profile: { travel_style: '舒适充电' }, profile_photo: '', active_index: 0
    };
    const saved = await fetch(`${base}/api/account/state`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: firstCookie },
      body: JSON.stringify({ version: 0, state: accountState })
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).version, 1);

    const restored = await (await fetch(`${base}/api/account/state`, { headers: { cookie: firstCookie } })).json();
    assert.equal(restored.version, 1);
    assert.equal(restored.state.plans[0].title, '我的手动修改');
    assert.equal(restored.state.plans[0].content_origin, 'user-edit');
    assert.equal(restored.state.profile.travel_style, '舒适充电');

    const stillColdStart = await (await fetch(`${base}/api/account/state`, { headers: { cookie: secondCookie } })).json();
    assert.deepEqual(stillColdStart, { version: 0, state: null });

    const staleWrite = await fetch(`${base}/api/account/state`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: firstCookie },
      body: JSON.stringify({ version: 0, state: accountState })
    });
    assert.equal(staleWrite.status, 409);
    assert.equal((await staleWrite.json()).error.code, 'ACCOUNT_STATE_CONFLICT');
  });
});

test('concurrent account state writes reject one stale update instead of overwriting it', async () => {
  const baseStore = createMemoryAccountStore();
  let arrivals = 0;
  let releaseWrites;
  const writeGate = new Promise(resolve => { releaseWrites = resolve; });
  const accountStore = {
    ...baseStore,
    async saveAccount(account) {
      arrivals += 1;
      if (arrivals <= 2) {
        if (arrivals === 2) releaseWrites();
        await writeGate;
      }
      return baseStore.saveAccount(account);
    }
  };
  const server = createServer({
    env: { LLM_PROVIDER: 'openai', ACCOUNT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), AUTH_RATE_LIMIT_PER_MINUTE: '100' },
    accountStore
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const registered = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'concurrent@example.com', password: 'long-password-123' })
    });
    const cookie = cookieFrom(registered);
    const editToken = 'secret-edit-token-12345678901234567890';
    const stateFor = title => ({
      plans: [{
        city: '京都', title, overview: [], highlights: [], routes: [], food: [], accommodation: [], daily_stays: [],
        _share: { id: 'share_12345678901234567890', token: editToken, version: 1 }
      }],
      profile: {}, profile_photo: '', active_index: 0
    });
    const responses = await Promise.all(['first', 'second'].map(title => fetch(`${base}/api/account/state`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ version: 0, state: stateFor(title) })
    })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const conflict = responses.find(response => response.status === 409);
    assert.equal((await conflict.json()).error.code, 'ACCOUNT_STATE_CONFLICT');
    const stored = await baseStore.readAccount(accountIdForEmail('concurrent@example.com'));
    assert.equal(JSON.stringify(stored.pageState).includes(editToken), false);
    assert.ok(stored.pageState.plans[0]._share.encrypted_token);
    const restored = await (await fetch(`${base}/api/account/state`, { headers: { cookie } })).json();
    assert.equal(restored.state.plans[0]._share.token, editToken);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
