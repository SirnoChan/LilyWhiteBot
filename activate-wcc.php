<?php
// 临时脚本：激活 weichuncai 插件（用后即删）
define('WP_USE_THEMES', false);
require '/srv/www/htdocs/nginx/blog/wp-load.php';
$active = get_option('active_plugins');
if (!in_array('weichuncai/sm-weichuncai.php', $active)) {
    $active[] = 'weichuncai/sm-weichuncai.php';
    update_option('active_plugins', $active);
}
print_r(get_option('active_plugins'));
