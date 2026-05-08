// sage-infra dashboard — fetches /index.json (relative to origin) and renders.

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
    charts: {},
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
      for (const d of this.docs) {           // docs are sorted desc by commit_timestamp
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

    renderCharts() {
      for (const ds of this.datasets) this.renderDatasetCharts(ds);
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

    renderDatasetCharts(ds) {
      const series = this.docs
        .filter(r => r.dataset === ds && r.exit_code === 0)
        .slice()
        .sort((a, b) => (a.commit_timestamp || '').localeCompare(b.commit_timestamp || ''));

      const points = (key) => series.map(r => ({
        x: new Date(r.commit_timestamp || r.started_at),
        y: r[key],
        commit: r.commit_short,
        message: r.commit_message,
        commitUrl: r.commit_url,
      }));

      this.makeChart(`chart-psms-${ds}`, 'PSMs (1% FDR)', points('psms'));
      this.makeChart(`chart-time-${ds}`, 'runtime (s)',   points('duration_seconds'));
      this.makeChart(`chart-mem-${ds}`,  'peak RSS (GB)', points('peak_memory_kb').map(p => ({ ...p, y: p.y / 1024 / 1024 })));
    },

    makeChart(canvasId, label, data) {
      const canvas = document.getElementById(canvasId);
      if (!(canvas instanceof HTMLCanvasElement)) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      if (this.charts[canvasId]) this.charts[canvasId].destroy();
      try {
        this.charts[canvasId] = new Chart(ctx, {
          type: 'line',
          data: { datasets: [{ label, data, borderWidth: 2, tension: 0.2, pointRadius: 3 }] },
          options: {
            responsive: true, maintainAspectRatio: false,
            parsing: false,
            scales: {
              x: { type: 'time', time: { tooltipFormat: 'PPpp' } },
              y: { beginAtZero: false },
            },
            plugins: {
              tooltip: {
                callbacks: {
                  title: (items) => items[0].raw.commit + ' — ' + (items[0].raw.message || ''),
                  label: (item) => `${item.dataset.label}: ${fmtNumber(item.parsed.y)}`,
                },
              },
              legend: { display: true, position: 'top' },
            },
            onClick: (_e, els) => {
              if (!els.length) return;
              const p = els[0].element.$context.raw;
              if (p?.commitUrl) window.open(p.commitUrl, '_blank');
            },
          },
        });
      } catch (e) {
        console.warn(`failed to render chart ${canvasId}`, e);
      }
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

function fmtNumber(v) { return typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v; }
