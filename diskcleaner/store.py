"""Cài đặt và thống kê, lưu ở ~/.config/disk-cleaner/settings.json."""
import json
import os
import time

DEFAULTS = {
    'trash_large': True, 'min_mb': 5, 'large_mb': 200, 'scan_large': True, 'dup_scan': True, 'dup_mb': 10,
    'background': False, 'remind_days': 7,
    'ignored': [], 'ignored_titles': {}, 'total_freed': 0, 'clean_count': 0,
    'last_scan': None, 'first_run': None, 'last_remind': 0,
}


def _path():
    base = os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config')
    return os.path.join(base, 'disk-cleaner', 'settings.json')


class Store(dict):
    def __init__(self):
        super().__init__(DEFAULTS)
        try:
            with open(_path(), encoding='utf-8') as f:
                self.update({k: v for k, v in json.load(f).items() if k in DEFAULTS})
        except (OSError, ValueError):
            pass
        if not self['first_run']:
            self['first_run'] = time.time()
            self.save()

    def save(self):
        p = _path()
        try:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            tmp = p + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(self, f, ensure_ascii=False)
            os.replace(tmp, p)  # ghi nguyên tử để không hỏng file nếu bị tắt giữa chừng
        except OSError:
            pass
