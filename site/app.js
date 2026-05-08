// sage-infra dashboard — fetches /index.json (relative to origin) and renders.

const SVG_NS = 'http://www.w3.org/2000/svg';

function app() {
  return {
    docs: [],
    datasets: [],
    latestByDataset: {},
    sageRepo: 'lazear/sage',
    lastRefresh: '',
    tab: 'latest',
    sortKey: 'commit_timestamp',
    sortDir: 'desc',
    filterDataset: '',
    renderTimer: null,

    async init() {
      await this.load();
      this.$watch('tab', (v) => {
        if (v === 'history') this.scheduleRenderCharts();
      });
    },

    async load() {
      try {
        const res = await fetch('/index.json', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const docs = await res.json();
        this.docs = Array.isArray(docs) ? docs : [];
      } catch (e) {
        console.error('failed to load index.json', e);
        this.docs = [];
      }
      this.datasets = [...new Set(this.docs.map(d => d.dataset))].sort();
      const seen = new Map();
      for (const d of this.docs) { // docs are sorted desc by commit_timestamp
        if (!seen.has(d.dataset)) seen.set(d.dataset, d);
      }
      this.latestByDataset = Object.fromEntries(seen);
      const sample = this.docs[0];
      if (sample?.commit_url) {
        const m = sample.commit_url.match(/github\.com\/([^/]+\/[^/]+)\//);
        if (m) this.sageRepo = m[1];
      }
      this.lastRefresh = new Date().toLocaleString();
    },

    sortBy(key) {
      if (this.sortKey === key) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
      else { this.sortKey = key; this.sortDir = 'desc'; }
    },

    get tableRows() {
      let rows = this.docs.slice();
      if (this.filterDataset) rows = rows.filter(r => r.dataset === this.filterDataset);
      const k = this.sortKey, dir = this.sortDir === 'asc' ? 1 : -1;
      rows.sort((a, b) => {
        const va = a[k] ?? '', vb = b[k] ?? '';
        if (va === vb) return 0;
        return va > vb ? dir : -dir;
      });
      return rows;
    },

    scheduleRenderCharts() {
      if (this.renderTimer) cancelAnimationFrame(this.renderTimer);
      this.renderTimer = requestAnimationFrame(() => {
        this.renderTimer = requestAnimationFrame(() => {
          this.renderTimer = null;
          this.renderCharts();
        });
      });
    },

    renderCharts() {
      for (const ds of this.datasets) this.renderDatasetCharts(ds);
    },

    renderDatasetCharts(ds) {
      const series = this.docs
        .filter(r => r.dataset === ds && r.exit_code === 0)
        .slice()
        .sort((a, b) => (a.commit_timestamp || '').localeCompare(b.commit_timestamp || ''));

      const points = (key) => series
        .filter(r => r[key] != null)
        .map(r => ({
          x: new Date(r.commit_timestamp || r.started_at || Date.now()).getTime(),
          y: r[key],
          commit: r.commit_short,
          message: r.commit_message,
          commitUrl: r.commit_url,
        }));

      this.makeChart(`chart-psms-${ds}`, 'PSMs (1% FDR)', points('psms'), {
        yLabel: 'PSMs',
        formatY: fmtNumber,
      });
      this.makeChart(`chart-time-${ds}`, 'runtime (s)', points('duration_seconds'), {
        yLabel: 'seconds',
        formatY: (v) => fmtNumber(v),
      });
      this.makeChart(`chart-mem-${ds}`, 'peak RSS (GB)', points('peak_memory_kb').map(p => ({ ...p, y: p.y / 1024 / 1024 })), {
        yLabel: 'GB',
        formatY: (v) => fmtNumber(v),
      });
    },

    makeChart(containerId, label, data, opts = {}) {
      const container = document.getElementById(containerId);
      if (!container) return;

      container.replaceChildren();
      if (!data.length) {
        const empty = document.createElement('div');
        empty.className = 'chart-empty';
        empty.textContent = 'no data';
        container.appendChild(empty);
        return;
      }

      const width = container.clientWidth || 320;
      const height = container.clientHeight || 200;
      const pad = { top: 24, right: 14, bottom: 28, left: 44 };
      const innerW = Math.max(1, width - pad.left - pad.right);
      const innerH = Math.max(1, height - pad.top - pad.bottom);

      const xs = data.map(p => p.x);
      const ys = data.map(p => p.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const ySpan = maxY - minY || 1;
      const xSpan = maxX - minX || 1;

      const xScale = (x) => pad.left + ((x - minX) / xSpan) * innerW;
      const yScale = (y) => pad.top + innerH - ((y - minY) / ySpan) * innerH;

      const svg = el('svg', {
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': label,
      });

      svg.appendChild(el('rect', { x: 0, y: 0, width, height, fill: 'transparent' }));
      svg.appendChild(el('text', {
        x: pad.left,
        y: 16,
        fill: 'currentColor',
        class: 'chart-title',
      }, label));

      // Grid and axis labels.
      const yTicks = 4;
      for (let i = 0; i <= yTicks; i += 1) {
        const t = i / yTicks;
        const y = pad.top + innerH - t * innerH;
        const val = minY + t * ySpan;
        svg.appendChild(el('line', {
          x1: pad.left,
          y1: y,
          x2: width - pad.right,
          y2: y,
          class: 'chart-grid',
        }));
        svg.appendChild(el('text', {
          x: pad.left - 8,
          y: y + 4,
          'text-anchor': 'end',
          class: 'chart-axis-label',
        }, opts.formatY ? opts.formatY(val) : fmtNumber(val)));
      }

      const xTicks = Math.min(4, data.length - 1);
      for (let i = 0; i <= xTicks; i += 1) {
        const t = xTicks === 0 ? 0 : i / xTicks;
        const x = pad.left + t * innerW;
        const idx = Math.round(t * (data.length - 1));
        const point = data[idx];
        const labelText = new Date(point.x).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: '2-digit',
        });
        svg.appendChild(el('line', {
          x1: x,
          y1: pad.top,
          x2: x,
          y2: height - pad.bottom,
          class: 'chart-grid',
        }));
        svg.appendChild(el('text', {
          x,
          y: height - 8,
          'text-anchor': 'middle',
          class: 'chart-axis-label',
        }, labelText));
      }

      const pathData = data.map((p, i) => `${i ? 'L' : 'M'} ${xScale(p.x)} ${yScale(p.y)}`).join(' ');
      svg.appendChild(el('path', {
        d: pathData,
        class: 'chart-line',
      }));

      for (const point of data) {
        svg.appendChild(el('circle', {
          cx: xScale(point.x),
          cy: yScale(point.y),
          r: 3.2,
          class: 'chart-point',
        }));
      }

      container.appendChild(svg);
    },

    fmt(v) { return v == null ? '—' : v.toLocaleString(); },
    fmtDuration(s) { if (s == null) return '—'; if (s < 60) return s.toFixed(1) + 's'; const m = Math.floor(s/60), r = Math.round(s%60); return `${m}m ${r}s`; },
    fmtMem(kb) { if (kb == null) return '—'; const gb = kb/1024/1024; return gb.toFixed(2) + ' GB'; },
    fmtDate(s) { if (!s) return '—'; const d = new Date(s); return d.toLocaleString(); },
    statusText(run) {
      if (run?.missing_result) return 'MISSING';
      if (run?.exit_code === 0) return 'OK';
      return run?.exit_code == null ? 'FAILED' : `FAILED (${run.exit_code})`;
    },
  };
}

function el(tag, attrs, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v != null) node.setAttribute(k, String(v));
  }
  if (text != null) node.textContent = text;
  return node;
}

function fmtNumber(v) {
  return typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v;
}
