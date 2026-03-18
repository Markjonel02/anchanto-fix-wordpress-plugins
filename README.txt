=== Anchanto Price Fix ===
Version: 2.0.0
Requires at least: WordPress 5.8, WooCommerce 6.0
Requires PHP: 7.4+

== INSTALLATION ==
1. Upload the entire `anchanto-price-fix` folder to /wp-content/plugins/
2. Activate the plugin from WP Admin → Plugins
3. Navigate to WP Admin → Anchanto Fix to view the live dashboard

== WHAT IT DOES ==
- Sanitizes all regular_price values from Anchanto before they hit WooCommerce
  • Strips currency symbols ($, €, £, USD, etc.)
  • Fixes comma decimals (10,99 → 10.99)
  • Handles thousands separators (1.234,56 → 1234.56)
  • Defaults empty/null prices to 0.00
- Logs every sanitization, error, retry, and success to the WordPress database
- Queues failed syncs for automatic hourly retry (max 3 attempts)
- Provides a live admin dashboard with real data (no fake entries)
  • Stat cards (synced, sanitized, queue, errors)
  • Live scrolling log stream (auto-refreshes every 30s)
  • Retry queue table with per-SKU retry and dismiss buttons
  • Price sanitizer tester — type any raw price to preview the output
  • 7-day activity chart
  • Plugin status panel (WP-Cron, WooCommerce version, PHP version, etc.)

== FILE STRUCTURE ==
anchanto-price-fix/
├── anchanto-price-fix.php   ← Main plugin file
├── assets/
│   ├── dashboard.css        ← Dashboard styles
│   └── dashboard.js         ← Dashboard logic (real AJAX, no fake data)
└── README.txt

== HOOKS USED ==
- woocommerce_rest_pre_insert_product_object
- woocommerce_rest_pre_insert_product_variation_object
- woocommerce_rest_product_object_save_errors
- WP-Cron: anchanto_price_fix_retry_event (hourly)

== DATA STORAGE ==
All data is stored in WordPress options:
- anchanto_price_fix_log         → Last 200 log entries
- anchanto_price_fix_retry_queue → Current retry queue
- anchanto_price_fix_stats       → Cumulative + daily stats

== PERMISSIONS ==
Dashboard requires the `manage_woocommerce` capability.
All AJAX calls are nonce-protected.
