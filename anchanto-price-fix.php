<?php
/**
 * Plugin Name:  Anchanto Price Fix
 * Description:  Sanitizes regular_price from Anchanto before WooCommerce sync, logs errors, retries failed syncs, and provides a live admin dashboard.
 * Version:      2.0.0
 * Author:       Your Store
 * Text Domain:  anchanto-price-fix
 * Requires at least: 5.8
 * Requires PHP: 7.4
 */

defined( 'ABSPATH' ) || exit;

class Anchanto_Price_Fix {

    /* ── Constants ─────────────────────────────────────────────────────── */
    const VERSION      = '2.0.0';
    const LOG_OPTION   = 'anchanto_price_fix_log';       // stores last 200 entries
    const RETRY_OPTION = 'anchanto_price_fix_retry_queue';
    const STATS_OPTION = 'anchanto_price_fix_stats';
    const MAX_RETRIES  = 3;
    const MAX_LOG      = 200;

    /* ── Boot ───────────────────────────────────────────────────────────── */
    public function __construct() {
        // WooCommerce REST API hooks
        add_filter( 'woocommerce_rest_pre_insert_product_object',
                    [ $this, 'sanitize_product_price' ], 10, 2 );
        add_filter( 'woocommerce_rest_pre_insert_product_variation_object',
                    [ $this, 'sanitize_variation_price' ], 10, 2 );
        add_filter( 'woocommerce_rest_product_object_save_errors',
                    [ $this, 'handle_save_error' ], 10, 3 );

        // WP-Cron retry job
        add_action( 'anchanto_price_fix_retry_event', [ $this, 'process_retry_queue' ] );
        if ( ! wp_next_scheduled( 'anchanto_price_fix_retry_event' ) ) {
            wp_schedule_event( time(), 'hourly', 'anchanto_price_fix_retry_event' );
        }

        // Admin
        add_action( 'admin_menu',    [ $this, 'add_admin_menu' ] );
        add_action( 'admin_enqueue_scripts', [ $this, 'enqueue_assets' ] );
        add_action( 'admin_notices', [ $this, 'admin_notice' ] );

        // AJAX endpoints (logged-in users only)
        add_action( 'wp_ajax_anchanto_get_dashboard', [ $this, 'ajax_get_dashboard' ] );
        add_action( 'wp_ajax_anchanto_retry_now',     [ $this, 'ajax_retry_now' ] );
        add_action( 'wp_ajax_anchanto_retry_sku',     [ $this, 'ajax_retry_sku' ] );
        add_action( 'wp_ajax_anchanto_clear_queue',   [ $this, 'ajax_clear_queue' ] );
        add_action( 'wp_ajax_anchanto_clear_log',     [ $this, 'ajax_clear_log' ] );
        add_action( 'wp_ajax_anchanto_test_price',    [ $this, 'ajax_test_price' ] );
        add_action( 'wp_ajax_anchanto_dismiss_sku',   [ $this, 'ajax_dismiss_sku' ] );
    }

    /* ══════════════════════════════════════════════════════════════════════
     *  1 · PRICE SANITISATION
     * ══════════════════════════════════════════════════════════════════════ */

    public function sanitize_product_price( $product, $request ) {
        if ( isset( $request['regular_price'] ) ) {
            $raw   = $request['regular_price'];
            $clean = $this->clean_price( $raw );
            $product->set_regular_price( $clean );

            if ( isset( $request['sale_price'] ) && $request['sale_price'] !== '' ) {
                $product->set_sale_price( $this->clean_price( $request['sale_price'] ) );
            }

            if ( $raw !== $clean ) {
                $this->log( 'sanitized', sprintf(
                    'Product "%s" (SKU: %s) — raw: "%s" → clean: "%s"',
                    $product->get_name(),
                    $product->get_sku() ?: 'n/a',
                    $raw, $clean
                ) );
                $this->increment_stat( 'sanitized' );
            }
        }
        return $product;
    }

    public function sanitize_variation_price( $variation, $request ) {
        if ( isset( $request['regular_price'] ) ) {
            $raw   = $request['regular_price'];
            $clean = $this->clean_price( $raw );
            $variation->set_regular_price( $clean );

            if ( $raw !== $clean ) {
                $this->log( 'sanitized', sprintf(
                    'Variation ID %d — raw: "%s" → clean: "%s"',
                    $variation->get_id(), $raw, $clean
                ) );
                $this->increment_stat( 'sanitized' );
            }
        }
        return $variation;
    }

    /* ══════════════════════════════════════════════════════════════════════
     *  2 · ERROR HANDLING & RETRY QUEUE
     * ══════════════════════════════════════════════════════════════════════ */

    public function handle_save_error( $error, $product, $request ) {
        if ( ! is_wp_error( $error ) ) return $error;

        $sku     = isset( $request['sku'] ) ? sanitize_text_field( $request['sku'] ) : 'unknown';
        $message = $error->get_error_message();

        $this->log( 'error', sprintf(
            'SKU: %s | %s | Price sent: "%s"',
            $sku, $message, $request['regular_price'] ?? 'N/A'
        ) );
        $this->increment_stat( 'errors' );

        if ( stripos( $message, 'regular_price' ) !== false || stripos( $message, 'price' ) !== false ) {
            $this->add_to_retry_queue( $sku, (array) $request );
        }

        return $error;
    }

    public function process_retry_queue() {
        $queue = get_option( self::RETRY_OPTION, [] );
        if ( empty( $queue ) ) return;

        $remaining = [];

        foreach ( $queue as $item ) {
            $sku     = $item['sku'];
            $request = $item['request'];
            $retries = (int) ( $item['retries'] ?? 0 );

            if ( $retries >= self::MAX_RETRIES ) {
                $this->log( 'abandoned', "SKU: {$sku} — exceeded max retries (" . self::MAX_RETRIES . ")." );
                $this->increment_stat( 'abandoned' );
                continue;
            }

            $product_id = wc_get_product_id_by_sku( $sku );

            if ( ! $product_id ) {
                $this->log( 'warning', "SKU: {$sku} — product not found in WooCommerce, skipping." );
                continue;
            }

            $product = wc_get_product( $product_id );
            if ( ! $product ) {
                $remaining[] = $item;
                continue;
            }

            $clean_price = $this->clean_price( $request['regular_price'] ?? '' );
            $product->set_regular_price( $clean_price );
            $result = $product->save();

            if ( $result ) {
                $this->log( 'success', "SKU: {$sku} — price set to {$clean_price} on attempt " . ( $retries + 1 ) . "." );
                $this->increment_stat( 'synced' );
            } else {
                $this->log( 'error', "SKU: {$sku} — retry attempt " . ( $retries + 1 ) . " failed." );
                $item['retries'] = $retries + 1;
                $remaining[]     = $item;
            }
        }

        update_option( self::RETRY_OPTION, $remaining );
    }

    /* ══════════════════════════════════════════════════════════════════════
     *  3 · AJAX HANDLERS
     * ══════════════════════════════════════════════════════════════════════ */

    private function verify_ajax() {
        if ( ! current_user_can( 'manage_woocommerce' ) ) wp_die( 'Forbidden', 403 );
        check_ajax_referer( 'anchanto_nonce', 'nonce' );
    }

    /** Full dashboard payload */
    public function ajax_get_dashboard() {
        $this->verify_ajax();

        $stats = get_option( self::STATS_OPTION, $this->default_stats() );
        $queue = get_option( self::RETRY_OPTION, [] );
        $log   = get_option( self::LOG_OPTION, [] );

        // Next cron time
        $next_cron = wp_next_scheduled( 'anchanto_price_fix_retry_event' );
        $next_str  = $next_cron
            ? human_time_diff( time(), $next_cron ) . ' from now'
            : 'Not scheduled';

        // WooCommerce + PHP versions
        $wc_version  = defined( 'WC_VERSION' ) ? WC_VERSION : 'N/A';
        $php_version = PHP_VERSION;

        // Log file writable?
        $log_writable = is_writable( WP_CONTENT_DIR );

        wp_send_json_success( [
            'stats'       => $stats,
            'queue'       => array_values( $queue ),
            'log'         => array_slice( array_reverse( $log ), 0, 100 ),
            'status'      => [
                'wc_version'   => $wc_version,
                'php_version'  => $php_version,
                'log_writable' => $log_writable,
                'cron_active'  => (bool) $next_cron,
                'next_cron'    => $next_str,
                'max_retries'  => self::MAX_RETRIES,
                'queue_count'  => count( $queue ),
                'plugin_ver'   => self::VERSION,
            ],
        ] );
    }

    /** Run retry queue immediately */
    public function ajax_retry_now() {
        $this->verify_ajax();
        $this->process_retry_queue();
        wp_send_json_success( [ 'message' => 'Retry job completed.' ] );
    }

    /** Retry a single SKU */
    public function ajax_retry_sku() {
        $this->verify_ajax();
        $sku   = sanitize_text_field( $_POST['sku'] ?? '' );
        $queue = get_option( self::RETRY_OPTION, [] );
        $found = false;

        foreach ( $queue as &$item ) {
            if ( $item['sku'] === $sku ) {
                $item['retries'] = 0; // reset so it retries immediately
                $found = true;
                break;
            }
        }
        unset( $item );

        if ( $found ) {
            update_option( self::RETRY_OPTION, $queue );
            $this->process_retry_queue();
            wp_send_json_success( [ 'message' => "Retry triggered for {$sku}." ] );
        } else {
            wp_send_json_error( [ 'message' => "SKU {$sku} not found in queue." ] );
        }
    }

    /** Dismiss/remove a single SKU from queue */
    public function ajax_dismiss_sku() {
        $this->verify_ajax();
        $sku   = sanitize_text_field( $_POST['sku'] ?? '' );
        $queue = get_option( self::RETRY_OPTION, [] );
        $queue = array_values( array_filter( $queue, fn( $i ) => $i['sku'] !== $sku ) );
        update_option( self::RETRY_OPTION, $queue );
        wp_send_json_success( [ 'message' => "SKU {$sku} dismissed." ] );
    }

    /** Clear entire retry queue */
    public function ajax_clear_queue() {
        $this->verify_ajax();
        update_option( self::RETRY_OPTION, [] );
        wp_send_json_success( [ 'message' => 'Retry queue cleared.' ] );
    }

    /** Clear log */
    public function ajax_clear_log() {
        $this->verify_ajax();
        update_option( self::LOG_OPTION, [] );
        wp_send_json_success( [ 'message' => 'Log cleared.' ] );
    }

    /** Live price sanitizer test */
    public function ajax_test_price() {
        $this->verify_ajax();
        $raw    = sanitize_text_field( $_POST['price'] ?? '' );
        $clean  = $this->clean_price( $raw );
        $changed = ( $raw !== $clean );

        $notes = [];
        if ( $raw === '' || strtolower( $raw ) === 'null' ) {
            $notes[] = 'Empty / null → defaulted to 0.00';
        }
        if ( preg_match( '/[^\d.,]/', $raw ) ) {
            $notes[] = 'Non-numeric characters stripped';
        }
        if ( strpos( $raw, ',' ) !== false ) {
            $notes[] = 'Comma treated as decimal separator';
        }

        wp_send_json_success( [
            'raw'     => $raw,
            'clean'   => $clean,
            'changed' => $changed,
            'notes'   => $notes,
        ] );
    }

    /* ══════════════════════════════════════════════════════════════════════
     *  4 · ADMIN MENU & ASSETS
     * ══════════════════════════════════════════════════════════════════════ */

    public function add_admin_menu() {
        add_menu_page(
            'Anchanto Price Fix',
            'Anchanto Fix',
            'manage_woocommerce',
            'anchanto-price-fix',
            [ $this, 'render_admin_page' ],
            'dashicons-money-alt',
            58
        );
    }

    public function enqueue_assets( $hook ) {
        if ( $hook !== 'toplevel_page_anchanto-price-fix' ) return;

        wp_enqueue_style(
            'anchanto-dashboard',
            plugin_dir_url( __FILE__ ) . 'assets/dashboard.css',
            [], self::VERSION
        );
        wp_enqueue_script(
            'anchanto-dashboard',
            plugin_dir_url( __FILE__ ) . 'assets/dashboard.js',
            [ 'jquery' ], self::VERSION, true
        );
        wp_localize_script( 'anchanto-dashboard', 'anchantoData', [
            'ajaxUrl' => admin_url( 'admin-ajax.php' ),
            'nonce'   => wp_create_nonce( 'anchanto_nonce' ),
        ] );
    }

    public function render_admin_page() {
        echo '<div id="anchanto-app">
            <div class="apf-loading"><div class="apf-spinner"></div><span>Loading dashboard…</span></div>
        </div>';
    }

    public function admin_notice() {
        $screen = get_current_screen();
        if ( $screen && $screen->id === 'toplevel_page_anchanto-price-fix' ) return;

        $queue = get_option( self::RETRY_OPTION, [] );
        if ( empty( $queue ) ) return;
        $count = count( $queue );
        $url   = admin_url( 'admin.php?page=anchanto-price-fix' );
        echo '<div class="notice notice-warning is-dismissible">';
        echo "<p><strong>Anchanto Price Fix:</strong> {$count} product(s) queued for price sync retry. "
           . '<a href="' . esc_url( $url ) . '">View dashboard →</a></p>';
        echo '</div>';
    }

    /* ══════════════════════════════════════════════════════════════════════
     *  5 · HELPERS
     * ══════════════════════════════════════════════════════════════════════ */

    private function clean_price( $raw ) {
        if ( $raw === null || trim( (string) $raw ) === '' || strtolower( (string) $raw ) === 'null' ) {
            return '0.00';
        }
        $price = preg_replace( '/[^\d.,]/', '', (string) $raw );
        if ( strpos( $price, ',' ) !== false && strpos( $price, '.' ) !== false ) {
            $price = str_replace( '.', '', $price );
            $price = str_replace( ',', '.', $price );
        } elseif ( strpos( $price, ',' ) !== false ) {
            $price = str_replace( ',', '.', $price );
        }
        return number_format( (float) $price, 2, '.', '' );
    }

    private function add_to_retry_queue( $sku, array $request ) {
        $queue   = get_option( self::RETRY_OPTION, [] );
        // Avoid duplicates — update existing entry instead
        foreach ( $queue as &$item ) {
            if ( $item['sku'] === $sku ) {
                $item['request'] = $request;
                update_option( self::RETRY_OPTION, $queue );
                return;
            }
        }
        unset( $item );
        $queue[] = [
            'sku'     => $sku,
            'request' => $request,
            'retries' => 0,
            'added'   => current_time( 'mysql' ),
        ];
        update_option( self::RETRY_OPTION, $queue );
        $this->log( 'queued', "SKU: {$sku} added to retry queue." );
    }

    private function log( string $type, string $message ) {
        $entries   = get_option( self::LOG_OPTION, [] );
        $entries[] = [
            'type'    => $type,
            'message' => $message,
            'time'    => current_time( 'mysql' ),
        ];
        // Keep only the latest MAX_LOG entries
        if ( count( $entries ) > self::MAX_LOG ) {
            $entries = array_slice( $entries, - self::MAX_LOG );
        }
        update_option( self::LOG_OPTION, $entries );
    }

    private function increment_stat( string $key ) {
        $stats        = get_option( self::STATS_OPTION, $this->default_stats() );
        $today        = current_time( 'Y-m-d' );
        if ( ! isset( $stats['daily'][ $today ] ) ) {
            $stats['daily'][ $today ] = [ 'synced' => 0, 'errors' => 0, 'sanitized' => 0, 'abandoned' => 0 ];
        }
        $stats['total'][ $key ]        = ( $stats['total'][ $key ] ?? 0 ) + 1;
        $stats['daily'][ $today ][ $key ] = ( $stats['daily'][ $today ][ $key ] ?? 0 ) + 1;
        // Keep only last 14 days
        $stats['daily'] = array_slice( $stats['daily'], -14, null, true );
        update_option( self::STATS_OPTION, $stats );
    }

    private function default_stats(): array {
        return [
            'total' => [ 'synced' => 0, 'errors' => 0, 'sanitized' => 0, 'abandoned' => 0 ],
            'daily' => [],
        ];
    }
}

/* ── Activation / deactivation ─────────────────────────────────────────── */
register_activation_hook( __FILE__, function () {
    if ( ! wp_next_scheduled( 'anchanto_price_fix_retry_event' ) ) {
        wp_schedule_event( time(), 'hourly', 'anchanto_price_fix_retry_event' );
    }
} );

register_deactivation_hook( __FILE__, function () {
    wp_clear_scheduled_hook( 'anchanto_price_fix_retry_event' );
} );

new Anchanto_Price_Fix();
