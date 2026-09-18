const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = path.join(__dirname, "data", "db.json");
const AMPLITUDE_DROP_THRESHOLD = 20; // 最新复测振幅较前一次下降超过20度触发预警

const STATUS_TEXT = {
  unconfirmed: "待确认",
  confirmed: "已确认",
  cleared: "已清除"
};

// 沿用既有调校/复测数据，并补充可演示三种预警状态的历史档案
const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: "2026-06-16T00:00:00.000Z"
    },
    {
      id: "clock_legacy",
      code: "CLK-1901-12",
      escapementType: "同轴擒纵",
      balanceFrequency: "28800vph",
      targetDailyRateSeconds: 15,
      note: "古董台钟机芯，历史稳定性波动较大",
      createdAt: "2026-03-02T00:00:00.000Z"
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: "2026-06-16T00:00:00.000Z"
    },
    {
      id: "adjustment_legacy_1",
      clockId: "clock_legacy",
      currentDailyRateSeconds: 52,
      direction: "快针方向",
      amount: "游丝快慢针向快侧微调0.6格",
      note: "第一轮调校",
      createdAt: "2026-03-02T08:00:00.000Z"
    },
    {
      id: "adjustment_legacy_2",
      clockId: "clock_legacy",
      currentDailyRateSeconds: 14,
      direction: "慢针方向",
      amount: "向慢侧微调0.2格",
      note: "第二轮精调",
      createdAt: "2026-03-09T02:00:00.000Z"
    },
    {
      id: "adjustment_legacy_3",
      clockId: "clock_legacy",
      currentDailyRateSeconds: 18,
      direction: "快针方向",
      amount: "向快侧微调0.15格",
      note: "振幅持续回落，重新调校并安排检查发条",
      createdAt: "2026-03-16T01:30:00.000Z"
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: "2026-06-16T00:00:00.000Z",
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    },
    {
      id: "retest_demo_2",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: "2026-06-17T03:20:00.000Z",
      dailyRateSeconds: 44,
      amplitude: 196,
      qualified: false,
      note: "振幅明显回落，疑似发条动力不足"
    },
    {
      id: "retest_legacy_1_1",
      clockId: "clock_legacy",
      adjustmentId: "adjustment_legacy_1",
      testedAt: "2026-03-03T08:00:00.000Z",
      dailyRateSeconds: 22,
      amplitude: 270,
      qualified: false,
      note: "首轮调校后，振幅充足"
    },
    {
      id: "retest_legacy_1_2",
      clockId: "clock_legacy",
      adjustmentId: "adjustment_legacy_1",
      testedAt: "2026-03-05T08:00:00.000Z",
      dailyRateSeconds: 9,
      amplitude: 235,
      qualified: true,
      note: "走时达标，但振幅回落35度"
    },
    {
      id: "retest_legacy_2_1",
      clockId: "clock_legacy",
      adjustmentId: "adjustment_legacy_2",
      testedAt: "2026-03-10T08:00:00.000Z",
      dailyRateSeconds: 5,
      amplitude: 242,
      qualified: true,
      note: "精调后复测稳定"
    },
    {
      id: "retest_legacy_2_2",
      clockId: "clock_legacy",
      adjustmentId: "adjustment_legacy_2",
      testedAt: "2026-03-12T08:00:00.000Z",
      dailyRateSeconds: 4,
      amplitude: 216,
      qualified: true,
      note: "振幅又回落26度，持续观察"
    },
    {
      id: "retest_legacy_3_1",
      clockId: "clock_legacy",
      adjustmentId: "adjustment_legacy_3",
      testedAt: "2026-03-17T08:00:00.000Z",
      dailyRateSeconds: 8,
      amplitude: 265,
      qualified: true,
      note: "清洗保养后振幅恢复"
    },
    {
      id: "retest_legacy_3_2",
      clockId: "clock_legacy",
      adjustmentId: "adjustment_legacy_3",
      testedAt: "2026-03-19T08:00:00.000Z",
      dailyRateSeconds: 6,
      amplitude: 268,
      qualified: true,
      note: "振幅保持稳定"
    }
  ],
  warnings: [
    {
      id: "warning_legacy_confirmed",
      key: "clock_legacy:retest_legacy_1_2",
      clockId: "clock_legacy",
      triggerRetestId: "retest_legacy_1_2",
      previousRetestId: "retest_legacy_1_1",
      periodAdjustmentId: "adjustment_legacy_1",
      amplitudeBefore: 270,
      amplitudeAfter: 235,
      amplitudeDrop: 35,
      createdAt: "2026-03-05T08:00:00.000Z",
      status: "confirmed",
      handledBy: "王师傅",
      confirmedAt: "2026-03-06T01:10:00.000Z",
      confirmNote: "擒纵轮检查无明显磨损，已安排清洗保养",
      periodEndsAt: null,
      endedByAdjustmentId: null
    }
  ]
};

const routes = [
  "GET /",
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests",
  "GET /warnings?status=&clockId=&q=",
  "POST /warnings/:id/confirm"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (!Array.isArray(db.warnings)) db.warnings = [];
  return db;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) {
    const error = new Error("钟表不存在");
    error.status = 404;
    throw error;
  }
  return clock;
}

function findWarning(db, warningId) {
  const warning = db.warnings.find((item) => item.id === warningId);
  if (!warning) {
    const error = new Error("预警不存在");
    error.status = 404;
    throw error;
  }
  return warning;
}

function sortedByTime(items, field) {
  return [...items].sort((a, b) => {
    const diff = new Date(a[field]) - new Date(b[field]);
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : 1;
  });
}

function latestRetest(db, clockId) {
  return sortedByTime(db.retests.filter((item) => item.clockId === clockId), "testedAt").at(-1) || null;
}

function latestAdjustment(db, clockId) {
  return sortedByTime(db.adjustments.filter((item) => item.clockId === clockId), "createdAt").at(-1) || null;
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分钟`;
  if (minutes > 0) return `${minutes}分钟`;
  return `${seconds}秒`;
}

/**
 * 预警是调校/复测数据的派生结论：
 * - 每次调校开启一个新的监测期，只在同一监测期内比较相邻两次复测；
 * - 最新复测振幅比同监测期前一次下降超过20度，生成一条“待确认”预警；
 * - 新调校写入后，上一监测期立即结束，该期预警统一转为“已清除”（确认信息保留）；
 * - 同一触发复测只对应一条预警，任何入口读到的结论一致，刷新后结论不变。
 * 返回本次对账是否发生变化（需要落盘）。
 */
function reconcileWarnings(db) {
  if (!Array.isArray(db.warnings)) db.warnings = [];
  const existing = new Map(db.warnings.map((warning) => [warning.key, warning]));
  let changed = false;

  for (const clock of db.clocks) {
    const adjustments = sortedByTime(
      db.adjustments.filter((item) => item.clockId === clock.id),
      "createdAt"
    );
    const retests = sortedByTime(
      db.retests.filter((item) => item.clockId === clock.id),
      "testedAt"
    );

    const periodStartFor = (retest) =>
      adjustments.filter((item) => new Date(item.createdAt) <= new Date(retest.testedAt)).at(-1) || null;

    let previous = null; // { id, amplitude, startId }
    for (const retest of retests) {
      const start = periodStartFor(retest);
      const startId = start ? start.id : null;
      if (!previous || previous.startId !== startId) previous = null;

      if (previous) {
        const drop = previous.amplitude - retest.amplitude;
        if (drop > AMPLITUDE_DROP_THRESHOLD) {
          const key = `${clock.id}:${retest.id}`;
          // 本期结束调校 = 起始调校之后写入的第一条调校；没有则本期仍在监测
          const ends = start
            ? adjustments.find((item) => new Date(item.createdAt) > new Date(start.createdAt)) || null
            : null;
          const periodEndsAt = ends ? ends.createdAt : null;
          const endedByAdjustmentId = ends ? ends.id : null;

          const warning = existing.get(key);
          if (!warning) {
            db.warnings.push({
              id: makeId("warning"),
              key,
              clockId: clock.id,
              triggerRetestId: retest.id,
              previousRetestId: previous.id,
              periodAdjustmentId: startId,
              amplitudeBefore: previous.amplitude,
              amplitudeAfter: retest.amplitude,
              amplitudeDrop: drop,
              createdAt: retest.testedAt,
              status: ends ? "cleared" : "unconfirmed",
              handledBy: "",
              confirmedAt: null,
              confirmNote: "",
              periodEndsAt,
              endedByAdjustmentId
            });
            existing.set(key, db.warnings.at(-1));
            changed = true;
          } else {
            const nextStatus = warning.status === "unconfirmed" && ends ? "cleared" : warning.status;
            const patch = {
              previousRetestId: previous.id,
              periodAdjustmentId: startId,
              amplitudeBefore: previous.amplitude,
              amplitudeAfter: retest.amplitude,
              amplitudeDrop: drop,
              periodEndsAt,
              endedByAdjustmentId,
              status: nextStatus
            };
            for (const [field, value] of Object.entries(patch)) {
              if (warning[field] !== value) {
                warning[field] = value;
                changed = true;
              }
            }
          }
        }
      }

      previous = { id: retest.id, amplitude: retest.amplitude, startId };
    }
  }

  return changed;
}

function warningView(db, warning, now = Date.now()) {
  const clock = db.clocks.find((item) => item.id === warning.clockId) || null;
  const triggerRetest = db.retests.find((item) => item.id === warning.triggerRetestId) || null;
  const previousRetest = db.retests.find((item) => item.id === warning.previousRetestId) || null;
  const waitingMs =
    warning.status === "unconfirmed" ? Math.max(0, now - new Date(warning.createdAt).getTime()) : null;
  return {
    id: warning.id,
    clockId: warning.clockId,
    clock: clock
      ? {
          id: clock.id,
          code: clock.code,
          escapementType: clock.escapementType,
          balanceFrequency: clock.balanceFrequency
        }
      : null,
    triggerRetestId: warning.triggerRetestId,
    previousRetestId: warning.previousRetestId,
    periodAdjustmentId: warning.periodAdjustmentId,
    endedByAdjustmentId: warning.endedByAdjustmentId,
    amplitudeBefore: warning.amplitudeBefore,
    amplitudeAfter: warning.amplitudeAfter,
    amplitudeDrop: warning.amplitudeDrop,
    createdAt: warning.createdAt,
    status: warning.status,
    statusText: STATUS_TEXT[warning.status] || warning.status,
    handledBy: warning.handledBy || "",
    confirmedAt: warning.confirmedAt,
    confirmNote: warning.confirmNote || "",
    periodEndsAt: warning.periodEndsAt,
    waitingMs,
    waitingText: waitingMs === null ? null : formatDuration(waitingMs),
    triggerRetest,
    previousRetest
  };
}

function sortWarnings(views) {
  return views.sort((a, b) => {
    const rank = (view) => (view.status === "unconfirmed" ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    // 待确认：等待越久（生成越早）越靠前；已确认/已清除：最新发生的在前
    return rank(a) === 0
      ? new Date(a.createdAt) - new Date(b.createdAt)
      : new Date(b.createdAt) - new Date(a.createdAt);
  });
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  const warnings = sortWarnings(
    db.warnings.filter((item) => item.clockId === clock.id).map((item) => warningView(db, item))
  );
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified: retest ? retest.qualified : false,
    unconfirmedWarningCount: warnings.filter((item) => item.status === "unconfirmed").length,
    latestWarning: warnings[0] || null
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();
  // 所有入口统一对账，保证列表、历史、刷新、写入回执的结论一致
  if (reconcileWarnings(db)) await writeDb(db);

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    const html = await readFile(path.join(__dirname, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-stability-warning-console", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const clock = {
      id: makeId("clock"),
      code: body.code,
      escapementType: body.escapementType,
      balanceFrequency: body.balanceFrequency,
      targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.clocks.push(clock);
    reconcileWarnings(db);
    await writeDb(db);
    return send(res, 201, { data: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  if (req.method === "GET" && pathname === "/warnings") {
    const status = url.searchParams.get("status");
    const clockId = url.searchParams.get("clockId");
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    let data = sortWarnings(db.warnings.map((warning) => warningView(db, warning)));
    if (status) data = data.filter((warning) => warning.status === status);
    if (clockId) data = data.filter((warning) => warning.clockId === clockId);
    if (q) {
      data = data.filter((warning) => {
        const clock = warning.clock || {};
        const haystack = [
          clock.code,
          clock.escapementType,
          clock.balanceFrequency,
          warning.handledBy,
          warning.confirmNote,
          warning.triggerRetest?.note
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    }
    const counts = {
      all: db.warnings.length,
      unconfirmed: db.warnings.filter((item) => item.status === "unconfirmed").length,
      confirmed: db.warnings.filter((item) => item.status === "confirmed").length,
      cleared: db.warnings.filter((item) => item.status === "cleared").length
    };
    return send(res, 200, { data, counts });
  }

  const confirmMatch = pathname.match(/^\/warnings\/([^/]+)\/confirm$/);
  if (confirmMatch && req.method === "POST") {
    const warning = findWarning(db, confirmMatch[1]);
    if (warning.status !== "unconfirmed") {
      const error = new Error(
        warning.status === "confirmed" ? "该预警已确认，不能重复确认" : "该预警所在监测期已结束，预警已清除"
      );
      error.status = 409;
      throw error;
    }
    const body = await parseBody(req);
    required(body, ["handledBy"]);
    const handledBy = String(body.handledBy).trim().slice(0, 50);
    if (!handledBy) {
      const error = new Error("处理人不能为空");
      error.status = 400;
      throw error;
    }
    warning.status = "confirmed";
    warning.handledBy = handledBy;
    warning.confirmNote = typeof body.note === "string" ? body.note.trim().slice(0, 200) : "";
    warning.confirmedAt = new Date().toISOString();
    await writeDb(db);
    return send(res, 200, { data: warningView(db, warning) });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const adjustments = sortedByTime(
      db.adjustments.filter((item) => item.clockId === clock.id),
      "createdAt"
    ).reverse();
    const retests = sortedByTime(
      db.retests.filter((item) => item.clockId === clock.id),
      "testedAt"
    ).reverse();
    const warnings = sortWarnings(
      db.warnings.filter((item) => item.clockId === clock.id).map((item) => warningView(db, item))
    );
    return send(res, 200, {
      data: { clock: clockSummary(db, clock), adjustments, retests, warnings, latestRetest: latestRetest(db, clock.id) }
    });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const adjustment = {
      id: makeId("adjustment"),
      clockId: clock.id,
      currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
      direction: body.direction,
      amount: body.amount,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.adjustments.push(adjustment);
    // 新调校写入：对账后上一监测期的待确认预警立即清除，已确认预警结论保留；历史均可查
    reconcileWarnings(db);
    const clearedWarnings = db.warnings.filter(
      (item) =>
        item.clockId === clock.id &&
        item.endedByAdjustmentId === adjustment.id &&
        item.status === "cleared"
    ).length;
    await writeDb(db);
    return send(res, 201, { data: adjustment, clearedWarnings, clock: clockSummary(db, clock) });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clock = findClock(db, retestMatch[1]);
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const adjustmentId = body.adjustmentId || latestAdjustment(db, clock.id)?.id || null;
    const qualified = body.qualified !== undefined
      ? Boolean(body.qualified)
      : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
    const retest = {
      id: makeId("retest"),
      clockId: clock.id,
      adjustmentId,
      testedAt: body.testedAt || new Date().toISOString(),
      dailyRateSeconds: Number(body.dailyRateSeconds),
      amplitude: Number(body.amplitude),
      qualified,
      note: body.note || ""
    };
    db.retests.push(retest);
    // 复测写入即判定：同监测期内振幅下降超过20度，立刻产生未确认预警
    reconcileWarnings(db);
    await writeDb(db);
    const generatedWarning =
      db.warnings.find((item) => item.key === `${clock.id}:${retest.id}`) || null;
    return send(res, 201, {
      data: retest,
      clock: clockSummary(db, clock),
      warning: generatedWarning ? warningView(db, generatedWarning) : null
    });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

// 串行化写请求，避免并发请求互相覆盖 JSON 库
let chain = Promise.resolve();
function withLock(task) {
  const run = chain.then(task);
  chain = run.catch(() => {});
  return run;
}

const server = http.createServer((req, res) => {
  withLock(() => handle(req, res)).catch((error) =>
    send(res, error.status || 500, { error: error.message || "服务器错误" })
  );
});

server.listen(PORT, () => {
  console.log(`Clock stability warning console running at http://127.0.0.1:${PORT}`);
});
