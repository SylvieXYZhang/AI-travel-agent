const { loadEnvFile } = require('../lib/load-env.cjs');
const { createTravelAI } = require('../lib/travel-ai.cjs');

loadEnvFile();

async function main() {
  if (!process.env.LLM_API_KEY && !process.env.OPENAI_API_KEY) {
    console.error('Missing LLM_API_KEY (or OPENAI_API_KEY). No external request was sent.');
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const noSearch = args.includes('--no-search');
  if (noSearch) process.env.LLM_WEB_SEARCH_ENABLED = 'false';
  const message = args.filter(item => item !== '--no-search').join(' ').trim() || '北京出发，秋天一周，预算一万元，推荐三个适合看自然风景的目的地';
  const ai = await createTravelAI();
  const result = await ai.chat({ message, conversation: [], profile: {}, current_plan: null, locale: 'zh-CN', timezone: 'Asia/Shanghai' });
  console.log(JSON.stringify({
    mode: result.mode,
    intent: result.intent,
    answer: result.assistant_message,
    result_count: result.results.length,
    sources: result.citations.map(source => ({ title: source.title, url: source.url })),
    requires_confirmation: result.requires_confirmation,
    web_search_enabled: !noSearch
  }, null, 2));
}

main().catch(error => {
  console.error(`${error.code || 'SMOKE_FAILED'}: ${error.message}`);
  process.exitCode = 1;
});
