const { loadEnvFile } = require('../lib/load-env.cjs');
const { createTravelAI } = require('../lib/travel-ai.cjs');

loadEnvFile();

const shanghaiPlan = {
  id: 'destination-0', city: '上海', destination: '上海', duration_days: 3,
  title: '上海3日旅行计划', overview: ['Day 1｜抵达上海 · 外滩', 'Day 2｜武康路 · 老洋房', 'Day 3｜豫园 · 返程']
};

const CASES = [
  {
    id: 'shanghai-3d',
    message: '帮我规划一次三天的上海旅行。',
    expect: { modes: ['PLAN'], intents: ['create_plan'], expectProposal: true, requiresConfirmation: true, durationDays: 3 }
  },
  {
    id: 'beijing-elderly',
    message: '我想带年迈的父母去北京，不要人多拥挤的景点，也不想长时间走路，请给我一个具体的计划。',
    expect: {
      modes: ['PLAN'], intents: ['create_plan'], expectProposal: true, requiresConfirmation: true,
      mentionAny: ['无障碍', '轮椅', '步行', '老人', '父母', '拥挤', '人少', '缓慢', '代步', '电瓶车', '观光车']
    }
  },
  {
    id: 'week-where',
    message: '国庆一周,从上海出发,预算八千,推荐几个适合秋天的目的地。',
    expect: { modes: ['EXPLORE'], intents: ['recommend_destinations'], minResults: 3, expectProposal: false }
  },
  {
    id: 'chengdu-kids',
    message: '带两个小孩去成都玩四天,想轻松一点,有哪些适合亲子的安排?',
    expect: {
      modes: ['PLAN', 'EXPLORE'], intents: ['create_plan', 'recommend_destinations', 'answer_question'],
      mentionAny: ['亲子', '小孩', '儿童', '熊猫', '轻松']
    }
  },
  {
    id: 'modify-to-5d',
    message: '把当前行程改成五天。',
    current_plan: shanghaiPlan,
    expect: { modes: ['PLAN'], intents: ['modify_current'], expectProposal: true, requiresConfirmation: true, preserveUnmentioned: true, durationDays: 5 }
  },
  {
    id: 'add-waypoint',
    message: '在行程里加上苏州作为途经点。',
    current_plan: shanghaiPlan,
    expect: { modes: ['PLAN'], intents: ['modify_current'], expectProposal: true, requiresConfirmation: true, mentionAny: ['苏州'] }
  },
  {
    id: 'food-focus',
    message: '去西安三天,重点想吃当地美食,帮我安排。',
    expect: { modes: ['PLAN'], intents: ['create_plan'], expectProposal: true, requiresConfirmation: true, mentionAny: ['美食', '小吃', '肉夹馍', '面', '回民街', '吃'] }
  },
  {
    id: 'budget-question',
    message: '冬天去哈尔滨看冰雪大世界,门票大概多少钱?',
    expect: { modes: ['EXPLORE', 'PLAN'], intents: ['answer_question'], expectProposal: false, minCitations: 1 }
  },
  {
    id: 'ambiguous-clarify',
    message: '我想出去玩。',
    expect: { modes: ['EXPLORE', 'CLARIFY'], intents: ['clarify', 'recommend_destinations'], expectProposal: false }
  },
  {
    id: 'profile-pref',
    message: '以后都别给我推荐去过的城市。',
    expect: { intents: ['update_profile'], expectProposal: true, requiresConfirmation: true, proposalOperation: 'update_profile' }
  }
];

function parseArgs(argv) {
  const args = { mock: false, json: false, only: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mock') args.mock = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--only') args.only = new Set((argv[++index] || '').split(',').map(item => item.trim()).filter(Boolean));
  }
  return args;
}

function proposalPlan(response) {
  return response.proposal && response.proposal.patch && response.proposal.patch.plan ? response.proposal.patch.plan : null;
}

function haystack(response) {
  const plan = proposalPlan(response);
  const parts = [response.assistant_message || ''];
  if (plan) {
    for (const key of ['title', 'kicker', 'intro', 'packing', 'quote', 'waypoint']) if (typeof plan[key] === 'string') parts.push(plan[key]);
    for (const key of ['overview', 'highlights', 'routes', 'food']) if (Array.isArray(plan[key])) parts.push(plan[key].join(' '));
  }
  for (const result of response.results || []) {
    parts.push(result.title || '', result.summary || '');
    if (Array.isArray(result.details)) parts.push(result.details.join(' '));
  }
  return parts.join(' ');
}

function evaluate(response, expect, isMock) {
  const failures = [];
  const warnings = [];
  const proposal = response.proposal;
  const plan = proposalPlan(response);

  // Under --mock the provider returns a fixed answer_question shape and does not
  // route intents, so only pipeline plumbing + schema validity are exercised.
  // Reaching here means chat() already produced a schema-valid response.
  if (isMock) {
    warnings.push('expectation checks skipped under --mock (pipeline/schema only)');
    return { failures, warnings };
  }

  // Hard structural checks (apply in every mode).
  if (expect.modes && !expect.modes.includes(response.mode)) failures.push(`mode ${response.mode} not in [${expect.modes.join(', ')}]`);
  if (expect.intents && !expect.intents.includes(response.intent)) failures.push(`intent ${response.intent} not in [${expect.intents.join(', ')}]`);
  if (expect.expectProposal === true && (!proposal || typeof proposal !== 'object')) failures.push('expected a proposal object');
  if (expect.expectProposal === false && proposal !== null) failures.push('expected proposal=null');
  if (expect.requiresConfirmation === true && response.requires_confirmation !== true) failures.push('expected requires_confirmation=true');
  if (expect.proposalOperation && (!proposal || proposal.operation !== expect.proposalOperation)) failures.push(`expected proposal.operation=${expect.proposalOperation}`);
  if (expect.preserveUnmentioned === true && proposal && proposal.preserve_unmentioned !== true) failures.push('expected proposal.preserve_unmentioned=true');
  if (typeof expect.minResults === 'number' && (response.results || []).length < expect.minResults) failures.push(`expected >= ${expect.minResults} results, got ${(response.results || []).length}`);

  // Semantic checks are soft: LLM wording varies, so report as warnings not failures.
  if (expect.durationDays) {
    const duration = (plan && plan.duration_days) || (proposal && proposal.duration_days) || null;
    if (duration !== expect.durationDays) warnings.push(`duration_days ${duration} != expected ${expect.durationDays}`);
  }
  if (expect.mentionAny) {
    const text = haystack(response);
    if (!expect.mentionAny.some(word => text.includes(word))) warnings.push(`none of [${expect.mentionAny.join(', ')}] mentioned`);
  }
  if (typeof expect.minCitations === 'number' && (response.citations || []).length < expect.minCitations) {
    warnings.push(`expected >= ${expect.minCitations} citations, got ${(response.citations || []).length}`);
  }
  return { failures, warnings };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = { ...process.env };
  if (args.mock) env.LLM_PROVIDER = 'mock';

  if (!args.mock && !env.LLM_API_KEY && !env.OPENAI_API_KEY) {
    console.error('Missing LLM_API_KEY (or OPENAI_API_KEY). No external request was sent.');
    console.error('配置 .env（LLM_API_KEY / LLM_BASE_URL / LLM_MODEL）后重试，或使用 --mock 做无依赖流水线冒烟。');
    process.exitCode = 2;
    return;
  }

  const cases = args.only ? CASES.filter(item => args.only.has(item.id)) : CASES;
  if (!cases.length) {
    console.error('没有匹配的用例。可用 id: ' + CASES.map(item => item.id).join(', '));
    process.exitCode = 2;
    return;
  }

  const ai = await createTravelAI();
  const report = [];

  for (const testCase of cases) {
    const record = { id: testCase.id, message: testCase.message, ok: false, failures: [], warnings: [] };
    try {
      const response = await ai.chat({
        message: testCase.message,
        conversation: [],
        profile: testCase.profile || {},
        current_plan: testCase.current_plan || null,
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai'
      }, env);
      const { failures, warnings } = evaluate(response, testCase.expect, args.mock);
      record.mode = response.mode;
      record.intent = response.intent;
      record.requires_confirmation = response.requires_confirmation;
      record.result_count = (response.results || []).length;
      record.source_count = (response.citations || []).length;
      record.assistant_message = response.assistant_message;
      record.failures = failures;
      record.warnings = warnings;
      record.ok = failures.length === 0;
    } catch (error) {
      record.failures = [`${error.code || 'ERROR'}: ${error.message}`];
    }
    report.push(record);
    if (!args.json) printCase(record);
  }

  const passed = report.filter(item => item.ok).length;
  if (args.json) {
    console.log(JSON.stringify({ total: report.length, passed, results: report }, null, 2));
  } else {
    console.log(`\n${passed}/${report.length} passed${args.mock ? ' (mock)' : ''}`);
  }
  if (passed !== report.length) process.exitCode = 1;
}

function printCase(record) {
  const status = record.ok ? 'PASS' : 'FAIL';
  console.log(`\n[${status}] ${record.id} · ${record.message}`);
  if (record.mode) console.log(`  mode=${record.mode} intent=${record.intent} confirm=${record.requires_confirmation} results=${record.result_count} sources=${record.source_count}`);
  if (record.assistant_message) console.log(`  answer: ${record.assistant_message.slice(0, 120)}${record.assistant_message.length > 120 ? '…' : ''}`);
  for (const failure of record.failures) console.log(`  ✗ ${failure}`);
  for (const warning of record.warnings) console.log(`  ! ${warning}`);
}

main().catch(error => {
  console.error(`${error.code || 'BATCH_FAILED'}: ${error.message}`);
  process.exitCode = 1;
});
