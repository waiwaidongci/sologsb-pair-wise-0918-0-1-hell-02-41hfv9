# 机械钟表稳定性预警台

零依赖 Node 服务 + 单页前端，使用 `data/db.json` 持久化钟表档案、调校记录、复测记录与稳定性预警。
打开 http://127.0.0.1:3021/ 即可使用预警台页面。

## 启动

```bash
PORT=3021 node server.js
```

## 预警规则

- 每次**调校**写入后开启一个新的“监测期”，只在同一监测期内比较相邻两次复测；
- 同监测期内，最新复测振幅比前一次**下降超过 20 度**（严格大于 20）时，自动生成一条**待确认**预警；
- 待确认预警在列表中**置顶**（等待越久越靠前），并实时显示“已等待 xx 小时 xx 分钟”；
- 确认时必须填写**处理人**，同一预警**只能确认一次**（重复确认返回 409）；
- 新调校写入后，上一监测期**立即结束**：其中的待确认预警转为**已清除**并重新监测；已确认的结论保留；
- 旧预警不会被删除，可在“已清除 / 已确认”筛选页和对应钟表的历史抽屉中查看；
- 预警结论由调校/复测数据在每次请求时统一对账派生，列表、历史、写入回执、刷新后的结论保持一致。

## 主要接口

页面与数据：

- `GET /` — 预警台页面
- `GET /warnings?status=unconfirmed|confirmed|cleared&clockId=&q=` — 预警列表（含全量计数与等待时长）
- `POST /warnings/:id/confirm` — 确认预警（body：`handledBy` 必填，`note` 选填）
- `GET /clocks/:id/history` — 钟表历史（钟表信息 + 调校/复测/预警时间线）

沿用的数据接口：

- `GET /health`
- `GET /clocks` / `POST /clocks`（列表含 `unconfirmedWarningCount`、`latestWarning`）
- `GET /clocks/not-qualified`
- `POST /clocks/:id/adjustments` — 写入新调校，回执含本次 `clearedWarnings` 条数
- `POST /clocks/:id/retests` — 写入复测，触发规则时回执 `warning` 为新预警
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`

## 页面功能

- 预警列表按“待确认 → 其他”排序，状态页签带计数，支持关键词筛选（表号/擒纵类型/处理人/备注）；
- 每条待确认预警可直接填写处理人和处理说明完成确认；
- 点击表号打开历史抽屉：查看该表全部调校、复测、预警，并可直接登记新调校/新复测；
- 等待时长每秒刷新，页面默认每 20 秒自动重新拉取结论，也可手动刷新。

## 闭环示例

```bash
# 写入新调校（清期重监测）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/adjustments \
  -H 'Content-Type: application/json' \
  -d '{"currentDailyRateSeconds":44,"direction":"慢针方向","amount":"向慢侧微调0.3格"}'

# 提交复测；若同监测期内振幅下降超过20度，回执中 warning 即为新预警
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":190}'

# 确认预警（处理人必填，只能成功一次）
curl -X POST http://127.0.0.1:3021/warnings/<warningId>/confirm \
  -H 'Content-Type: application/json' \
  -d '{"handledBy":"王师傅","note":"已检查擒纵轮并安排保养"}'
```
