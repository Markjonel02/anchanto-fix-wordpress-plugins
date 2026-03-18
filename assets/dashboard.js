/**
 * Anchanto Price Fix — Dashboard JS
 * All data is fetched live from WordPress/WooCommerce via AJAX.
 */
(function ($) {
  'use strict';

  const { ajaxUrl, nonce } = window.anchantoData;

  /* ── AJAX helper ─────────────────────────────────────────────────── */
  function apfAjax(action, data = {}) {
    return $.post(ajaxUrl, { action, nonce, ...data });
  }

  /* ── Toast ───────────────────────────────────────────────────────── */
  let toastTimer;
  function toast(msg, type = 'info') {
    let $t = $('#apf-toast');
    if (!$t.length) {
      $t = $('<div id="apf-toast" class="apf-toast"></div>').appendTo('body');
    }
    clearTimeout(toastTimer);
    $t.attr('class', `apf-toast ${type}`).text(msg).addClass('show');
    toastTimer = setTimeout(() => $t.removeClass('show'), 3000);
  }

  /* ── Render helpers ──────────────────────────────────────────────── */
  const TAG_LABELS = {
    success:   'SUCCESS',
    error:     'ERROR',
    warning:   'WARNING',
    sanitized: 'SANITIZED',
    queued:    'QUEUED',
    abandoned: 'ABANDONED',
  };

  function renderLog(log) {
    if (!log || !log.length) {
      return '<div class="apf-log-empty">No log entries yet. Logs appear here when products sync through Anchanto.</div>';
    }
    return log.map(e => `
      <div class="apf-log-row ${e.type}">
        <span class="apf-log-time">${e.time}</span>
        <span class="apf-log-tag">${TAG_LABELS[e.type] || e.type.toUpperCase()}</span>
        <span class="apf-log-msg">${escHtml(e.message)}</span>
      </div>`).join('');
  }

  function renderQueue(queue) {
    if (!queue || !queue.length) {
      return '<tr class="empty-row"><td colspan="5">✓ Queue is empty — all products are in sync</td></tr>';
    }
    return queue.map(item => {
      const retries = parseInt(item.retries, 10) || 0;
      const max = 3;
      const dots = [0, 1, 2].map(i =>
        `<div class="apf-adot ${i < retries ? 'used' : 'empty'}"></div>`
      ).join('');
      const chipClass = retries === 0 ? 'apf-chip-queued' :
                        retries >= max ? 'apf-chip-failed' : 'apf-chip-retrying';
      const chipLabel = retries === 0 ? 'queued' :
                        retries >= max ? 'failed' : 'retrying';
      const rawPrice = item.request && item.request.regular_price
        ? escHtml(String(item.request.regular_price))
        : '<span style="color:var(--text-3)">n/a</span>';
      return `
        <tr data-sku="${escAttr(item.sku)}">
          <td><span class="apf-sku">${escHtml(item.sku)}</span></td>
          <td>${escHtml(item.added || '—')}</td>
          <td>${rawPrice}</td>
          <td>
            <div class="apf-attempts">
              <div class="apf-dot-row">${dots}</div>
              <span class="apf-attempt-count">${retries}/${max}</span>
            </div>
          </td>
          <td>
            <span class="apf-chip ${chipClass}">${chipLabel}</span>
          </td>
          <td>
            <div class="apf-row-actions">
              <button class="apf-btn apf-btn-ghost apf-btn-sm js-retry-sku" data-sku="${escAttr(item.sku)}">↻ Retry</button>
              <button class="apf-btn apf-btn-danger apf-btn-sm js-dismiss-sku" data-sku="${escAttr(item.sku)}">✕</button>
            </div>
          </td>
        </tr>`;
    }).join('');
  }

  function renderChart(daily) {
    const days = Object.keys(daily).slice(-7);
    if (!days.length) {
      return '<p style="font-family:var(--mono);font-size:12px;color:var(--text-3);padding:20px 0">No activity data yet.</p>';
    }
    const maxVal = Math.max(1, ...days.map(d =>
      (daily[d].synced || 0) + (daily[d].errors || 0)
    ));
    const bars = days.map(d => {
      const s = daily[d].synced || 0;
      const e = daily[d].errors || 0;
      const sh = Math.max(3, Math.round((s / maxVal) * 100));
      const eh = Math.max(3, Math.round((e / maxVal) * 100));
      const label = d.slice(5); // MM-DD
      return `
        <div class="apf-bar-col">
          <div class="apf-bar-pair">
            <div class="apf-bar synced" style="height:${sh}px" data-tip="${s} synced"></div>
            <div class="apf-bar errors" style="height:${eh}px" data-tip="${e} errors"></div>
          </div>
          <div class="apf-bar-lbl">${label}</div>
        </div>`;
    }).join('');
    return `
      <div class="apf-chart-bars">${bars}</div>
      <div class="apf-legend">
        <div class="apf-legend-item"><div class="apf-legend-dot" style="background:var(--accent)"></div> Synced</div>
        <div class="apf-legend-item"><div class="apf-legend-dot" style="background:var(--error)"></div> Errors</div>
      </div>`;
  }

  function renderStatus(s) {
    const sv = (val, cls) => `<span class="apf-status-val ${cls}">${escHtml(String(val))}</span>`;
    const row = (key, val, cls = 'apf-sv-info') =>
      `<div class="apf-status-row"><span class="apf-status-key">${key}</span>${sv(val, cls)}</div>`;

    return `
      ${row('WooCommerce REST API', 'Connected ✓', 'apf-sv-ok')}
      ${row('WP-Cron Scheduler', s.cron_active ? 'Active ✓' : 'Not scheduled!', s.cron_active ? 'apf-sv-ok' : 'apf-sv-err')}
      ${row('Next Retry Job', s.next_cron, 'apf-sv-info')}
      ${row('Max Retries', s.max_retries + ' attempts', 'apf-sv-info')}
      ${row('Log Storage', s.log_writable ? 'Writable ✓' : 'Not writable!', s.log_writable ? 'apf-sv-ok' : 'apf-sv-err')}
      ${row('Items in Queue', s.queue_count, s.queue_count > 0 ? 'apf-sv-warn' : 'apf-sv-ok')}
      ${row('WooCommerce', 'v' + s.wc_version, 'apf-sv-info')}
      ${row('PHP', 'v' + s.php_version, 'apf-sv-ok')}
      ${row('Plugin Version', 'v' + s.plugin_ver, 'apf-sv-info')}`;
  }

  /* ── Build full dashboard HTML ───────────────────────────────────── */
  function buildDashboard(data) {
    const { stats, queue, log, status } = data;
    const t = stats.total;
    const daily = stats.daily || {};

    return `
    <div class="apf-wrap">

      <!-- Header -->
      <div class="apf-header">
        <div class="apf-brand">
          <div class="apf-brand-icon">⚡</div>
          <div>
            <div class="apf-brand-name"><em>Anchanto</em> Price Fix</div>
            <div class="apf-brand-sub">WooCommerce Sync Dashboard · v${escHtml(status.plugin_ver)}</div>
          </div>
        </div>
        <div class="apf-header-right">
          <div class="apf-pill"><div class="dot"></div> Plugin Active</div>
          <button class="apf-btn apf-btn-ghost" id="js-clear-log">🗑 Clear Log</button>
          <button class="apf-btn apf-btn-ghost" id="js-clear-queue">✕ Clear Queue</button>
          <button class="apf-btn apf-btn-primary" id="js-retry-now">↻ Retry Now</button>
        </div>
      </div>

      <!-- Stats -->
      <div class="apf-stats">
        <div class="apf-stat" data-clr="blue" style="animation-delay:.04s">
          <span class="apf-stat-icon">🔄</span>
          <div class="apf-stat-label">Total Synced</div>
          <div class="apf-stat-value">${t.synced || 0}</div>
          <div class="apf-stat-sub">Successful price updates</div>
        </div>
        <div class="apf-stat" data-clr="teal" style="animation-delay:.08s">
          <span class="apf-stat-icon">🔧</span>
          <div class="apf-stat-label">Auto-Fixed</div>
          <div class="apf-stat-value">${t.sanitized || 0}</div>
          <div class="apf-stat-sub">Prices sanitized automatically</div>
        </div>
        <div class="apf-stat" data-clr="orange" style="animation-delay:.12s">
          <span class="apf-stat-icon">⏳</span>
          <div class="apf-stat-label">In Queue</div>
          <div class="apf-stat-value">${queue.length}</div>
          <div class="apf-stat-sub">Next retry: ${escHtml(status.next_cron)}</div>
        </div>
        <div class="apf-stat" data-clr="error" style="animation-delay:.16s">
          <span class="apf-stat-icon">⚠️</span>
          <div class="apf-stat-label">Errors / Abandoned</div>
          <div class="apf-stat-value">${(t.errors || 0) + (t.abandoned || 0)}</div>
          <div class="apf-stat-sub">${t.abandoned || 0} exceeded max retries</div>
        </div>
      </div>

      <!-- Log + Queue -->
      <div class="apf-cols-2">
        <!-- Log -->
        <div class="apf-panel">
          <div class="apf-panel-head">
            <div class="apf-panel-title"><span class="ti">📋</span> Sync Error Log <span class="apf-panel-badge">${log.length} entries</span></div>
          </div>
          <div class="apf-panel-body">
            <div class="apf-log" id="apf-log-stream">
              ${renderLog(log)}
            </div>
          </div>
        </div>

        <!-- Queue -->
        <div class="apf-panel">
          <div class="apf-panel-head">
            <div class="apf-panel-title"><span class="ti">🔁</span> Retry Queue <span class="apf-panel-badge">${queue.length}</span></div>
          </div>
          <div class="apf-panel-body" style="overflow-x:auto">
            <table class="apf-table" id="apf-queue-table">
              <thead>
                <tr>
                  <th>SKU</th><th>Added</th><th>Raw Price</th>
                  <th>Attempts</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>${renderQueue(queue)}</tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Price Tester -->
      <div class="apf-panel" style="margin-bottom:20px;animation-delay:.1s">
        <div class="apf-panel-head">
          <div class="apf-panel-title"><span class="ti">🧪</span> Price Sanitizer Tester</div>
          <span style="font-family:var(--mono);font-size:11px;color:var(--text-3)">Test how any raw price will be cleaned before it syncs</span>
        </div>
        <div class="apf-tester-body">
          <div class="apf-tester-grid">
            <div>
              <label class="apf-field-label">Raw Price Input</label>
              <input class="apf-input" id="apf-price-input" type="text" placeholder='e.g. $10,99 · "29.00" · 1.200,50 · null'>
              <div class="apf-quick-tests">
                <span class="apf-quick-btn" data-val="$10,99">$10,99</span>
                <span class="apf-quick-btn" data-val="1.234,56">1.234,56</span>
                <span class="apf-quick-btn" data-val="USD 29.95">USD 29.95</span>
                <span class="apf-quick-btn" data-val="&quot;15.00&quot;">"15.00"</span>
                <span class="apf-quick-btn" data-val="">empty</span>
                <span class="apf-quick-btn" data-val="null">null</span>
                <span class="apf-quick-btn" data-val="€ 99,00">€ 99,00</span>
              </div>
            </div>
            <div>
              <label class="apf-field-label">Sanitized Output</label>
              <div class="apf-result" id="apf-result">
                <div class="apf-result-label">Enter a price to preview →</div>
                <div class="apf-result-value" id="apf-result-val" style="color:var(--text-3);font-size:16px">—</div>
                <div class="apf-result-notes" id="apf-result-notes"></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Chart + Status -->
      <div class="apf-cols-2b">
        <div class="apf-panel" style="animation-delay:.12s">
          <div class="apf-panel-head">
            <div class="apf-panel-title"><span class="ti">📊</span> Sync Activity (Last 7 Days)</div>
          </div>
          <div class="apf-chart-wrap" id="apf-chart">
            ${renderChart(daily)}
          </div>
        </div>

        <div class="apf-panel" style="animation-delay:.15s">
          <div class="apf-panel-head">
            <div class="apf-panel-title"><span class="ti">🔌</span> Plugin Status</div>
          </div>
          <div class="apf-status-list">
            ${renderStatus(status)}
          </div>
        </div>
      </div>

    </div><!-- /wrap -->
    `;
  }

  /* ── Escape helpers ──────────────────────────────────────────────── */
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escAttr(str) { return escHtml(str); }

  /* ── Load dashboard ──────────────────────────────────────────────── */
  function loadDashboard(showLoading = false) {
    if (showLoading) {
      $('#anchanto-app').html('<div class="apf-loading"><div class="apf-spinner"></div><span>Loading dashboard…</span></div>');
    }
    apfAjax('anchanto_get_dashboard')
      .done(res => {
        if (res.success) {
          $('#anchanto-app').html(buildDashboard(res.data));
          bindEvents();
          // Scroll log to bottom
          const $log = $('#apf-log-stream');
          $log.scrollTop($log[0].scrollHeight);
        } else {
          showError('Could not load dashboard data.');
        }
      })
      .fail(() => showError('AJAX request failed. Check your WordPress configuration.'));
  }

  function showError(msg) {
    $('#anchanto-app').html(`
      <div class="apf-wrap">
        <div style="padding:60px;text-align:center;font-family:var(--mono);font-size:13px;color:var(--error)">
          ⚠ ${escHtml(msg)}
        </div>
      </div>`);
  }

  /* ── Bind UI events ──────────────────────────────────────────────── */
  function bindEvents() {
    // Retry all
    $(document).on('click', '#js-retry-now', function () {
      const $btn = $(this).prop('disabled', true).text('Running…');
      apfAjax('anchanto_retry_now')
        .done(res => {
          if (res.success) { toast('↻ Retry job completed', 'success'); loadDashboard(); }
        })
        .always(() => $btn.prop('disabled', false).text('↻ Retry Now'));
    });

    // Clear queue
    $(document).on('click', '#js-clear-queue', function () {
      if (!confirm('Clear the entire retry queue? This cannot be undone.')) return;
      apfAjax('anchanto_clear_queue')
        .done(res => {
          if (res.success) { toast('Queue cleared', 'info'); loadDashboard(); }
        });
    });

    // Clear log
    $(document).on('click', '#js-clear-log', function () {
      if (!confirm('Clear all log entries?')) return;
      apfAjax('anchanto_clear_log')
        .done(res => {
          if (res.success) { toast('Log cleared', 'info'); loadDashboard(); }
        });
    });

    // Retry single SKU
    $(document).on('click', '.js-retry-sku', function () {
      const sku = $(this).data('sku');
      const $btn = $(this).prop('disabled', true).text('…');
      apfAjax('anchanto_retry_sku', { sku })
        .done(res => {
          if (res.success) {
            toast(`↻ Retried ${sku}`, 'success');
            loadDashboard();
          } else {
            toast(res.data.message || 'Error', 'error');
          }
        })
        .always(() => $btn.prop('disabled', false).text('↻ Retry'));
    });

    // Dismiss SKU
    $(document).on('click', '.js-dismiss-sku', function () {
      const sku = $(this).data('sku');
      apfAjax('anchanto_dismiss_sku', { sku })
        .done(res => {
          if (res.success) {
            toast(`✕ ${sku} dismissed`, 'info');
            $(`tr[data-sku="${sku}"]`).fadeOut(200, () => loadDashboard());
          }
        });
    });

    // Price tester — debounced live input
    let testTimer;
    $(document).on('input', '#apf-price-input', function () {
      clearTimeout(testTimer);
      const val = $(this).val();
      testTimer = setTimeout(() => runPriceTest(val), 320);
    });

    // Quick test buttons
    $(document).on('click', '.apf-quick-btn', function () {
      const val = $(this).data('val');
      $('#apf-price-input').val(val).trigger('input');
    });
  }

  /* ── Live price test ──────────────────────────────────────────────── */
  function runPriceTest(raw) {
    apfAjax('anchanto_test_price', { price: raw })
      .done(res => {
        if (!res.success) return;
        const d = res.data;
        const $box = $('#apf-result');
        const $val = $('#apf-result-val');
        const $notes = $('#apf-result-notes');

        $val.text(d.clean).css('color', 'var(--teal)').css('font-size', '26px');
        $box.removeClass('changed same').addClass(d.changed ? 'changed' : 'same');
        $box.find('.apf-result-label').text(d.changed ? `Converted from: "${raw}"` : 'Already valid — no change needed');

        $notes.html(d.notes.map(n =>
          `<div class="apf-result-note">${escHtml(n)}</div>`
        ).join(''));
      });
  }

  /* ── Auto-refresh every 30s ──────────────────────────────────────── */
  function startAutoRefresh() {
    setInterval(() => {
      // Only silently refresh log + queue, don't rebuild entire page
      apfAjax('anchanto_get_dashboard').done(res => {
        if (!res.success) return;
        const { log, queue, stats, status } = res.data;

        // Update log
        $('#apf-log-stream').html(renderLog(log));
        const $log = $('#apf-log-stream');
        $log.scrollTop($log[0].scrollHeight);

        // Update queue tbody
        $('#apf-queue-table tbody').html(renderQueue(queue));

        // Update stat values
        const t = stats.total;
        const vals = [t.synced || 0, t.sanitized || 0, queue.length, (t.errors || 0) + (t.abandoned || 0)];
        $('.apf-stat-value').each(function (i) { $(this).text(vals[i]); });

        // Update queue badge
        $('.apf-panel-badge').first().text(log.length + ' entries');
        $('.apf-panel-badge').eq(1).text(queue.length);

        // Re-bind row buttons
        bindEvents();
      });
    }, 30000);
  }

  /* ── Init ─────────────────────────────────────────────────────────── */
  $(document).ready(function () {
    if ($('#anchanto-app').length) {
      loadDashboard(false);
      startAutoRefresh();
    }
  });

})(jQuery);
