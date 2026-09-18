# 机械钟表稳定性预警台

零依赖 Node 服务 + 原生前端，使用 `data/db.json` 持久化钟表档案、调校记录、复测记录与预警确认。

## 启动

```bash
PORT=3021 node server.js
# 浏览器打开 http://127.0.0.1:3021
```

## 预警规则

- 同一监测期内（最近一次调校之后），最新复测振幅比前一次复测**下降超过 20°** 时，生成一条**未确认**预警；首次复测只建立基线，恰好下降 20° 不触发。
- 预警列表中未确认记录**排在最前**并实时显示**等待时长**。
- 未确认预警可填写处理人确认（处理说明可选）；**同一预警只能确认一次**，重复提交返回 409。
- **写入新调校后，该钟表当期预警立即清除**并重新建立监测期（期内前后复测不再比较）；旧预警不删除，状态转为「已清除」，仍可在列表与历史中查询。
- 预警结论由调校/复测原始数据**统一派生**：预警 ID 与复测 ID 确定性对应，任何入口写入、刷新页面结论都一致，历史数据重启后自动补齐。

## 页面功能

- 预警列表：未确认置顶、等待时长每秒跳动、振幅前后对比、确认人/清除说明。
- 处理人确认弹窗（必填处理人，只能提交一次）。
- 筛选：全部 / 待确认 / 已确认 / 已清除，按钟表、编号/擒纵机构关键字筛选。
- 历史抽屉：单钟表的调校、复测（标注同期振幅变化与预警状态）、预警历史，并可直接录入新调校/复测。
- 30 秒自动刷新 + 手动刷新；多入口操作后结论实时同步。

## 主要接口

原有：

- `GET /health`
- `GET /clocks` · `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`（含 `warnings`、`periodStartedAt`）
- `POST /clocks/:id/adjustments`（返回 `monitoring.clearedWarnings`）
- `POST /clocks/:id/retests`（返回 `warning` 与同口径 `amplitudeCheck`）
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=` · `GET /retests?clockId=&qualified=`

预警：

- `GET /warnings?status=all|unconfirmed|confirmed|cleared|active&clockId=&q=`
- `GET /warnings/:id`
- `POST /warnings/:id/confirm`  body: `{ "confirmedBy": "姓名", "confirmNote": "可选" }`

接口同时支持 `/api` 前缀（如 `/api/warnings`）。

## 闭环示例

```bash
curl http://127.0.0.1:3021/warnings
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":42,"amplitude":235,"note":"摆幅下滑"}'
curl -X POST http://127.0.0.1:3021/warnings/<id>/confirm \
  -H 'Content-Type: application/json' \
  -d '{"confirmedBy":"王师傅","confirmNote":"已安排清洗擒纵轮"}'
```
