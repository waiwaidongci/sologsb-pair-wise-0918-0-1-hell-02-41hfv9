/* 钟表稳定性预警台前端（零依赖） */
const api = async (path, options = {}) => {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `请求失败 (${res.status})`);
  return json;
};

const state = {
  warnings: [],
  clocks: [],
  status: "all",
  clockId: "",
  keyword: "",
  pendingConfirmId: null,
  historyClockId: null
};

/* ---------------- 工具 ---------------- */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const STATUS_TEXT = { unconfirmed: "待确认", confirmed: "已确认", cleared: "已清除（新调校后历史）" };

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtWaiting(seconds) {
  if (seconds < 60) return `${seconds} 秒`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  const days = Math.floor(h / 24);
  return `${days} 天 ${h % 24} 小时`;
}

function toast(message, type = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast ${type}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add("hidden"), 3200);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

/* ---------------- 数据加载 ---------------- */
async function loadClocks() {
  const { data } = await api("/clocks");
  state.clocks = data;
  const options = data
    .map((c) => `<option value="${c.id}">${escapeHtml(c.code)}（${escapeHtml(c.escapementType)}）</option>`)
    .join("");
  $("#clockFilter").innerHTML = `<option value="">全部钟表</option>${options}`;
  $("#entryClockSelect").innerHTML = options;
}

async function loadWarnings() {
  const params = new URLSearchParams();
  if (state.status !== "all") params.set("status", state.status);
  if (state.clockId) params.set("clockId", state.clockId);
  if (state.keyword) params.set("q", state.keyword);

  const { data, summary } = await api(`/warnings?${params}`);
  state.warnings = data;

  const counts = await getCounts();
  for (const key of ["all", "unconfirmed", "confirmed", "cleared"]) {
    const el = $(`[data-count="${key}"]`);
    if (el) el.textContent = counts[key];
  }

  renderList(data);
  $("#updatedAt").textContent = fmtTime(new Date().toISOString());
  return summary;
}

// 未筛选的全量计数，保证筛选 chip 上始终显示真实总数
async function getCounts() {
  const { data } = await api("/warnings");
  const counts = { all: data.length, unconfirmed: 0, confirmed: 0, cleared: 0 };
  for (const item of data) counts[item.status] += 1;
  return counts;
}

/* ---------------- 列表渲染 ---------------- */
function renderList(data) {
  const list = $("#warningList");
  $("#emptyState").classList.toggle("hidden", data.length !== 0);
  $("#loadingState").classList.add("hidden");

  list.innerHTML = data
    .map((w) => {
      const triggered = new Date(w.triggeredRetestAt).getTime();
      const amp = `${w.previousAmplitude}°<span class="amp-arrow">→</span>${w.latestAmplitude}°`;
      let footer = "";
      if (w.status === "unconfirmed") {
        footer = `
          <div class="warning-actions">
            <button class="btn btn-danger" data-action="confirm" data-id="${w.id}">填写处理人确认</button>
            <button class="btn" data-action="history" data-clock="${w.clockId}">查看历史</button>
          </div>`;
      } else if (w.status === "confirmed") {
        footer = `
          <div class="confirm-line">
            ✅ 已由 <b>${escapeHtml(w.confirmedBy)}</b> 于 ${fmtTime(w.confirmedAt)} 确认${
          w.confirmNote ? `：${escapeHtml(w.confirmNote)}` : ""
        }
          </div>
          <div class="warning-actions"><button class="btn" data-action="history" data-clock="${w.clockId}">查看历史</button></div>`;
      } else {
        footer = `
          <div class="cleared-line">
            🔧 新调校已于 ${fmtTime(w.periodStartedAt)} 后写入，当期预警自动清除并重新监测；本记录为历史预警，不可再确认。
          </div>
          <div class="warning-actions"><button class="btn" data-action="history" data-clock="${w.clockId}">查看历史</button></div>`;
      }

      return `
        <article class="warning-card ${w.status}">
          <div class="warning-head">
            <div class="warning-title">
              <span class="code">${escapeHtml(w.clock?.code || w.clockId)}</span>
              <span class="meta">${escapeHtml(w.clock?.escapementType || "")} · ${escapeHtml(w.clock?.balanceFrequency || "")}</span>
              <span class="badge badge-${w.status}">${STATUS_TEXT[w.status]}</span>
            </div>
            ${w.status === "unconfirmed"
              ? `<span class="waiting" data-triggered="${triggered}">等待 ${fmtWaiting(w.waitingSeconds)}</span>`
              : `<span class="meta">触发于 ${fmtTime(w.triggeredRetestAt)}</span>`}
          </div>
          <div class="warning-grid">
            <div class="metric"><div class="label">振幅变化（最新复测 vs 前一次）</div><div class="value drop">${amp}（↓${w.amplitudeDrop}°）</div></div>
            <div class="metric"><div class="label">触发复测时间</div><div class="value" style="font-size:13.5px">${fmtTime(w.triggeredRetestAt)}</div></div>
            <div class="metric"><div class="label">监测期开始</div><div class="value" style="font-size:13.5px">${fmtTime(w.periodStartedAt)}</div></div>
            <div class="metric"><div class="label">复测备注</div><div class="value" style="font-size:12.5px;font-weight:400">${escapeHtml(w.retest?.note || "—")}</div></div>
          </div>
          ${footer}
        </article>`;
    })
    .join("");
}

// 等待时长每秒跳动；不重新请求，结论仍以服务端为准
setInterval(() => {
  for (const el of $$(".waiting[data-triggered]")) {
    const seconds = Math.max(0, Math.floor((Date.now() - Number(el.dataset.triggered)) / 1000));
    el.textContent = `等待 ${fmtWaiting(seconds)}`;
  }
}, 1000);

/* ---------------- 确认 ---------------- */
function openConfirm(id) {
  const w = state.warnings.find((item) => item.id === id);
  if (!w || w.status !== "unconfirmed") return;
  state.pendingConfirmId = id;
  $("#confirmContext").innerHTML = `
    <b>${escapeHtml(w.clock?.code || "")}</b> 振幅由 ${w.previousAmplitude}° 降至 ${w.latestAmplitude}°
    （下降 ${w.amplitudeDrop}°，阈值 20°），已等待 <b>${fmtWaiting(w.waitingSeconds)}</b>。
    确认后该预警不可重复确认。`;
  $("#confirmForm").reset();
  $("#confirmModal").classList.remove("hidden");
  setTimeout(() => $('input[name="confirmedBy"]', $("#confirmModal")).focus(), 50);
}

$("#confirmForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.pendingConfirmId) return;
  const form = new FormData(event.target);
  const submitBtn = $('button[type="submit"]', event.target);
  submitBtn.disabled = true;
  try {
    const { data } = await api(`/warnings/${state.pendingConfirmId}/confirm`, {
      method: "POST",
      body: { confirmedBy: form.get("confirmedBy").trim(), confirmNote: form.get("confirmNote").trim() }
    });
    toast(`已由 ${data.confirmedBy} 确认预警`, "ok");
    $("#confirmModal").classList.add("hidden");
    await refreshAll();
  } catch (error) {
    toast(error.message, "error");
    await loadWarnings();
  } finally {
    submitBtn.disabled = false;
  }
});

/* ---------------- 历史 / 录入 ---------------- */
async function openHistory(clockId) {
  state.historyClockId = clockId;
  $("#entryClockSelect").value = clockId;
  $("#historyModal").classList.remove("hidden");
  await renderHistory();
}

async function renderHistory() {
  const clockId = state.historyClockId;
  const { data } = await api(`/clocks/${encodeURIComponent(clockId)}/history`);
  const clock = data.clocks;
  $("#historyTitle").textContent = `${clock.code} · 调校与复测历史`;

  // 按调校时间切分监测期，标出每期内振幅下降与预警
  const adjustments = data.adjustments.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const retests = data.retests.slice().sort((a, b) => new Date(a.testedAt) - new Date(b.testedAt));
  const warningByRetest = new Map(data.warnings.map((w) => [w.retestId, w]));

  let periodStart = clock.createdAt;
  let cursor = 0;
  let prev = null;
  const retestRows = retests.map((r) => {
    while (cursor < adjustments.length && new Date(adjustments[cursor].createdAt) <= new Date(r.testedAt)) {
      periodStart = adjustments[cursor].createdAt;
      cursor += 1;
      prev = null;
    }
    const drop = prev ? prev.amplitude - r.amplitude : null;
    const warning = warningByRetest.get(r.id);
    prev = r;
    return `
      <tr>
        <td>${fmtTime(r.testedAt)}</td>
        <td>${r.dailyRateSeconds}s</td>
        <td>${r.amplitude}°</td>
        <td>${drop === null ? "—" : drop > 0 ? `<span class="${drop > 20 ? "drop-cell" : ""}">↓${drop}°</span>` : `↑${-drop}°`}</td>
        <td>${r.qualified ? '<span style="color:var(--ok)">合格</span>' : '<span style="color:var(--danger)">未合格</span>'}</td>
        <td>${warning ? `<span class="badge badge-${warning.status}">${STATUS_TEXT[warning.status]}</span>` : ""}</td>
        <td>${escapeHtml(r.note)}</td>
      </tr>`;
  }).join("");

  const adjustmentRows = data.adjustments.map((a) => `
      <tr>
        <td>${fmtTime(a.createdAt)}</td>
        <td>${a.currentDailyRateSeconds}s</td>
        <td>${escapeHtml(a.direction)}</td>
        <td>${escapeHtml(a.amount)}</td>
        <td>${escapeHtml(a.note)}</td>
      </tr>`).join("");

  const warningRows = data.warnings.map((w) => `
      <tr>
        <td>${fmtTime(w.triggeredRetestAt)}</td>
        <td>${w.previousAmplitude}° → ${w.latestAmplitude}°</td>
        <td><span class="badge badge-${w.status}">${STATUS_TEXT[w.status]}</span></td>
        <td>${w.confirmedBy ? `${escapeHtml(w.confirmedBy)} / ${fmtTime(w.confirmedAt)}` : "—"}</td>
        <td>${escapeHtml(w.confirmNote || "—")}</td>
      </tr>`).join("");

  const prevAmp = data.latestRetest ? data.latestRetest.amplitude : null;
  $("#historyBody").innerHTML = `
    <div class="hist-summary">
      <span class="tag">擒纵：${escapeHtml(clock.escapementType)}</span>
      <span class="tag">摆频：${escapeHtml(clock.balanceFrequency)}</span>
      <span class="tag">日差目标：±${clock.targetDailyRateSeconds}s</span>
      <span class="tag">当期监测始于：${fmtTime(data.periodStartedAt)}</span>
      <span class="tag">最近复测振幅：${prevAmp === null ? "无" : prevAmp + "°"}</span>
    </div>
    ${clock.note ? `<p class="muted">${escapeHtml(clock.note)}</p>` : ""}

    <div class="tabs">
      <button class="tab active" data-tab="entry">录入</button>
      <button class="tab" data-tab="retests">复测记录（${retests.length}）</button>
      <button class="tab" data-tab="adjustments">调校记录（${data.adjustments.length}）</button>
      <button class="tab" data-tab="warnings">预警历史（${data.warnings.length}）</button>
    </div>

    <div data-pane="entry">
      <div class="entry-forms">
        <form class="entry-box" id="retestForm">
          <h4>新增复测（振幅较前一次降 &gt;20° 将生成未确认预警）</h4>
          <label class="field"><span>日差（秒/天，带符号）</span><input name="dailyRateSeconds" type="number" step="0.1" required /></label>
          <label class="field"><span>振幅（度）${prevAmp !== null ? `· 前一次 ${prevAmp}°` : "· 首次复测建立基线"}</span>
            <input name="amplitude" type="number" step="1" required /></label>
          <label class="field"><span>备注</span><input name="note" placeholder="如 摆幅下滑，怀疑油泥干涩" /></label>
          <button class="btn btn-primary" type="submit">提交复测</button>
        </form>
        <form class="entry-box" id="adjustmentForm">
          <h4>新增调校（写入后当期预警立即清除，重新监测）</h4>
          <label class="field"><span>当前日差（秒/天）</span><input name="currentDailyRateSeconds" type="number" step="0.1" required /></label>
          <label class="field"><span>方向</span>
            <select name="direction" required>
              <option value="慢针方向">慢针方向</option>
              <option value="快针方向">快针方向</option>
              <option value="无">暂不调整</option>
            </select>
          </label>
          <label class="field"><span>调校量</span><input name="amount" required placeholder="如 快慢针向慢侧微调0.3格" /></label>
          <label class="field"><span>备注</span><input name="note" /></label>
          <button class="btn btn-primary" type="submit">提交调校</button>
        </form>
      </div>
    </div>

    <div data-pane="retests" class="hidden">
      <table>
        <thead><tr><th>复测时间</th><th>日差</th><th>振幅</th><th>同期变化</th><th>合格</th><th>预警</th><th>备注</th></tr></thead>
        <tbody>${retestRows || '<tr><td colspan="7">暂无复测</td></tr>'}</tbody>
      </table>
    </div>
    <div data-pane="adjustments" class="hidden">
      <table>
        <thead><tr><th>调校时间</th><th>当前日差</th><th>方向</th><th>调校量</th><th>备注</th></tr></thead>
        <tbody>${adjustmentRows || '<tr><td colspan="5">暂无调校</td></tr>'}</tbody>
      </table>
    </div>
    <div data-pane="warnings" class="hidden">
      <table>
        <thead><tr><th>触发时间</th><th>振幅变化</th><th>状态</th><th>确认人/时间</th><th>处理说明</th></tr></thead>
        <tbody>${warningRows || '<tr><td colspan="5">暂无预警</td></tr>'}</tbody>
      </table>
    </div>`;

  $$(".tab", $("#historyBody")).forEach((tab) =>
    tab.addEventListener("click", () => {
      $$(".tab", $("#historyBody")).forEach((t) => t.classList.toggle("active", t === tab));
      $$("[data-pane]", $("#historyBody")).forEach((pane) =>
        pane.classList.toggle("hidden", pane.dataset.pane !== tab.dataset.tab));
    })
  );

  $("#retestForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    await submitForm(event.target, "/retests", {
      dailyRateSeconds: Number(form.get("dailyRateSeconds")),
      amplitude: Number(form.get("amplitude")),
      note: form.get("note").trim()
    }, (result) => {
      if (result.warning) {
        return `复测已提交：振幅下降 ${result.warning.amplitudeDrop}°，已生成未确认预警`;
      }
      if (result.amplitudeCheck) {
        const { drop, triggered } = result.amplitudeCheck;
        return triggered
          ? "复测已提交并生成预警"
          : `复测已提交（振幅变化 ${drop > 0 ? "下降" : "上升"} ${Math.abs(drop)}°，未达 20° 阈值）`;
      }
      return "复测已提交，已建立振幅基线";
    });
  });

  $("#adjustmentForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    await submitForm(event.target, "/adjustments", {
      currentDailyRateSeconds: Number(form.get("currentDailyRateSeconds")),
      direction: form.get("direction"),
      amount: form.get("amount"),
      note: form.get("note").trim()
    }, (result) => result.monitoring.message);
  });
}

async function submitForm(formEl, suffix, body, messageFor) {
  const btn = $('button[type="submit"]', formEl);
  btn.disabled = true;
  try {
    const result = await api(`/clocks/${encodeURIComponent(state.historyClockId)}${suffix}`, {
      method: "POST",
      body
    });
    toast(messageFor(result), "ok");
    formEl.reset();
    await renderHistory();
    await refreshAll();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 全局刷新（所有入口结论同步） ---------------- */
async function refreshAll() {
  await Promise.all([loadClocks(), loadWarnings()]);
  if (!$("#historyModal").classList.contains("hidden") && state.historyClockId) {
    await renderHistory();
  }
}

/* ---------------- 事件绑定 ---------------- */
$("#warningList").addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;
  if (btn.dataset.action === "confirm") openConfirm(btn.dataset.id);
  if (btn.dataset.action === "history") openHistory(btn.dataset.clock);
});

$("#statusFilters").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  state.status = chip.dataset.status;
  $$(".chip", $("#statusFilters")).forEach((item) => item.classList.toggle("active", item === chip));
  loadWarnings();
});

$("#clockFilter").addEventListener("change", (event) => {
  state.clockId = event.target.value;
  loadWarnings();
});

let keywordTimer;
$("#keywordFilter").addEventListener("input", (event) => {
  clearTimeout(keywordTimer);
  keywordTimer = setTimeout(() => {
    state.keyword = event.target.value.trim();
    loadWarnings();
  }, 250);
});

$("#openEntryBtn").addEventListener("click", () => {
  const clockId = $("#entryClockSelect").value;
  if (clockId) openHistory(clockId);
});
$("#refreshBtn").addEventListener("click", () => refreshAll().then(() => toast("已刷新", "ok")));

$$("[data-close]").forEach((btn) =>
  btn.addEventListener("click", () => $(`#${btn.dataset.close}`).classList.add("hidden"))
);
$$(".modal-mask").forEach((mask) =>
  mask.addEventListener("click", (event) => {
    if (event.target === mask) mask.classList.add("hidden");
  })
);

setInterval(refreshAll, 30000);

/* ---------------- 启动 ---------------- */
(async function init() {
  try {
    await refreshAll();
  } catch (error) {
    $("#loadingState").textContent = `加载失败：${error.message}`;
  }
})();
