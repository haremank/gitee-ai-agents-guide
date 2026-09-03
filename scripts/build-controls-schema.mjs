// 把 Gitee AI 抓取的 grouped 参数数据压缩为 assets/gitee-serverless-controls.compact.json。
//
// 输入（源数据不在仓库内，需自行从平台抓取后聚合为 grouped JSON，数组每项形如）：
//   {
//     path: "/v1/images/generations",
//     params: [{
//       param, location, type, required_any, controls, descriptions, defaults, ranges, options,
//       model_constraints: [{
//         operation_id, operation_name, model, api_format, price, free_use, status,
//         required, default, minimum, maximum, step, options, description
//       }]
//     }]
//   }
// 数据来源：
//   GET https://ai.gitee.com/v1/models
//   GET https://ai.gitee.com/v1/json
//   GET https://ai.gitee.com/api/pay/service/operations?service_ident={model}
// 用法：node scripts/build-controls-schema.mjs [输入.json] [输出路径]
import fs from 'node:fs';
import path from 'node:path';

const input = process.argv[2] || path.join(process.env.TEMP, 'gitee-serverless-controls-grouped.json');
const output = process.argv[3] || path.join('assets', 'gitee-serverless-controls.compact.json');
const source = JSON.parse(fs.readFileSync(input, 'utf8'));

const dictionary = [];
const dictionaryIndex = new Map();

function ref(value) {
  const text = String(value ?? '');
  if (!dictionaryIndex.has(text)) {
    dictionaryIndex.set(text, dictionary.length);
    dictionary.push(text);
  }
  return dictionaryIndex.get(text);
}

function jsonRef(value) {
  return value === undefined || value === null ? -1 : ref(JSON.stringify(value));
}

function number(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const endpoints = source.map((group) => {
  const operations = new Map();
  for (const parameter of group.params) {
    for (const constraint of parameter.model_constraints) {
      const key = `${constraint.operation_id}\u0000${constraint.operation_name}\u0000${constraint.model}`;
      if (!operations.has(key)) {
        operations.set(key, {
          id: constraint.operation_id,
          name: constraint.operation_name,
          model: ref(constraint.model),
          format: ref(constraint.api_format),
          price: number(constraint.price),
          free: constraint.free_use === true,
          status: ref(constraint.status)
        });
      }
    }
  }

  const operationList = [...operations.values()];
  const operationKeys = [...operations.keys()];
  const parameters = group.params.map((parameter) => {
    const variants = {};
    operationKeys.forEach((_, index) => {
      variants[index] = null;
    });

    for (const constraint of parameter.model_constraints) {
      const key = `${constraint.operation_id}\u0000${constraint.operation_name}\u0000${constraint.model}`;
      const index = operationKeys.indexOf(key);
      if (index < 0) continue;
      const range = (constraint.minimum !== undefined || constraint.maximum !== undefined || constraint.step !== undefined) ? {
        min: number(constraint.minimum),
        max: number(constraint.maximum),
        step: number(constraint.step)
      } : null;
      variants[index] = [
        constraint.required === true ? 1 : 0,
        constraint.default === undefined ? -1 : ref(constraint.default),
        range === null ? -1 : jsonRef(range),
        jsonRef(constraint.options || []),
        constraint.description === undefined ? -1 : ref(constraint.description)
      ];
    }

    return {
      k: ref(parameter.param),
      l: ref(parameter.location),
      t: ref(parameter.type),
      q: parameter.required_any === true ? 1 : 0,
      c: jsonRef(parameter.controls || []),
      d: ref(parameter.descriptions.join('\n')),
      f: jsonRef(parameter.defaults),
      r: jsonRef(parameter.ranges || []),
      o: jsonRef(parameter.options || []),
      v: variants
    };
  });

  return {
    p: ref(group.path),
    o: operationList,
    n: group.params.reduce((sum, parameter) => sum + parameter.model_constraints.length, 0),
    r: parameters
  };
});

const payload = {
  version: 1,
  generatedAt: new Date().toISOString().slice(0, 10),
  sources: [
    'GET https://ai.gitee.com/v1/models',
    'GET https://ai.gitee.com/v1/json',
    'GET https://ai.gitee.com/api/pay/service/operations?service_ident={model}'
  ],
  d: dictionary,
  e: endpoints
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(payload));
console.log(`endpoints=${endpoints.length} operations=${endpoints.reduce((n, item) => n + item.o.length, 0)} params=${endpoints.reduce((n, item) => n + item.r.length, 0)} bytes=${Buffer.byteLength(JSON.stringify(payload))}`);
