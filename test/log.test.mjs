// test/log.test.mjs —— infra/log.js（统一日志工厂）的契约回归
//
// 这一套验的是"记录形状"本身，不是业务行为：
//   ① 四档记录的形状一致（key 集合相同，只有 event/msg 的可选性不同）
//   ② detail 传给对象时**保持对象**（不被 String() 成 "[object Object]"——线上真踩过）
//   ③ debug 必须给事件名，只给 msg 要报错（否则它就退化成普通日志，失去机器可解析性）
//   ④ src 字段：默认 app，可声明 console/server，非法值报错
//   ⑤ 订阅/退订、环形缓冲、清空
// 纯 node 环境跑（无 DOM、无浏览器），所以放在 SUITES 的最前面，秒级反馈。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOG_LIMIT, LOG_LEVELS, LOG_SOURCES, clearLogs, createLogger, recent, subscribe,
} from '../src/web/infra/log.js';

/** 每条用例前后都清一次，避免互相干扰（缓冲区是模块级共享的） */
const freshLog = (tag = 'test', opts) => {
  clearLogs();
  return createLogger(tag, opts);
};

test('四档记录形状一致：必填键相同，event/msg 按级别可选', () => {
  const log = freshLog('shape');
  const records = {
    debug: log.debug('unpack.pair', { won: 'server-hit', ms: 63 }),
    info: log.info('已选中：海边黄昏'),
    warn: log.warn('该动作在当前模型不存在', { reason: 'missing' }),
    error: log.error('渲染失败', { err: 'boom' }),
  };
  // 必填键：at / level / tag / src —— 四档必须完全一致
  for (const [level, rec] of Object.entries(records)) {
    const mandatory = Object.keys(rec).filter((k) => !['event', 'msg', 'detail'].includes(k)).sort();
    assert.deepEqual(mandatory, ['at', 'level', 'src', 'tag'], `${level} 的必填键不一致`);
    assert.equal(rec.level, level);
    assert.equal(rec.tag, 'shape');
    assert.equal(rec.src, 'app');
    assert.equal(typeof rec.at, 'number');
    assert.ok(rec.at > 0);
  }
  // debug 必须有 event、没有 msg；其余三档必须有 msg
  assert.equal(records.debug.event, 'unpack.pair');
  assert.equal(records.debug.msg, undefined);
  for (const level of ['info', 'warn', 'error']) {
    assert.equal(typeof records[level].msg, 'string', `${level} 必须有 msg`);
    assert.equal(records[level].event, undefined, `${level} 不该有 event`);
  }
  // 四档的 detail 都是结构化对象
  for (const level of ['debug', 'warn', 'error']) {
    assert.equal(typeof records[level].detail, 'object', `${level} 的 detail 应保持对象`);
  }
});

test('detail 传对象时保持对象，不被字符串化', () => {
  const log = freshLog('detail');
  const payload = { a: 1, nested: { b: [1, 2, 3] } };
  const rec = log.info('带结构化 detail', payload);
  assert.equal(typeof rec.detail, 'object');
  assert.notEqual(rec.detail, '[object Object]');
  assert.deepEqual(rec.detail, payload);
  assert.equal(rec.detail.nested.b[2], 3);
  // 原始值塞进 detail 也要包成对象，保证 detail 永远是结构化形状
  const prim = log.info('detail 是原始值', 42);
  assert.deepEqual(prim.detail, { value: 42 });
  // Error 拆成可读字段（Error 的可枚举属性是空的，直接塞会丢信息）
  const err = new Error('炸了');
  const errRec = log.error('渲染失败', err);
  assert.equal(errRec.detail.name, 'Error');
  assert.equal(errRec.detail.message, '炸了');
  assert.equal(typeof errRec.detail.stack, 'string');
});

test('debug 必须给事件名（点分），只给 msg 或命名不合规都要报错', () => {
  const log = freshLog('event');
  // 两道防线，报错文案不同：
  //   ① 没给/给了空 ⇒ "必须给事件名"
  assert.throws(() => log.debug(''), /必须给事件名/);
  assert.throws(() => log.debug(undefined, { a: 1 }), /必须给事件名/);
  //   ② 给了字符串但不是点分事件名 ⇒ "应点分命名"
  //      中文人话（把 debug 当 info 用）会落到这一条——这正是防止退化的机制
  assert.throws(() => log.debug('解包命中缓存'), /点分命名/);
  assert.throws(() => log.debug('unpackpair'), /点分命名/);
  // 合规的点分事件名可用
  clearLogs();
  const ok = log.debug('unpack.warmup', { skipped: true });
  assert.equal(ok.event, 'unpack.warmup');
});

test('src 字段：默认 app，可声明 console/server，非法值报错', () => {
  assert.deepEqual(LOG_SOURCES, ['app', 'console', 'server']);
  const app = createLogger('a').info('默认来源');
  assert.equal(app.src, 'app');
  const consoleLog = createLogger('c', { src: 'console' }).info('来自 console 镜像');
  assert.equal(consoleLog.src, 'console');
  const serverLog = createLogger('s', { src: 'server' }).debug('server.diag', { n: 1 });
  assert.equal(serverLog.src, 'server');
  assert.throws(() => createLogger('x', { src: 'nope' }), /src 必须是/);
  assert.throws(() => createLogger(''), /tag 必须是非空字符串/);
});

test('级别集合固定为四档且顺序稳定（面板按此排序）', () => {
  assert.deepEqual(LOG_LEVELS, ['debug', 'info', 'warn', 'error']);
});

test('订阅收到记录、退订后不再收到；订阅者抛错不影响写入', () => {
  const log = freshLog('sink');
  const got = [];
  const off = subscribe((r) => got.push(r.level));
  log.info('一');
  log.warn('二');
  assert.deepEqual(got, ['info', 'warn']);
  off();
  log.error('三');
  assert.deepEqual(got, ['info', 'warn']);   // 退订后不再追加
  // 坏订阅者不能把日志通路带崩
  const offBad = subscribe(() => { throw new Error('消费方崩了'); });
  assert.doesNotThrow(() => log.info('四'));
  offBad();
  assert.equal(recent(1)[0].msg, '四');
});

test('环形缓冲：recent(n) 取最近的 n 条，超出上限自动丢最旧的', () => {
  const log = freshLog('ring');
  for (let i = 0; i < 5; i += 1) log.info(`第 ${i} 条`);
  assert.equal(recent().length, 5);
  assert.deepEqual(recent(2).map((r) => r.msg), ['第 3 条', '第 4 条']);
  assert.deepEqual(recent(0), []);
  // 上限：灌满后长度不超过 LOG_LIMIT，且保留的是最新的
  clearLogs();
  for (let i = 0; i < LOG_LIMIT + 10; i += 1) log.debug('ring.tick', { i });
  const all = recent();
  assert.equal(all.length, LOG_LIMIT);
  assert.equal(all[all.length - 1].detail.i, LOG_LIMIT + 9);
  // recent 返回的是拷贝：外部改动不影响内部缓冲
  all.length = 0;
  assert.equal(recent().length, LOG_LIMIT);
});

test('清空只清记录，不影响后续写入', () => {
  const log = freshLog('clear');
  log.info('a');
  clearLogs();
  assert.equal(recent().length, 0);
  log.info('b');
  assert.deepEqual(recent().map((r) => r.msg), ['b']);
});
