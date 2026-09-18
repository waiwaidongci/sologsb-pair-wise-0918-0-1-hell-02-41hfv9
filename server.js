const http = require("http");
const fs = require("fs");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = path.join(__dirname, "data", "db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const AMPLITUDE_DROP_THRESHOLD = 20;

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: new Date().toISOString()
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
      createdAt: new Date().toISOString()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  warnings: []
};

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments?clockId=",
  "GET /retests?clockId=&qualified=",
  "GET /warnings?status=&clockId=",
  "GET /warnings/:id",
  "POST /warnings/:id/confirm"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(DB_FILE, "utf8"));
    if (!Array.isArray(parsed.warnings)) parsed.warnings = [];
    return parsed;
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
    return initialData;
  }
}

async function readDb() {
  const db = await ensureDb();
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

function latestRetest(db, clockId) {
  return db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified: retest ? retest.qualified : false
  };
}

/* ---------------- 预警领域：结论统一从 调校/复测 数据派生 ---------------- */

// 一次调校开启一个新的监测期；首次调校之前以建档时间为起点
function currentPeriodStart(db, clockId, fallback = null) {
  const latest = latestAdjustment(db, clockId);
  return latest ? latest.createdAt : fallback;
}

// 预警ID由复测ID确定性派生，同一复测无论从哪个入口触发都只会生成一条
function warningIdFor(retestId) {
  return `warning_${retestId.replace(/^retest_/, "")}`;
}

/**
 * 依据全部复测记录补齐预警落库（幂等）：
 * 同一监测期内，本次复测振幅比上一次下降超过 20 度即触发预警。
 * 预警是否属于"当期"在读取时实时计算，新调校写入后旧预警无需改写即自动转入历史。
 */
function computeWarnings(db) {
  let created = 0;
  const byId = new Map(db.warnings.map((item) => [item.id, item]));

  for (const clock of db.clocks) {
    const adjustments = db.adjustments
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const retests = db.retests
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => new Date(a.testedAt) - new Date(b.testedAt));

    // 一次调校开启一个监测期：期内相邻复测比较振幅；跨调校不比较
    let periodStart = clock.createdAt;
    let periodAdjustmentId = null;
    let adjustmentCursor = 0;
    let prev = null;

    for (const retest of retests) {
      while (
        adjustmentCursor < adjustments.length &&
        new Date(adjustments[adjustmentCursor].createdAt).getTime() <= new Date(retest.testedAt).getTime()
      ) {
        const adjustment = adjustments[adjustmentCursor];
        periodStart = adjustment.createdAt;
        periodAdjustmentId = adjustment.id;
        adjustmentCursor += 1;
        prev = null; // 新监测期：振幅基线重新建立
      }

      if (prev && Number(retest.amplitude) < Number(prev.amplitude) - AMPLITUDE_DROP_THRESHOLD) {
        const id = warningIdFor(retest.id);
        if (!byId.has(id)) {
          const warning = {
            id,
            clockId: clock.id,
            retestId: retest.id,
            previousRetestId: prev.id,
            periodStartAdjustmentId: periodAdjustmentId,
            periodStartedAt: periodStart,
            previousAmplitude: Number(prev.amplitude),
            latestAmplitude: Number(retest.amplitude),
            amplitudeDrop: Number(prev.amplitude) - Number(retest.amplitude),
            triggeredRetestAt: retest.testedAt,
            createdAt: retest.testedAt,
            status: "unconfirmed",
            confirmedBy: null,
            confirmedAt: null,
            confirmNote: ""
          };
          byId.set(id, warning);
          created += 1;
        }
      }
      prev = retest;
    }
  }

  db.warnings = [...byId.values()];
  return created;
}

// 同步落库（新复测写入后调用），保证多入口结论一致
async function syncWarnings(db) {
  const created = computeWarnings(db);
  if (created) await writeDb(db);
  return created;
}

function decorateWarning(db, warning) {
  const clock = db.clocks.find((item) => item.id === warning.clockId) || null;
  const currentStart = currentPeriodStart(db, warning.clockId, clock?.createdAt ?? null);
  const inCurrentPeriod =
    currentStart !== null && warning.periodStartedAt !== null &&
    new Date(warning.periodStartedAt).getTime() === new Date(currentStart).getTime();

  // 状态三态：未确认 / 已确认（当期内）/ 已清除（新调校后转入历史）
  const status = !inCurrentPeriod ? "cleared" : warning.status === "confirmed" ? "confirmed" : "unconfirmed";

  return {
    ...warning,
    status,
    inCurrentPeriod,
    clock: clock
      ? {
          id: clock.id,
          code: clock.code,
          escapementType: clock.escapementType,
          balanceFrequency: clock.balanceFrequency
        }
      : null,
    retest: db.retests.find((item) => item.id === warning.retestId) || null,
    previousRetest: db.retests.find((item) => item.id === warning.previousRetestId) || null,
    waitingSeconds:
      status === "unconfirmed"
        ? Math.max(0, Math.floor((Date.now() - new Date(warning.triggeredRetestAt).getTime()) / 1000))
        : 0
  };
}

function listWarnings(db) {
  computeWarnings(db);
  return db.warnings
    .map((warning) => decorateWarning(db, warning))
    .sort((a, b) => {
    // 未确认置顶，按等待时长从长到短；其余按触发时间倒序
    if (a.status === "unconfirmed" && b.status !== "unconfirmed") return -1;
    if (b.status === "unconfirmed" && a.status !== "unconfirmed") return 1;
    if (a.status === "unconfirmed" && b.status === "unconfirmed") {
      return new Date(a.triggeredRetestAt) - new Date(b.triggeredRetestAt);
    }
    return new Date(b.triggeredRetestAt) - new Date(a.triggeredRetestAt);
  });
}

/* ---------------- 静态资源 ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("页面不存在");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  });
}

/* ---------------- 路由 ---------------- */

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const db = await readDb();

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
    await writeDb(db);
    return send(res, 201, { data: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const retests = db.retests
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt));
    return send(res, 200, {
      data: {
        clock,
        adjustments,
        retests,
        latestRetest: latestRetest(db, clock.id),
        periodStartedAt: currentPeriodStart(db, clock.id, clock.createdAt),
        warnings: listWarnings(db).filter((item) => item.clockId === clock.id)
      }
    });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    // 写入前先记录"当期"（上一调校之后）仍有效的预警
    const priorPeriodStart = currentPeriodStart(db, clock.id, clock.createdAt);
    const activeWarnings = listWarnings(db).filter(
      (item) => item.clockId === clock.id && item.inCurrentPeriod
    );
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
    await writeDb(db);
    // 新调校写入：上一监测期预警立即清除并重新监测（旧预警保留，可在历史中查询）
    return send(res, 201, {
      data: adjustment,
      monitoring: {
        previousPeriodStartedAt: priorPeriodStart,
        periodStartedAt: adjustment.createdAt,
        clearedWarnings: activeWarnings.map((item) => item.id),
        message: activeWarnings.length
          ? `已清除 ${activeWarnings.length} 条当期预警（${activeWarnings
              .map((item) => (item.status === "unconfirmed" ? "待确认" : "已确认"))
              .join("、")}），监测期重新开始`
          : "新监测期已开始，历史预警仍可查询"
      }
    });
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
    await writeDb(db);
    await syncWarnings(db);
    const generatedWarning = db.warnings.find((item) => item.id === warningIdFor(retest.id));
    const generated = generatedWarning ? decorateWarning(db, generatedWarning) : null;
    // 与预警判定同口径：仅与当前监测期内（最近一次调校之后）的前一次复测比较
    const periodAdjustments = db.adjustments
      .filter((item) => item.clockId === clock.id && new Date(item.createdAt).getTime() <= new Date(retest.testedAt).getTime())
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const periodStartMs = periodAdjustments.length
      ? new Date(periodAdjustments[0].createdAt).getTime()
      : new Date(clock.createdAt).getTime();
    const prevInPeriod = db.retests
      .filter(
        (item) =>
          item.id !== retest.id &&
          item.clockId === clock.id &&
          new Date(item.testedAt).getTime() < new Date(retest.testedAt).getTime() &&
          new Date(item.testedAt).getTime() >= periodStartMs
      )
      .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0];
    return send(res, 201, {
      data: retest,
      clock: clockSummary(db, clock),
      warning: generated && generated.status !== "cleared" ? generated : null,
      amplitudeCheck: prevInPeriod
        ? {
            previousAmplitude: Number(prevInPeriod.amplitude),
            drop: Number(prevInPeriod.amplitude) - retest.amplitude,
            threshold: AMPLITUDE_DROP_THRESHOLD,
            triggered: Number(prevInPeriod.amplitude) - retest.amplitude > AMPLITUDE_DROP_THRESHOLD
          }
        : null
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

  if (req.method === "GET" && pathname === "/warnings") {
    const status = url.searchParams.get("status") || "all";
    const clockId = url.searchParams.get("clockId");
    const keyword = (url.searchParams.get("q") || "").trim().toLowerCase();
    let data = listWarnings(db);
    if (["unconfirmed", "confirmed", "cleared", "active"].includes(status)) {
      data = data.filter((item) => (status === "active" ? item.inCurrentPeriod : item.status === status));
    }
    if (clockId) data = data.filter((item) => item.clockId === clockId);
    if (keyword) {
      data = data.filter(
        (item) =>
          (item.clock?.code || "").toLowerCase().includes(keyword) ||
          (item.clock?.escapementType || "").toLowerCase().includes(keyword)
      );
    }
    return send(res, 200, {
      data,
      summary: {
        total: data.length,
        unconfirmed: data.filter((item) => item.status === "unconfirmed").length,
        confirmed: data.filter((item) => item.status === "confirmed").length,
        cleared: data.filter((item) => item.status === "cleared").length
      },
      thresholdDegrees: AMPLITUDE_DROP_THRESHOLD
    });
  }

  const warningMatch = pathname.match(/^\/warnings\/([^/]+)$/);
  if (warningMatch && req.method === "GET") {
    computeWarnings(db);
    const warning = db.warnings.find((item) => item.id === warningMatch[1]);
    if (!warning) {
      return send(res, 404, { error: "预警不存在" });
    }
    return send(res, 200, { data: decorateWarning(db, warning) });
  }

  const confirmMatch = pathname.match(/^\/warnings\/([^/]+)\/confirm$/);
  if (confirmMatch && req.method === "POST") {
    computeWarnings(db);
    const warning = db.warnings.find((item) => item.id === confirmMatch[1]);
    if (!warning) {
      return send(res, 404, { error: "预警不存在" });
    }
    const decorated = decorateWarning(db, warning);
    if (!decorated.inCurrentPeriod) {
      return send(res, 409, { error: "该预警所属监测期已结束（已有新调校），不能确认，可在历史中查看" });
    }
    // 同一预警只能确认一次
    if (warning.status === "confirmed") {
      return send(res, 409, { error: "该预警已确认，不能重复确认", data: decorated });
    }
    const body = await parseBody(req);
    required(body, ["confirmedBy"]);
    warning.status = "confirmed";
    warning.confirmedBy = String(body.confirmedBy).slice(0, 50);
    warning.confirmedAt = new Date().toISOString();
    warning.confirmNote = body.confirmNote || "";
    await writeDb(db);
    return send(res, 200, { data: decorateWarning(db, warning) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    url.pathname = url.pathname.replace(/^\/api/, "");
  }
  if (url.pathname.startsWith("/health") || url.pathname.startsWith("/clocks") ||
      url.pathname.startsWith("/adjustments") || url.pathname.startsWith("/retests") ||
      url.pathname.startsWith("/warnings")) {
    handleApi(req, res, url).catch((error) =>
      send(res, error.status || 500, { error: error.message || "服务器错误" })
    );
    return;
  }
  if (req.method === "GET") return serveStatic(req, res, url.pathname);
  send(res, 404, { error: "接口不存在", routes });
});

server.listen(PORT, () => {
  console.log(`Clock stability warning console running at http://127.0.0.1:${PORT}`);
});
