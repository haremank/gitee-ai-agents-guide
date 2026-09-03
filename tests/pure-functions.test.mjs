// 纯函数回归测试：从 gitee-ai-workbench.user.js 中按名提取函数源码，
// 在隔离作用域内求值后断言行为。这是单文件油猴脚本在没有构建拆分时的务实测试方案，
// 覆盖历次重构中真正出过问题的函数（safeTaskUrl、时间戳处理、媒体类型判定等）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../gitee-ai-workbench.user.js', import.meta.url), 'utf8');

function extractFunction(name) {
    const re = new RegExp(`\\bfunction ${name}\\s*\\(`);
    const m = src.match(re);
    if (!m) throw new Error(`function ${name} not found`);
    const start = m.index;
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let j = open; j < src.length; j += 1) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(start, j + 1);
        }
    }
    throw new Error(`unbalanced braces in function ${name}`);
}

function extractConst(name) {
    const m = src.match(new RegExp(`(?:const|let) ${name}\\s*=\\s*[^;\\n]+;`));
    if (!m) throw new Error(`const ${name} not found`);
    return m[0];
}

const bundle = [
    "'use strict';",
    'const location = { href: "https://example.com/page" };',
    extractConst('API_BASE'),
    extractConst('CLOUD_TASK_LINK_TTL'),
    extractFunction('safeTaskUrl'),
    extractFunction('cloudTaskTimestamp'),
    extractFunction('isHttpUrl'),
    extractFunction('extFallback'),
    extractFunction('extFromUrl'),
    extractFunction('mediaKind'),
    extractFunction('formatBytes'),
    extractFunction('sanitizeFilename'),
    extractFunction('shortTaskId'),
    'return { safeTaskUrl, cloudTaskTimestamp, isHttpUrl, extFallback, extFromUrl, mediaKind, formatBytes, sanitizeFilename, shortTaskId };'
].join('\n');

const fns = new Function(bundle)();

test('safeTaskUrl: 空值必须返回 fallback 而不是 API 根地址', () => {
    const fallback = `${'https://ai.gitee.com'}/v1/task/ABC`;
    assert.equal(fns.safeTaskUrl(null, fallback), fallback);
    assert.equal(fns.safeTaskUrl('', fallback), fallback);
    assert.equal(fns.safeTaskUrl(undefined, fallback), fallback);
});

test('safeTaskUrl: 跨源地址拒绝，同源与相对地址放行', () => {
    const fallback = 'https://ai.gitee.com/v1/task/ABC/cancel';
    assert.equal(fns.safeTaskUrl('https://evil.com/v1/task/ABC', fallback), fallback);
    assert.equal(fns.safeTaskUrl('https://ai.gitee.com/v1/task/ABC', fallback), 'https://ai.gitee.com/v1/task/ABC');
    assert.equal(fns.safeTaskUrl('/v1/task/ABC', fallback), 'https://ai.gitee.com/v1/task/ABC');
});

test('cloudTaskTimestamp: 秒级时间戳归一化为毫秒，毫秒原样，非法返回 NaN', () => {
    assert.equal(fns.cloudTaskTimestamp({ created_at: 1787474128 }), 1787474128000);
    assert.equal(fns.cloudTaskTimestamp({ created_at: 1787474128000 }), 1787474128000);
    assert.equal(fns.cloudTaskTimestamp({ created_at: '2026-08-24T00:00:00Z' }), Date.parse('2026-08-24T00:00:00Z'));
    assert.ok(Number.isNaN(fns.cloudTaskTimestamp({})));
    assert.ok(Number.isNaN(fns.cloudTaskTimestamp({ created_at: 'not-a-date' })));
    assert.ok(Number.isNaN(fns.cloudTaskTimestamp(null)));
});

test('isHttpUrl: http/https/data 放行，其余拒绝', () => {
    assert.equal(fns.isHttpUrl('https://gitee-ai.su.bcebos.com/a.mp4?sig=1'), true);
    assert.equal(fns.isHttpUrl('http://example.com/a.png'), true);
    assert.equal(fns.isHttpUrl('data:image/png;base64,AAAA'), true);
    assert.equal(fns.isHttpUrl('一段纯文本结果'), false);
    assert.equal(fns.isHttpUrl(''), false);
    assert.equal(fns.isHttpUrl(null), false);
});

test('extFallback: 按类型给缺省扩展名', () => {
    assert.equal(fns.extFallback('video'), 'mp4');
    assert.equal(fns.extFallback('audio'), 'mpeg');
    assert.equal(fns.extFallback('model'), 'glb');
    assert.equal(fns.extFallback('image'), 'bin');
    assert.equal(fns.extFallback(undefined), 'bin');
});

test('mediaKind: 扩展名优先，其次模式，缺省为图片', () => {
    assert.equal(fns.mediaKind('https://cdn.example.com/a.mp4', ''), 'video');
    assert.equal(fns.mediaKind('https://cdn.example.com/a.wav', ''), 'audio');
    assert.equal(fns.mediaKind('https://cdn.example.com/a.glb', ''), 'model');
    assert.equal(fns.mediaKind('https://cdn.example.com/x', 'threeD'), 'model');
    assert.equal(fns.mediaKind('https://cdn.example.com/x', 'speech'), 'audio');
    assert.equal(fns.mediaKind('https://cdn.example.com/a.png', ''), 'image');
    assert.equal(fns.mediaKind('https://cdn.example.com/x', ''), 'image');
});

test('formatBytes: 各量级显示', () => {
    assert.equal(fns.formatBytes(0), '0 B');
    assert.equal(fns.formatBytes(512), '512 B');
    assert.equal(fns.formatBytes(2048), '2.0 KB');
    assert.equal(fns.formatBytes(5 * 1024 * 1024), '5.0 MB');
    assert.equal(fns.formatBytes(3 * 1024 * 1024 * 1024), '3.00 GB');
    assert.equal(fns.formatBytes(undefined), '0 B');
});

test('sanitizeFilename: 去路径、去非法字符、限长', () => {
    assert.equal(fns.sanitizeFilename('../../etc/passwd'), 'passwd');
    assert.equal(fns.sanitizeFilename('a<b>:c|d?e*f"g.mp4'), 'a_b__c_d_e_f_g.mp4');
    assert.equal(fns.sanitizeFilename(''), 'gitee-ai-output');
    assert.ok(fns.sanitizeFilename('x'.repeat(500)).length <= 180);
});

test('shortTaskId: 长任务 ID 缩略，短 ID 原样', () => {
    const long = 'SBOMLX0YXU8SVJQXY6CNWVJ7OJAND5TK';
    const short = fns.shortTaskId(long);
    assert.ok(short.includes('…'));
    assert.ok(short.length < 14);
    assert.equal(fns.shortTaskId('ABC123'), 'ABC123');
    assert.equal(fns.shortTaskId(''), '(无 ID)');
});
