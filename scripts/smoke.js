// 冒烟测试：验证核心模块可加载、数据模型/存储/日志脱敏/环境检测正常
// 运行：node scripts/smoke.js
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsai-smoke-'));

// 1. models
const { newBot, newWorkspace, newDirectProfile, defaultConfig } = require('../src/models');
assert(newBot({ name: 'test' }).name === 'test');
assert(defaultConfig().bots.length === 0);
console.log('✓ models');

// 2. store
const { Store } = require('../src/store');
const store = new Store(tmp);
const ws = store.upsertWorkspace(newWorkspace({ name: 'backend', path: '/x/backend' }));
const bot = store.upsertBot(newBot({ name: 'Backend Coder' }));
bot.workspaceId = ws.id;
store.upsertBot(bot);
assert(store.getBot(bot.id).workspaceId === ws.id);
console.log('✓ store');

// 3. logger + secret 脱敏
const { Logger } = require('../src/logger');
const logger = new Logger(tmp);
logger.registerSecret('sk-1234567890abcdef');
const entry = logger.info('app', 'key is sk-1234567890abcdef');
assert(entry.message.includes('sk-****cdef'));
assert(!entry.message.includes('1234567890abcdef'));
console.log('✓ logger redaction');

// 4. doctor
const { runDoctor } = require('../src/doctor');
const doc = runDoctor({});
assert(typeof doc.system.ok === 'boolean');
assert(doc.runtime.found === true); // 本机已装 claude
console.log('✓ doctor (claude found:', doc.runtime.found, ', path:', doc.runtime.path + ')');

// 5. cc-switch parse（容错：不存在也应返回空数组而不崩溃）
const { parseProfiles } = require('../src/cc-switch');
assert(Array.isArray(parseProfiles('/nonexistent.json')));
console.log('✓ cc-switch parse');

// 6. model-resolver direct 分支
const { resolve } = require('../src/model-resolver');
const directP = store.upsertDirectProfile(newDirectProfile({ name: 'Kimi', baseUrl: 'https://api.moonshot.cn/anthropic', apiKey: 'sk-test1234567890', model: 'kimi-k2' }));
const r = resolve({ model: { source: 'direct', profile: directP.id } }, store);
assert(r.ok === true);
assert(r.env.ANTHROPIC_API_KEY === 'sk-test1234567890');
assert(r.env.ANTHROPIC_MODEL === 'kimi-k2');
console.log('✓ model-resolver direct');

// 7. runtime-manager 构造
const { RuntimeManager } = require('../src/runtime-manager');
const rm = new RuntimeManager({ runtimeBaseDir: path.join(tmp, 'runtime'), claudePath: 'claude', logger });
const home = rm.ensureBotHome('bot-1');
assert(fs.existsSync(home));
assert(fs.existsSync(path.join(home, '.claude')));
console.log('✓ runtime-manager isolation');

// 清理
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n全部冒烟测试通过 ✓');
