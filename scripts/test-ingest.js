// 知识投喂测试：文件入库 + 索引登记 + 路径安全 + 「记住」指令识别
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KnowledgeManager } = require('../src/knowledge');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsai-ingest-test-'));
const noop = () => {};
const km = new KnowledgeManager({ store: null, runtimeBaseDir: path.join(tmp, 'runtime'), logger: { info: noop, warn: noop, error: noop } });
const botId = 'bot-test';

function t(name, fn) {
  try { fn(); console.log('✓', name); }
  catch (e) { console.error('✗', name, '-', e.message); process.exitCode = 1; }
}

t('投喂文件：写入 docs/ 并登记索引', () => {
  const r = km.ingestFile(botId, '产品需求.md', Buffer.from('# 需求文档\n内容'));
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(r.path), '文件应存在');
  const md = km.readKnowledge(botId);
  assert.ok(md.includes('docs/产品需求.md'), 'CLAUDE.md 应登记该文件');
  assert.ok(md.includes('## 已投喂文档'), '应有已投喂文档区段');
});

t('投喂文本：生成 .md 并登记', () => {
  const r = km.ingestText(botId, '用户偏好简洁回答', { title: 'user-pref' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.fileName, 'user-pref.md');
  assert.ok(km.readKnowledge(botId).includes('docs/user-pref.md'));
});

t('重复投喂同名文件不重复登记索引', () => {
  km.ingestFile(botId, '产品需求.md', Buffer.from('v2'));
  const md = km.readKnowledge(botId);
  const count = md.split('docs/产品需求.md').length - 1;
  assert.strictEqual(count, 1, '索引里应只有一条');
});

t('路径穿越防护', () => {
  const r = km.ingestFile(botId, '../../../evil.txt', Buffer.from('x'));
  assert.ok(!r.fileName.includes('..'), '不应含 ..');
  assert.ok(!r.fileName.includes('/'), '不应含 /');
  assert.ok(!r.fileName.includes('\\'), '不应含 \\');
});

t('Windows 非法字符替换', () => {
  const r = km.ingestFile(botId, 'a<b>c:d"e|f?g*h.txt', Buffer.from('x'));
  assert.ok(r.ok);
  assert.ok(!/[<>:"|?*]/.test(r.fileName), '非法字符应被替换');
});

t('listDocs 返回已投喂文档', () => {
  const docs = km.listDocs(botId);
  const names = docs.map((d) => d.name);
  assert.ok(names.includes('产品需求.md'));
  assert.ok(names.includes('user-pref.md'));
  assert.ok(docs.every((d) => d.size >= 0));
});

t('删除文档同时移除索引', () => {
  const r = km.removeDoc(botId, '产品需求.md');
  assert.strictEqual(r.ok, true);
  assert.ok(!km.readKnowledge(botId).includes('docs/产品需求.md'), '索引应已移除');
  assert.ok(!km.listDocs(botId).map((d) => d.name).includes('产品需求.md'), '文件应已删除');
});

t('空文件名有兜底', () => {
  const r = km.ingestFile(botId, '', Buffer.from('x'));
  assert.strictEqual(r.ok, true);
  assert.ok(r.fileName.length > 0);
});

t('「记住：xxx」指令正则匹配', () => {
  const re = /^(?:@\S+\s*)?记住(?:这个)?[：:]\s*([\s\S]+)$/;
  assert.ok(re.test('记住：用户喜欢用 TypeScript'));
  assert.ok(re.test('记住这个：项目用 pnpm'));
  assert.ok(re.test('@机器人 记住：部署要跑测试'));
  assert.ok(!re.test('记住了吗'));
  assert.ok(!re.test('帮我记住这件事'));
});

// 清理
fs.rmSync(tmp, { recursive: true, force: true });
console.log(process.exitCode ? '\n知识投喂测试存在失败 ✗' : '\n全部知识投喂测试通过 ✓');
