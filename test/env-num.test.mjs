// test/env-num.test.mjs —— 数值型 env 的统一读取（非法值必须回落 + 告警）
//
// 为什么要锁：这些 env 是"准入/探测"的门槛。一旦某处把 NaN 直接传下去，
//   比较表达式会恒为 false（不报错），表现为"门槛悄悄失效"—— 比抛错难查得多。
//   所以这里钉住三件事：合法值直通、缺省静默回落、非法值回落且**告警一条**。
import test from 'node:test';
import assert from 'node:assert/strict';

import { readNumericEnv, readRatioEnv, resetEnvWarnings } from '../src/server/core/env-num.mjs';

/** 临时设一个 env，返回还原函数 */
function withEnv(name, value) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  };
}

test('比例 env：合法值直通（含边界 1）', () => {
  resetEnvWarnings();
  const logs = [];
  const log = (level, msg) => logs.push({ level, msg });
  let restore = withEnv('MODELSTAGE_TEST_RATIO', '0.7');
  try {
    assert.equal(readRatioEnv('MODELSTAGE_TEST_RATIO', 0.85, log), 0.7);
    process.env.MODELSTAGE_TEST_RATIO = '1';
    assert.equal(readRatioEnv('MODELSTAGE_TEST_RATIO', 0.85, log), 1, '1 是合法上界');
    assert.equal(logs.length, 0, '合法值不该产生日志');
  } finally { restore(); }
});

test('比例 env：缺省（未设/空串）静默回落，不告警', () => {
  resetEnvWarnings();
  const logs = [];
  const log = (level, msg) => logs.push({ level, msg });
  let restore = withEnv('MODELSTAGE_TEST_RATIO2', undefined);
  try {
    assert.equal(readRatioEnv('MODELSTAGE_TEST_RATIO2', 0.85, log), 0.85);
    process.env.MODELSTAGE_TEST_RATIO2 = '   ';
    assert.equal(readRatioEnv('MODELSTAGE_TEST_RATIO2', 0.85, log), 0.85);
    assert.equal(logs.length, 0, '未设/空白属正常部署形态，不该刷告警');
  } finally { restore(); }
});

test('比例 env：非法值（abc / 0 / 2 / 负数）⇒ 回落缺省 + warn 一条', () => {
  resetEnvWarnings();
  const logs = [];
  const log = (level, msg, detail) => logs.push({ level, msg, detail });
  const restore = withEnv('MODELSTAGE_TEST_RATIO3', 'abc');
  try {
    for (const bad of ['abc', '0', '2', '-0.3']) {
      process.env.MODELSTAGE_TEST_RATIO3 = bad;
      assert.equal(readRatioEnv('MODELSTAGE_TEST_RATIO3', 0.85, log), 0.85, `${bad} 必须回落缺省`);
    }
    assert.equal(logs.length, 1, '同一个变量只告警一次（去重，避免每请求刷屏）');
    assert.equal(logs[0].level, 'warn');
    assert.match(logs[0].msg, /MODELSTAGE_TEST_RATIO3/);
    assert.match(logs[0].msg, /0\.85/, '告警里要写明回落成了多少');
  } finally { restore(); }
});

test('数值 env：非负直通；负数/NaN 回落缺省 + warn', () => {
  resetEnvWarnings();
  const logs = [];
  const log = (level, msg) => logs.push({ level, msg });
  const restore = withEnv('MODELSTAGE_TEST_NUM', '24');
  try {
    assert.equal(readNumericEnv('MODELSTAGE_TEST_NUM', 8, log), 24);
    process.env.MODELSTAGE_TEST_NUM = '-1';
    assert.equal(readNumericEnv('MODELSTAGE_TEST_NUM', 8, log), 8);
    process.env.MODELSTAGE_TEST_NUM = 'not-a-number';
    assert.equal(readNumericEnv('MODELSTAGE_TEST_NUM', 8, log), 8);
    assert.equal(logs.length, 1, '同一变量只告警一次');
  } finally { restore(); }
});
