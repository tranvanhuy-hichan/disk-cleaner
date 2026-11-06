#!/bin/bash
# Cài Disk Cleaner cho người dùng hiện tại (không cần root).
#   ./install.sh              cài / cập nhật
#   ./install.sh --uninstall  gỡ
set -euo pipefail

APP_ID=vn.makeai.DiskCleaner
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/disk-cleaner"
BIN="$HOME/.local/bin/disk-cleaner"
DESKTOP="$HOME/.local/share/applications/$APP_ID.desktop"
ICONS="$HOME/.local/share/icons/hicolor"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$BIN" "$DESKTOP" "$HOME/.config/autostart/$APP_ID.desktop" \
        "$ICONS/512x512/apps/$APP_ID.png" "$ICONS/scalable/apps/$APP_ID.svg"
  rm -rf "$DEST"
  echo "Đã gỡ Disk Cleaner (cài đặt của bạn vẫn còn ở ~/.config/disk-cleaner)."
  exit 0
fi

# Kiểm tra thư viện GTK trước khi cài để báo lỗi rõ ràng.
if ! /usr/bin/python3 -c "
import gi
gi.require_version('Gtk','4.0'); gi.require_version('Adw','1')
from gi.repository import Gtk, Adw
assert Adw.MINOR_VERSION >= 5 or Adw.MAJOR_VERSION > 1, 'libadwaita cũ'
" 2>/dev/null; then
  echo "Thiếu GTK4/libadwaita (cần libadwaita >= 1.5). Cài bằng:" >&2
  echo "  sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1" >&2
  exit 1
fi

mkdir -p "$DEST/bin" "$DEST/data" "$(dirname "$BIN")" "$(dirname "$DESKTOP")"
rm -rf "$DEST/diskcleaner" "$DEST/data/icons"
cp -r "$SRC/diskcleaner" "$DEST/diskcleaner"
find "$DEST/diskcleaner" -name __pycache__ -type d -prune -exec rm -rf {} +
cp -r "$SRC/data/icons" "$DEST/data/icons"
install -m 755 "$SRC/bin/disk-cleaner" "$DEST/bin/disk-cleaner"
ln -sf "$DEST/bin/disk-cleaner" "$BIN"

mkdir -p "$ICONS/512x512/apps" "$ICONS/scalable/apps"
cp "$SRC/data/icons/hicolor/512x512/apps/$APP_ID.png" "$ICONS/512x512/apps/"
cp "$SRC/data/icons/hicolor/scalable/apps/$APP_ID.svg" "$ICONS/scalable/apps/"
sed "s|@EXEC@|$BIN|" "$SRC/data/$APP_ID.desktop" > "$DESKTOP"

command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -f -t "$ICONS" || true
command -v update-desktop-database >/dev/null && update-desktop-database -q "$(dirname "$DESKTOP")" || true

echo "Đã cài Disk Cleaner. Mở từ menu ứng dụng hoặc chạy: disk-cleaner"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Lưu ý: ~/.local/bin chưa nằm trong PATH." ;; esac
