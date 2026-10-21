<?php
// 临时检查（用后即删）
define('WP_USE_THEMES', false);
require '/srv/www/htdocs/nginx/blog/wp-load.php';
$active = get_option('active_plugins');
echo "active plugins: ";
print_r($active);
$has_head = has_action('wp_head', 'get_chuncai');
echo "get_chuncai on wp_head: ";
var_dump($has_head);
