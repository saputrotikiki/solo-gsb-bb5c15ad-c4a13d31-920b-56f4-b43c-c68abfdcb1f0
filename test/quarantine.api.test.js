'use strict';

// 端到端：真实 HTTP 服务（临时 SQLite）验证玻璃原片瑕疵隔离：
// - 隔离只能划出未预留且未隔离的自由实物；解除不得超过隔离余额；实物库存不变；
// - 新裁片订单/整套单的可用量与确认守界扣除隔离量；
// - 已确认订单仍可按原预留领料；手工调库、盘点守住 实物 ≥ 净预留 + 隔离；
// - 未知颜色/非法数量/余额不足整次不生效；同号同内容幂等、异内容冲突；
// - 不可变隔离记录与台账流水原子写入；余额/历史接口可查。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39281';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `quarantine-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

let server;
let designId, pubId;
let redId, greenId, blueId, whiteId;

async function getSheet(id) {
  return (await api('GET', `/api/glass-sheets/${id}`)).data.sheet;
}

async function register(color, stock) {
  // 25×25 原片：一片 20×20 后无法再放第二片（无论旋转），保证 copies=N 时每色用 N 张
  const r = await api('POST', '/api/glass-sheets',
    { color, width: 25, height: 25, stock });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  return r.data.sheet.id;
}

async function quarantine(body) {
  return api('POST', '/api/glass-quarantines', body);
}

// 一窗四片各一色，每色 100×100 原片每色一件 1 张
async function makeDesignAndPublish() {
  const d = await api('POST', '/api/designs', { name: '隔离测试窗', width: 40, height: 40 });
  const id = d.data.design.id;
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffffff'];
  const rects = [
    [[0, 0], [20, 0], [20, 20], [0, 20]],
    [[20, 0], [40, 0], [40, 20], [20, 20]],
    [[0, 20], [20, 20], [20, 40], [0, 40]],
    [[20, 20], [40, 20], [40, 40], [20, 40]],
  ];
  for (let i = 0; i < 4; i += 1) {
    await api('POST', `/api/designs/${id}/pieces`, { color: colors[i], polygon: rects[i] });
  }
  const p = await api('POST', `/api/designs/${id}/publish`);
  return { id, pubId: p.data.publication.id };
}

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i += 1) {
    try { await api('GET', '/api/glass-sheets'); break; } catch { await sleep(50); }
  }
  ({ id: designId, pubId } = await makeDesignAndPublish());
  redId = await register('#ff0000', 10);
  greenId = await register('#00ff00', 8);
  blueId = await register('#0000ff', 5);
  whiteId = await register('#ffffff', 20);
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

test('校验：操作号/原因/数量/颜色/重复色非法时整次不生效', async () => {
  // 缺操作号
  let r = await quarantine({ action: 'quarantine', reason: '划痕', items: [{ color: '#ff0000', count: 1 }] });
  assert.strictEqual(r.status, 400);
  // action 非法
  r = await quarantine({ opNo: 'Q-BAD-1', action: 'hold', reason: '划痕', items: [{ color: '#ff0000', count: 1 }] });
  assert.strictEqual(r.status, 400);
  // 原因空
  r = await quarantine({ opNo: 'Q-BAD-2', action: 'quarantine', reason: '   ', items: [{ color: '#ff0000', count: 1 }] });
  assert.strictEqual(r.status, 400);
  // 数量 0 / 负数 / 小数
  for (const count of [0, -1, 1.5]) {
    r = await quarantine({ opNo: `Q-BAD-${count}`, action: 'quarantine', reason: 'x', items: [{ color: '#ff0000', count }] });
    assert.strictEqual(r.status, 400, `count=${count}`);
  }
  // 空 items
  r = await quarantine({ opNo: 'Q-BAD-3', action: 'quarantine', reason: 'x', items: [] });
  assert.strictEqual(r.status, 400);
  // 未知颜色（按 color）
  r = await quarantine({ opNo: 'Q-BAD-4', action: 'quarantine', reason: 'x', items: [{ color: '#123456', count: 1 }] });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.data.code, 'unknown_color');
  // 未知颜色（按 sheetId）
  r = await quarantine({ opNo: 'Q-BAD-5', action: 'quarantine', reason: 'x', items: [{ sheetId: 999999, count: 1 }] });
  assert.strictEqual(r.status, 404);
  // 同色重复
  r = await quarantine({
    opNo: 'Q-BAD-6', action: 'quarantine', reason: 'x',
    items: [{ color: '#ff0000', count: 1 }, { sheetId: redId, count: 1 }],
  });
  assert.strictEqual(r.status, 400);
  // 非法请求未落任何记录
  const hist = await api('GET', '/api/glass-quarantines');
  assert.strictEqual(hist.data.quarantines.length, 0);
});

test('隔离划出：多色一次原子生效；实物库存不变，可用量按隔离量扣除', async () => {
  const before = await getSheet(redId);
  assert.strictEqual(before.stock, 10);
  assert.strictEqual(before.available, 10);
  assert.strictEqual(before.quarantined, 0);

  const r = await quarantine({
    opNo: 'Q-001', action: 'quarantine', reason: '第 1 箱表面划痕',
    items: [{ color: '#FF0000', count: 3 }, { sheetId: greenId, count: 2 }],
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.idempotent, false);
  assert.strictEqual(r.data.quarantine.opNo, 'Q-001');
  assert.deepStrictEqual(
    r.data.quarantine.items.map((i) => [i.color, i.delta, i.balance]),
    [['#ff0000', 3, 3], ['#00ff00', 2, 2]],
  );

  const red = await getSheet(redId);
  assert.strictEqual(red.stock, 10, '实物库存不因隔离变化');
  assert.strictEqual(red.quarantined, 3);
  assert.strictEqual(red.reserved, 0);
  assert.strictEqual(red.available, 7, '实际可用量须扣除隔离量');

  const green = await getSheet(greenId);
  assert.strictEqual(green.stock, 8);
  assert.strictEqual(green.quarantined, 2);
  assert.strictEqual(green.available, 6);

  // 余额接口
  const bal = await api('GET', '/api/glass-quarantines/balances');
  const redBal = bal.data.balances.find((b) => b.color === '#ff0000');
  assert.strictEqual(redBal.stock, 10);
  assert.strictEqual(redBal.reserved, 0);
  assert.strictEqual(redBal.quarantined, 3);
  assert.strictEqual(redBal.available, 7);
});

test('隔离上限：只能划出未预留且未隔离的自由实物；任一颜色不足整次不生效', async () => {
  // 红当前自由 7，请求 8 → 整次失败（连带绿也不动）
  const r = await quarantine({
    opNo: 'Q-002', action: 'quarantine', reason: '再次划痕',
    items: [{ color: '#ff0000', count: 8 }, { color: '#00ff00', count: 1 }],
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.code, 'quarantine_shortage');
  const redProblem = r.data.problems.find((p) => p.color === '#ff0000');
  assert.strictEqual(redProblem.available, 7);
  assert.strictEqual(redProblem.shortage, 1);
  // 整次不生效：余额未变
  const red = await getSheet(redId);
  const green = await getSheet(greenId);
  assert.strictEqual(red.quarantined, 3);
  assert.strictEqual(green.quarantined, 2);

  // 7 张刚好成功（红色全部自由实物都隔离）
  const ok = await quarantine({
    opNo: 'Q-003', action: 'quarantine', reason: '全部剩余划出',
    items: [{ color: '#ff0000', count: 7 }],
  });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.data));
  const red2 = await getSheet(redId);
  assert.strictEqual(red2.quarantined, 10);
  assert.strictEqual(red2.available, 0);
  // 再隔离 1 张失败
  const again = await quarantine({
    opNo: 'Q-004', action: 'quarantine', reason: 'x', items: [{ color: '#ff0000', count: 1 }],
  });
  assert.strictEqual(again.status, 409);
});

test('幂等与冲突：同号同内容返回原记录，异内容 409', async () => {
  // 同号同内容重试（color/sheetId 混用也算同内容；原因原样返回）
  const r1 = await quarantine({
    opNo: 'Q-001', action: 'quarantine', reason: '第 1 箱表面划痕',
    items: [{ color: '#FF0000', count: 3 }, { sheetId: greenId, count: 2 }],
  });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.data.idempotent, true);
  assert.strictEqual(r1.data.quarantine.id, 1);

  // 同号不同 action
  const r2 = await quarantine({
    opNo: 'Q-001', action: 'release', reason: '第 1 箱表面划痕',
    items: [{ color: '#ff0000', count: 3 }, { sheetId: greenId, count: 2 }],
  });
  assert.strictEqual(r2.status, 409);
  assert.strictEqual(r2.data.code, 'op_no_conflict');

  // 同号不同数量
  const r3 = await quarantine({
    opNo: 'Q-001', action: 'quarantine', reason: '第 1 箱表面划痕',
    items: [{ color: '#ff0000', count: 2 }, { sheetId: greenId, count: 2 }],
  });
  assert.strictEqual(r3.status, 409);
  assert.strictEqual(r3.data.code, 'op_no_conflict');

  // 冲突/幂等都不改变余额
  const red = await getSheet(redId);
  const green = await getSheet(greenId);
  assert.strictEqual(red.quarantined, 10);
  assert.strictEqual(green.quarantined, 2);

  // GET 按操作号取原记录
  const got = await api('GET', '/api/glass-quarantines/Q-001');
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.data.quarantine.reason, '第 1 箱表面划痕');
});

test('解除隔离：不得超过隔离余额；解除后实物仍不变、可用回升', async () => {
  // 解除超过余额（绿余额 2，解 3）整次失败
  const bad = await quarantine({
    opNo: 'Q-REL-1', action: 'release', reason: '误判，复检合格',
    items: [{ color: '#00ff00', count: 3 }],
  });
  assert.strictEqual(bad.status, 409);
  assert.strictEqual(bad.data.code, 'quarantine_shortage');

  // 红解除 4（余额 10），绿解除 2（余额 2）→ 原子成功
  const ok = await quarantine({
    opNo: 'Q-REL-2', action: 'release', reason: '复检合格回库',
    items: [{ color: '#ff0000', count: 4 }, { color: '#00ff00', count: 2 }],
  });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.data));
  assert.deepStrictEqual(
    ok.data.quarantine.items.map((i) => [i.color, i.delta, i.balance]),
    [['#ff0000', -4, 6], ['#00ff00', -2, 0]],
  );
  const red = await getSheet(redId);
  assert.strictEqual(red.stock, 10);
  assert.strictEqual(red.quarantined, 6);
  assert.strictEqual(red.available, 4);
  const green = await getSheet(greenId);
  assert.strictEqual(green.stock, 8);
  assert.strictEqual(green.quarantined, 0);
  assert.strictEqual(green.available, 8);
});

test('新裁片订单：预览缺口扣除隔离量；确认守住可用量', async () => {
  // 红：stock10 隔离6 可用4；一件用 1 张。先确认 4 张预留（copies=4）
  const pv = await api('POST', '/api/cut-orders/preview', { publicationId: pubId, copies: 4, gap: 0 });
  const redColor = pv.data.preview.colors.find((c) => c.color === '#ff0000');
  assert.strictEqual(redColor.stock, 10);
  assert.strictEqual(redColor.quarantined, 6);
  assert.strictEqual(redColor.reserved, 0);
  assert.strictEqual(redColor.available, 4);
  assert.strictEqual(redColor.requiredSheets, 4);
  assert.strictEqual(redColor.shortage, 0);

  const create = await api('POST', '/api/cut-orders', { publicationId: pubId, copies: 4, gap: 0, name: '隔离占4红' });
  assert.strictEqual(create.status, 201, JSON.stringify(create.data));
  const orderId = create.data.order.id;
  const cf = await api('POST', `/api/cut-orders/${orderId}/confirm`);
  assert.strictEqual(cf.status, 200, JSON.stringify(cf.data));

  // 此时红：stock10 = 净预留4 + 隔离6，自由 0；再确认 1 张必失败
  const create2 = await api('POST', '/api/cut-orders', { publicationId: pubId, copies: 1, gap: 0, name: '再要1红' });
  const cf2 = await api('POST', `/api/cut-orders/${create2.data.order.id}/confirm`);
  assert.strictEqual(cf2.status, 409);
  assert.strictEqual(cf2.data.code, 'shortage');
  const short = cf2.data.shortages.find((s) => s.color === '#ff0000');
  assert.strictEqual(short.available, 0);
  assert.strictEqual(short.reserved, 4);
  assert.strictEqual(short.quarantined, 6);
});

test('已确认单据仍可按原预留领料（隔离不阻止预留内发货）', async () => {
  const order = (await api('GET', '/api/cut-orders')).data.orders.find((o) => o.name === '隔离占4红');
  assert.ok(order);
  const issue = await api('POST', `/api/cut-orders/${order.id}/issues`, {
    issueNo: 'ISS-Q-1',
    sheets: [{ color: '#ff0000', count: 4 }],
  });
  assert.strictEqual(issue.status, 201, JSON.stringify(issue.data));
  const red = await getSheet(redId);
  assert.strictEqual(red.stock, 6, '领料出库后实物 10-4=6');
  assert.strictEqual(red.reserved, 0, '净预留随领料核减');
  assert.strictEqual(red.quarantined, 6, '隔离量不随领料变化');
  assert.strictEqual(red.available, 0);
  // 库存恒等式：stock(6) = 净预留(0) + 隔离(6)
});

test('手工调库守住 实物 ≥ 净预留 + 隔离', async () => {
  // 红 stock=6 隔离=6；调到 5 应被拒
  const r = await api('PATCH', `/api/glass-sheets/${redId}`, { stock: 5 });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.floor, 6);
  // 白色：copies=4 订单预留 4；stock20，净预留4，自由16。先隔离 7，再调到 10 应被拒（需 ≥11）
  const w0 = await getSheet(whiteId);
  assert.strictEqual(w0.reserved, 4);
  const q = await quarantine({ opNo: 'Q-WHITE-1', action: 'quarantine', reason: '白瑕疵', items: [{ color: '#ffffff', count: 7 }] });
  assert.strictEqual(q.status, 201, JSON.stringify(q.data));
  const bad = await api('PATCH', `/api/glass-sheets/${whiteId}`, { stock: 10 });
  assert.strictEqual(bad.status, 409);
  assert.strictEqual(bad.data.reserved, 4);
  assert.strictEqual(bad.data.quarantined, 7);
  // 调到 11 允许（= 4 + 7），实际可用量为 0
  const ok = await api('PATCH', `/api/glass-sheets/${whiteId}`, { stock: 11 });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.data.sheet.available, 0);
  // 解除 3 后可用回升为 3（实物仍 11）
  const rel = await quarantine({ opNo: 'Q-WHITE-REL', action: 'release', reason: '白复检', items: [{ color: '#ffffff', count: 3 }] });
  assert.strictEqual(rel.status, 201, JSON.stringify(rel.data));
  const w2 = await getSheet(whiteId);
  assert.strictEqual(w2.stock, 11);
  assert.strictEqual(w2.quarantined, 4);
  assert.strictEqual(w2.reserved, 4);
  assert.strictEqual(w2.available, 3);
});

test('盘点确认：实盘数低于 净预留 + 隔离 时整单不生效', async () => {
  // 绿：stock8 = 净预留4（copies=4 订单）+ 自由4。先隔离 3
  await quarantine({ opNo: 'Q-GREEN-1', action: 'quarantine', reason: '绿瑕疵', items: [{ color: '#00ff00', count: 3 }] });
  const greenLive = await getSheet(greenId);
  assert.strictEqual(greenLive.reserved, 4);
  assert.strictEqual(greenLive.quarantined, 3);
  // 盘点预览：绿实盘 6（< 4+3=7）
  const pv = await api('POST', '/api/stocktakes/preview', {
    name: '隔离期盘点',
    items: [{ type: 'glass', specId: greenId, counted: 6 }],
  });
  assert.strictEqual(pv.status, 201);
  const stId = pv.data.stocktake.id;
  const cf = await api('POST', `/api/stocktakes/${stId}/confirm`);
  assert.strictEqual(cf.status, 409);
  assert.strictEqual(cf.data.code, 'baseline_mismatch');
  const item = cf.data.items[0];
  assert.strictEqual(item.reason, 'below_reserved');
  assert.strictEqual(item.currentReserved, 4);
  assert.strictEqual(item.currentQuarantined, 3);
  // 库存未改
  const green = await getSheet(greenId);
  assert.strictEqual(green.stock, 8);

  // 实盘 7（= 净预留 4 + 隔离 3）可以确认
  const pv2 = await api('POST', '/api/stocktakes/preview', {
    name: '隔离期盘点2',
    items: [{ type: 'glass', specId: greenId, counted: 7 }],
  });
  const cf2 = await api('POST', `/api/stocktakes/${pv2.data.stocktake.id}/confirm`);
  assert.strictEqual(cf2.status, 200, JSON.stringify(cf2.data));
  const green2 = await getSheet(greenId);
  assert.strictEqual(green2.stock, 7);
  assert.strictEqual(green2.quarantined, 3);
  assert.strictEqual(green2.reserved, 4);
  assert.strictEqual(green2.available, 0);
});

test('台账：隔离/解除逐笔记隔离增减与笔后余额，实物与净预留列不变', async () => {
  const led = await api('GET', `/api/ledger?type=glass&specId=${greenId}`);
  assert.strictEqual(led.status, 200);
  const types = led.data.ledger.entries.map((e) => e.eventType);
  assert.ok(types.includes('quarantine'));
  const qrow = led.data.ledger.entries.filter((e) => e.eventType === 'quarantine').pop();
  assert.strictEqual(qrow.deltaStock, 0);
  assert.strictEqual(qrow.deltaReserved, 0);
  assert.strictEqual(qrow.deltaQuarantined, 3);
  // 隔离台账之后又有盘点流水（stock 8→3），故只在隔离笔本身断言笔后实物为 8
  const stockAtQuarantine = qrow.balanceStock;
  assert.strictEqual(stockAtQuarantine, 8, '隔离时实物库存仍为 8');
  assert.strictEqual(qrow.balanceQuarantined, 3, '隔离笔后隔离余额为 3');
  const last = led.data.ledger.entries[led.data.ledger.entries.length - 1];
  assert.strictEqual(last.balanceStock, 7, '盘点后末笔实物为 7');
  assert.strictEqual(last.balanceQuarantined, 3);
  assert.strictEqual(led.data.ledger.current.quarantined, 3);
  assert.strictEqual(led.data.ledger.current.reserved, 4);
  assert.strictEqual(led.data.ledger.current.available, 0);
});

test('历史接口：按颜色与时间过滤；记录不可变', async () => {
  const all = await api('GET', '/api/glass-quarantines');
  assert.ok(all.data.quarantines.length >= 6);
  // 最新在前
  assert.ok(all.data.quarantines[0].createdAt >= all.data.quarantines[1].createdAt);

  const onlyGreen = await api('GET', '/api/glass-quarantines?color=%2300ff00');
  assert.strictEqual(onlyGreen.status, 200);
  assert.ok(onlyGreen.data.quarantines.length >= 1);
  for (const op of onlyGreen.data.quarantines) {
    // 按颜色过滤返回“包含该颜色”的操作（多色操作一并出现），但每笔都必须含绿色
    assert.ok(op.items.some((i) => i.color === '#00ff00'));
  }

  const onlyGreen2 = await api('GET', `/api/glass-quarantines?sheetId=${greenId}`);
  assert.strictEqual(onlyGreen2.data.quarantines.length, onlyGreen.data.quarantines.length);

  const today = new Date().toISOString().slice(0, 10);
  const ranged = await api('GET', `/api/glass-quarantines?from=${today}&to=${today}`);
  assert.strictEqual(ranged.status, 200);
  assert.strictEqual(ranged.data.quarantines.length, all.data.quarantines.length, '全部记录均发生在今天');

  const badRange = await api('GET', '/api/glass-quarantines?from=2099-01-01&to=2000-01-01');
  assert.strictEqual(badRange.status, 400);

  // 未知操作号 404
  const missing = await api('GET', '/api/glass-quarantines/NOPE');
  assert.strictEqual(missing.status, 404);

  // 直查 DB：无更新/删除路径，记录行数只增；同号重试行数不变
  const d = db.getDb();
  const opsBefore = d.prepare('SELECT COUNT(*) n FROM glass_quarantine_ops').get().n;
  const itemsBefore = d.prepare('SELECT COUNT(*) n FROM glass_quarantine_items').get().n;
  await quarantine({
    opNo: 'Q-REL-2', action: 'release', reason: '复检合格回库',
    items: [{ color: '#ff0000', count: 4 }, { color: '#00ff00', count: 2 }],
  });
  assert.strictEqual(d.prepare('SELECT COUNT(*) n FROM glass_quarantine_ops').get().n, opsBefore);
  assert.strictEqual(d.prepare('SELECT COUNT(*) n FROM glass_quarantine_items').get().n, itemsBefore);
});

test('整套单：玻璃可用量扣隔离；确认守界（铅条无关）', async () => {
  // 蓝：stock5 = 净预留4（copies=4 订单）+ 自由1。把最后 1 张隔离 → 可用 0
  const mat = await api('POST', '/api/materials', { name: '6m 隔离测试铅条', length: 6000, stock: 50 });
  const materialId = mat.data.material.id;
  const q = await quarantine({ opNo: 'Q-BLUE-1', action: 'quarantine', reason: '蓝最后一张瑕疵', items: [{ color: '#0000ff', count: 1 }] });
  assert.strictEqual(q.status, 201, JSON.stringify(q.data));
  const blue = await getSheet(blueId);
  assert.strictEqual(blue.stock, 5);
  assert.strictEqual(blue.reserved, 4);
  assert.strictEqual(blue.quarantined, 1);
  assert.strictEqual(blue.available, 0);
  const pv = await api('POST', '/api/combo-orders/preview', {
    publicationId: pubId, copies: 1, kerf: 0.5, gap: 0, materialId,
  });
  assert.strictEqual(pv.status, 200, JSON.stringify(pv.data));
  const blueColor = pv.data.preview.glass.colors.find((c) => c.color === '#0000ff');
  assert.strictEqual(blueColor.requiredSheets, 1);
  assert.strictEqual(blueColor.available, 0);
  assert.strictEqual(blueColor.shortage, 1);
  assert.strictEqual(pv.data.preview.feasible, false);
  // 确认整单失败回滚
  const cf = await api('POST', '/api/combo-orders', {
    publicationId: pubId, copies: 1, kerf: 0.5, gap: 0, materialId, requestId: 'COMBO-Q-1',
  });
  assert.strictEqual(cf.status, 409);
  assert.strictEqual(cf.data.code, 'shortage');
  assert.ok(cf.data.shortages.some((s) => s.color === '#0000ff'));
  // 解除蓝隔离 1、红隔离 1 后四色均至少可用 1 张，可确认整套单
  const rel = await quarantine({
    opNo: 'Q-COMBO-REL', action: 'release', reason: '复检合格回库备料',
    items: [{ color: '#0000ff', count: 1 }, { color: '#ff0000', count: 1 }],
  });
  assert.strictEqual(rel.status, 201, JSON.stringify(rel.data));
  // 绿经盘点 stock7、净预留4、隔离3 也无自由，释放 1；白 stock11、净预留4、隔离4 可用3 无需处理
  const relG = await quarantine({ opNo: 'Q-COMBO-REL-G', action: 'release', reason: '绿复检合格', items: [{ color: '#00ff00', count: 1 }] });
  assert.strictEqual(relG.status, 201, JSON.stringify(relG.data));
  const cf2 = await api('POST', '/api/combo-orders', {
    publicationId: pubId, copies: 1, kerf: 0.5, gap: 0, materialId, requestId: 'COMBO-Q-2',
  });
  assert.strictEqual(cf2.status, 201, JSON.stringify(cf2.data));
  // 同 requestId 重试幂等
  const again = await api('POST', '/api/combo-orders', {
    publicationId: pubId, copies: 1, kerf: 0.5, gap: 0, materialId, requestId: 'COMBO-Q-2',
  });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.data.idempotent, true);
});

test('并发隔离：BEGIN IMMEDIATE 串行化，合计不超过自由实物，失败方整次不生效', async () => {
  // 用一个设计中不存在的新颜色（不参与任何订单）：stock5 无预留无隔离；两个请求各隔离 4
  const cid = (await api('POST', '/api/glass-sheets', { color: '#c0c0c0', width: 100, height: 100, stock: 5 })).data.sheet.id;
  const body = (opNo) => JSON.stringify({
    opNo, action: 'quarantine', reason: '并发竞争测试',
    items: [{ sheetId: cid, count: 4 }],
  });
  const [a, b] = await Promise.all([
    fetch(`${BASE}/api/glass-quarantines`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body('Q-CONC-1'),
    }).then(async (r) => ({ status: r.status, data: await r.json() })),
    fetch(`${BASE}/api/glass-quarantines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body('Q-CONC-2'),
    }).then(async (r) => ({ status: r.status, data: await r.json() })),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepStrictEqual(statuses, [201, 409], `应为一成一败：${JSON.stringify([a.status, b.status])}`);
  const winner = a.status === 201 ? a.data : b.data;
  const loser = a.status === 409 ? a.data : b.data;
  assert.strictEqual(winner.quarantine.items[0].balance, 4);
  assert.strictEqual(loser.code, 'quarantine_shortage');
  const s = await getSheet(cid);
  assert.strictEqual(s.stock, 5, '实物库存不变');
  assert.strictEqual(s.quarantined, 4, '只划出 4 张，失败方未生效');
  assert.strictEqual(s.available, 1);
});
