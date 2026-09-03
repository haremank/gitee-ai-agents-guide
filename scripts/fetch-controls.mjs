// 从 Gitee AI 官方端点抓取参数元数据，聚合成 build-controls-schema.mjs 需要的 grouped JSON，
// 打通「抓取 → 压缩 → assets/gitee-serverless-controls.compact.json」的数据管线（此前源数据只存在于本机 TEMP）。
//
// 用法：
//   GITEE_AI_TOKEN=<令牌> node scripts/fetch-controls.mjs [输出路径] [--raw]
//   --raw 会把三个端点的原始响应存到 <输出目录>/raw/ 下，便于核对字段命名。
//
// ⚠️ operations 接口（/api/pay/service/operations）的字段命名以实际响应为准：
//    首次运行建议加 --raw，核对 normalize* 两个函数里的字段假设后再正式产出。
//    令牌获取：https://ai.gitee.com/serverless-api （不要把令牌写入任何文件或脚本）
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://ai.gitee.com';
const token = process.env.GITEE_AI_TOKEN;
if (!token) {
    console.error('缺少环境变量 GITEE_AI_TOKEN。请 export GITEE_AI_TOKEN=<你的令牌> 后重试。');
    process.exit(1);
}

const rawMode = process.argv.includes('--raw');
const output = process.argv.slice(2).filter(a => a !== '--raw')[0] || 'grouped.json';
const rawDir = path.join(path.dirname(path.resolve(output)), 'raw');

async function api(endpoint) {
    const res = await fetch(BASE + endpoint, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GET ${endpoint} -> HTTP ${res.status}`);
    return res.json();
}

function pick(obj, ...keys) {
    for (const key of keys) {
        if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
    }
    return undefined;
}

// /v1/models → 模型 ID 列表（OpenAI 风格 {data:[{id}]} 或裸数组，两种都兼容）
function extractModelIds(payload) {
    const list = Array.isArray(payload) ? payload : pick(payload, 'data') || [];
    return list.map(item => (typeof item === 'string' ? item : pick(item, 'id', 'model', 'name')))
        .filter(Boolean);
}

// 单个模型的 operations 响应 → { path → Map<paramKey, parameter> }，parameter 含 model_constraints
function normalizeOperations(model, payload) {
    const operations = Array.isArray(payload) ? payload : pick(payload, 'operations', 'data') || [];
    const byPath = new Map();
    for (const op of operations) {
        const opPath = pick(op, 'path', 'endpoint') || '';
        if (!opPath) continue;
        const operationId = pick(op, 'id', 'operation_id') || '';
        const operationName = pick(op, 'name', 'operation_name', 'summary') || '';
        const apiFormat = pick(op, 'api_format', 'format') || '';
        const price = pick(op, 'price');
        const freeUse = pick(op, 'free_use', 'free') === true;
        const status = pick(op, 'status') || '';
        if (!byPath.has(opPath)) byPath.set(opPath, new Map());
        const params = byPath.get(opPath);

        for (const raw of pick(op, 'params', 'parameters') || []) {
            const param = pick(raw, 'param', 'name') || '';
            if (!param) continue;
            const location = pick(raw, 'location', 'in') || 'body';
            const type = pick(raw, 'type') || '';
            const key = `${param}\u0000${location}`;
            let parameter = params.get(key);
            if (!parameter) {
                parameter = {
                    param,
                    location,
                    type,
                    required_any: false,
                    controls: [],
                    descriptions: [],
                    defaults: {},
                    ranges: [],
                    options: [],
                    model_constraints: []
                };
                params.set(key, parameter);
            }
            const description = pick(raw, 'description', 'desc');
            if (description && !parameter.descriptions.includes(description)) parameter.descriptions.push(description);
            const control = pick(raw, 'controls', 'control');
            if (control) [].concat(control).forEach(c => { if (!parameter.controls.includes(c)) parameter.controls.push(c); });
            if (pick(raw, 'required') === true) parameter.required_any = true;
            const opDefault = pick(raw, 'default');
            if (opDefault !== undefined && operationId) parameter.defaults[operationId] = opDefault;
            const range = {};
            for (const [src, dst] of [['minimum', 'min'], ['maximum', 'max'], ['step', 'step']]) {
                if (raw && raw[src] !== undefined) range[dst] = raw[src];
            }
            if (Object.keys(range).length && !parameter.ranges.some(r => JSON.stringify(r) === JSON.stringify(range))) {
                parameter.ranges.push(range);
            }
            const opOptions = pick(raw, 'options', 'enum');
            if (Array.isArray(opOptions)) opOptions.forEach(o => { if (!parameter.options.includes(o)) parameter.options.push(o); });

            parameter.model_constraints.push({
                operation_id: operationId,
                operation_name: operationName,
                model,
                api_format: apiFormat,
                price,
                free_use: freeUse,
                status,
                required: pick(raw, 'required') === true,
                default: opDefault,
                minimum: pick(raw, 'minimum', 'min'),
                maximum: pick(raw, 'maximum', 'max'),
                step: pick(raw, 'step'),
                options: Array.isArray(opOptions) ? opOptions : undefined,
                description
            });
        }
    }
    return byPath;
}

console.log('抓取模型目录…');
const modelsPayload = await api('/v1/models');
const models = extractModelIds(modelsPayload);
if (!models.length) throw new Error('未从 /v1/models 解析出任何模型 ID，请用 --raw 核对响应结构');
console.log(`共 ${models.length} 个模型`);

if (rawMode) {
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'models.json'), JSON.stringify(modelsPayload, null, 2));
    try {
        fs.writeFileSync(path.join(rawDir, 'openapi.json'), JSON.stringify(await api('/v1/json'), null, 2));
    } catch (error) {
        console.warn(`openapi.json 抓取失败（不影响主流程）：${error.message}`);
    }
}

// path → Map<paramKey, parameter>，跨模型合并
const merged = new Map();
let done = 0;
let failed = 0;
for (const model of models) {
    try {
        const payload = await api(`/api/pay/service/operations?service_ident=${encodeURIComponent(model)}`);
        if (rawMode) fs.writeFileSync(path.join(rawDir, `operations-${model.replace(/[^\w.-]+/g, '_')}.json`), JSON.stringify(payload, null, 2));
        const byPath = normalizeOperations(model, payload);
        for (const [p, params] of byPath) {
            if (!merged.has(p)) merged.set(p, new Map());
            const group = merged.get(p);
            for (const [key, parameter] of params) {
                if (!group.has(key)) { group.set(key, parameter); continue; }
                // 同一 (param, location) 跨模型合并：descriptions/controls 并集、constraints 追加
                const existing = group.get(key);
                for (const d of parameter.descriptions) if (!existing.descriptions.includes(d)) existing.descriptions.push(d);
                for (const c of parameter.controls) if (!existing.controls.includes(c)) existing.controls.push(c);
                for (const r of parameter.ranges) if (!existing.ranges.some(x => JSON.stringify(x) === JSON.stringify(r))) existing.ranges.push(r);
                for (const o of parameter.options) if (!existing.options.includes(o)) existing.options.push(o);
                existing.required_any = existing.required_any || parameter.required_any;
                Object.assign(existing.defaults, parameter.defaults);
                existing.model_constraints.push(...parameter.model_constraints);
            }
        }
    } catch (error) {
        failed += 1;
        console.warn(`模型 ${model} 抓取失败，跳过：${error.message}`);
    }
    done += 1;
    if (done % 10 === 0 || done === models.length) console.log(`进度 ${done}/${models.length}（失败 ${failed}）`);
}

const groups = [...merged.entries()].map(([p, params]) => ({ path: p, params: [...params.values()] }));
fs.writeFileSync(output, JSON.stringify(groups, null, 2));
console.log(`已写出 ${output}：${groups.length} 个端点路径，${groups.reduce((n, g) => n + g.params.length, 0)} 个参数`);
console.log('下一步：node scripts/build-controls-schema.mjs ' + output);
