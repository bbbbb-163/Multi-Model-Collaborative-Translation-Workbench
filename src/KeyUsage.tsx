import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Filter,
  RefreshCw,
} from "lucide-react";
import type { KeyUsageReport, RequestStatus } from "../shared/types";
import { api } from "./api";
import { ErrorNotice } from "./components";
import Select from "./Select";

const statuses: Record<RequestStatus, string> = {
  running: "进行中",
  success: "成功",
  error: "失败",
  cancelled: "已取消",
  interrupted: "服务中断",
};
const number = (n: number | null) =>
  n === null ? "—" : n.toLocaleString("zh-CN");
const date = (s: string) =>
  new Date(s).toLocaleString("zh-CN", { hour12: false });
function inputDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function media(v: { images: number; audio: number; video: number }) {
  return (
    [
      v.images ? `图片 ${v.images} 张` : "",
      v.audio ? `音频 ${v.audio} 个` : "",
      v.video ? `视频 ${v.video} 个` : "",
    ]
      .filter(Boolean)
      .join(" · ") || "—"
  );
}
export default function KeyUsage({
  id,
  models,
  labels,
}: {
  id: string;
  models: { id: string; name: string }[];
  labels: Record<string, string>;
}) {
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    return inputDate(d);
  });
  const [to, setTo] = useState(() => inputDate(new Date()));
  const [period, setPeriod] = useState("30");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [showRequests, setShowRequests] = useState(false);
  const [model, setModel] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [report, setReport] = useState<KeyUsageReport | null>(null);
  const [available, setAvailable] = useState(models);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  function choosePeriod(value: string) {
    setPeriod(value);
    setPage(1);
    if (value === "custom") {
      setFiltersOpen(true);
      return;
    }
    if (value === "all") {
      setFrom("");
      setTo("");
      return;
    }
    const start = new Date();
    start.setDate(start.getDate() - Number(value) + 1);
    setFrom(inputDate(start));
    setTo(inputDate(new Date()));
  }
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    setReport(null);
    const query = new URLSearchParams({ page: String(page) });
    if (from) query.set("from", new Date(from + "T00:00:00").toISOString());
    if (to) {
      const end = new Date(to + "T00:00:00");
      end.setDate(end.getDate() + 1);
      query.set("to", end.toISOString());
    }
    if (model) query.set("modelId", model);
    if (status) query.set("status", status);
    if (from && to && from > to) {
      setError("开始日期不能晚于结束日期。");
      setLoading(false);
      return () => {
        current = false;
      };
    }
    void api<KeyUsageReport>(`/admin/keys/${id}/usage?${query}`)
      .then((value) => {
        if (current) {
          setReport(value);
          setAvailable([
            ...new Map(
              [...models, ...value.availableModels].map((m) => [m.id, m]),
            ).values(),
          ]);
        }
      })
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [id, from, to, model, status, page, revision]);
  return (
    <section
      className="key-usage"
      aria-label="密钥请求与用量"
      aria-busy={loading}
    >
      <div className="key-usage-toolbar">
        <label className="field">
          时间范围
          <Select
            aria-label="用量时间范围"
            value={period}
            onChange={choosePeriod}
          >
            <option value="7">近 7 天</option>
            <option value="30">近 30 天</option>
            <option value="all">全部时间</option>
            <option value="custom">自定义日期</option>
          </Select>
        </label>
        <label className="field">
          模型
          <Select
            aria-label="用量模型"
            value={model}
            onChange={(v) => {
              setModel(v);
              setPage(1);
            }}
          >
            <option value="">全部模型</option>
            {available.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </label>
        <button
          type="button"
          className="outline-button"
          aria-label="刷新用量"
          disabled={loading}
          onClick={() => setRevision((v) => v + 1)}
        >
          <RefreshCw size={14} />
          刷新
        </button>
      </div>
      <details
        className="key-extra-filters"
        open={filtersOpen}
        onToggle={(e) => setFiltersOpen(e.currentTarget.open)}
      >
        <summary>
          <Filter size={14} />
          <span>
            更多筛选{status ? ` · ${statuses[status as RequestStatus]}` : ""}
          </span>
          <ChevronDown size={14} />
        </summary>
        <div className="key-usage-filters">
          <label className="field">
            开始日期
            <input
              type="date"
              aria-label="用量开始日期"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPeriod("custom");
                setPage(1);
              }}
            />
          </label>
          <label className="field">
            结束日期
            <input
              type="date"
              aria-label="用量结束日期"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPeriod("custom");
                setPage(1);
              }}
            />
          </label>
          <label className="field">
            请求状态
            <Select
              aria-label="请求状态"
              value={status}
              onChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
            >
              <option value="">全部状态</option>
              {Object.entries(statuses).map(([s, l]) => (
                <option key={s} value={s}>
                  {l}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </details>
      {(model || status || period !== "30") && (
        <button
          type="button"
          className="text-button key-reset-filters"
          onClick={() => {
            choosePeriod("30");
            setModel("");
            setStatus("");
          }}
        >
          重置筛选
        </button>
      )}
      {error && <ErrorNotice message={error} />}
      {loading && (
        <p className="small-note" role="status">
          正在加载请求与用量…
        </p>
      )}
      {report && (
        <>
          <p className="key-usage-summary">
            共 <strong>{number(report.totals.requests)}</strong> 次请求 · 成功{" "}
            {number(report.totals.success)} · 失败{" "}
            {number(report.totals.failed)}
            {report.totals.cancelled > 0 &&
              ` · 取消 ${number(report.totals.cancelled)}`}
            {report.totals.running > 0 &&
              ` · 进行中 ${number(report.totals.running)}`}
          </p>
          <dl className="key-usage-tokens">
            <div>
              <dt>输入 Token</dt>
              <dd>{number(report.totals.inputTokens)}</dd>
            </div>
            <div>
              <dt>输出 Token</dt>
              <dd>{number(report.totals.outputTokens)}</dd>
            </div>
            <div>
              <dt>总 Token</dt>
              <dd>{number(report.totals.totalTokens)}</dd>
            </div>
          </dl>
          {report.totals.unreported > 0 && (
            <p className="small-note key-unreported">
              {number(report.totals.unreported)} 次请求未上报 Token，显示为“—”。
            </p>
          )}
          {!report.total ? (
            <p className="key-usage-empty">
              当前筛选下暂无请求。用户调用已授权的 Mstar
              模型后，记录会显示在这里；也可调整日期或模型筛选。
            </p>
          ) : (
            <>
              <h3 className="key-usage-section-title">按模型汇总</h3>
              <p className="key-table-hint">左右滑动表格可查看完整用量。</p>
              <div
                className="key-table-scroll"
                role="region"
                tabIndex={0}
                aria-label="模型用量汇总，可横向滚动"
              >
                <table className="key-usage-table">
                  <thead>
                    <tr>
                      <th scope="col">模型</th>
                      <th scope="col">请求</th>
                      <th scope="col">输入 Token</th>
                      <th scope="col">输出 Token</th>
                      <th scope="col">返回媒体</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.models.map((m) => (
                      <tr key={m.modelId}>
                        <th scope="row">
                          {m.modelName}
                          <small>
                            {m.success} 成功 · {m.failed} 失败
                            {m.unreported ? ` · ${m.unreported} 次未上报` : ""}
                          </small>
                        </th>
                        <td>{number(m.requests)}</td>
                        <td>{number(m.inputTokens)}</td>
                        <td>{number(m.outputTokens)}</td>
                        <td>{media(m)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button
                type="button"
                className="key-request-toggle"
                aria-expanded={showRequests}
                aria-controls={`requests-${id}`}
                onClick={() => setShowRequests((v) => !v)}
              >
                <span>
                  逐次请求明细<small>{report.total} 条记录</small>
                </span>
                <ChevronDown size={15} />
              </button>
              <div id={`requests-${id}`} hidden={!showRequests}>
                <div
                  className="key-table-scroll"
                  role="region"
                  tabIndex={0}
                  aria-label="请求明细，可横向滚动"
                >
                  <table className="key-usage-table">
                    <thead>
                      <tr>
                        <th scope="col">请求时间 / 模型</th>
                        <th scope="col">状态 / 耗时</th>
                        <th scope="col">输入 Token</th>
                        <th scope="col">输出 Token</th>
                        <th scope="col">总 Token / 媒体</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.records.map((r) => (
                        <tr key={r.id}>
                          <th scope="row">
                            <time dateTime={r.startedAt}>
                              {date(r.startedAt)}
                            </time>
                            <small>
                              {r.modelName} ·{" "}
                              {labels[r.capability] || r.capability}
                            </small>
                            <small className="key-request-id" title={r.id}>
                              请求 {r.id.slice(0, 8)}
                            </small>
                          </th>
                          <td>
                            <span
                              className={`key-request-status status-${r.status}`}
                            >
                              {statuses[r.status]}
                            </span>
                            <small>
                              {r.durationMs === null
                                ? "—"
                                : `${(r.durationMs / 1000).toFixed(2)} 秒`}
                            </small>
                          </td>
                          <td>{number(r.inputTokens)}</td>
                          <td>{number(r.outputTokens)}</td>
                          <td>
                            {number(r.totalTokens)}
                            <small>{media(r)}</small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="key-usage-pagination">
                  <span>
                    第 {report.page} /{" "}
                    {Math.max(1, Math.ceil(report.total / report.pageSize))} 页
                    · 共 {report.total} 条
                  </span>
                  <div className="key-inline-actions">
                    <button
                      type="button"
                      className="outline-button"
                      disabled={loading || report.page <= 1}
                      onClick={() => setPage(report.page - 1)}
                    >
                      <ChevronLeft size={14} />
                      上一页
                    </button>
                    <button
                      type="button"
                      className="outline-button"
                      disabled={
                        loading || report.page * report.pageSize >= report.total
                      }
                      onClick={() => setPage(report.page + 1)}
                    >
                      下一页
                      <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
          <details className="key-usage-notes">
            <summary>
              统计说明
              <ChevronDown size={13} />
            </summary>
            <p className="small-note">
              统计自 {date(report.trackedSince)} 开始，旧请求无法补录。Token
              按上游已上报的数据汇总，“—”表示未上报，不按零用量计算；不估算费用。多轮模型调用分别计数，媒体任务轮询不重复计数。媒体用量按已返回文件数统计，不代表上游计费单位。
            </p>
          </details>
        </>
      )}
    </section>
  );
}
