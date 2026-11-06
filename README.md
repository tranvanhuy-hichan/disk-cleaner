# Disk Cleaner

Ứng dụng desktop (GTK4 + libadwaita, Python) tìm và dọn rác trên đĩa Linux: thư mục build, cache, Docker, tệp lớn, tệp trùng lặp.

## Cài đặt

Cần GNOME/GTK4 với libadwaita >= 1.5 (Ubuntu 24.04 trở lên có sẵn). Nếu thiếu:

```bash
sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1
```

```bash
./install.sh              # cài cho người dùng hiện tại, không cần root
./install.sh --uninstall  # gỡ
```

Sau khi cài, mở "Disk Cleaner" từ menu ứng dụng hoặc chạy `disk-cleaner`. Chạy thẳng từ mã nguồn: `./bin/disk-cleaner`.

> App chạy bằng `/usr/bin/python3` (Python của hệ thống), vì thư viện `gi` nằm ở đó chứ không có trong pyenv/venv.

## Tìm những gì

| Nhóm | Gồm |
|---|---|
| Build / cài đặt trong project | `node_modules`, `.next`, `target` (Maven/Cargo), `bin`/`obj` (.NET), `.venv`, `.gradle` |
| Cache | npm, npx, pip, Yarn, pnpm, Gradle, Maven, Cargo, Playwright, Prisma, Electron, thumbnails, Chrome/Firefox, Hugging Face, PyTorch, VS Code, thùng rác, các thư mục lớn trong `~/.cache` |
| Docker | build cache, image, container đã dừng, volume không dùng |
| Tệp lớn | 40 tệp lớn nhất trong home (mặc định từ 200 MB), bỏ qua thư mục ẩn |
| Tệp trùng lặp | So theo kích thước, hash 64 KB đầu, rồi hash toàn bộ. Luôn giữ bản cũ nhất. Bỏ qua bản sao trong `dist/`, `build/`, `site-packages` |
| Hệ thống | cache apt, journal. Chạy qua `pkexec` (polkit) và hiện hộp thoại mật khẩu; chỉ hai lệnh cố định `apt-get clean` và `journalctl --vacuum-size=100M` |

Mỗi mục kèm cách tạo lại (ví dụ `npm install`) và nhãn:

- **An toàn**: cache, hoặc project đã lâu không hoạt động. Được chọn sẵn (trừ mục cần root).
- **Xem lại**: project có hoạt động trong 14 ngày gần đây (theo git và thời gian sửa `package.json`), hoặc dữ liệu có thể mất như Docker volume, model đã tải, tệp lớn, tệp trùng. Không chọn sẵn.

## Tính năng

- **Dung lượng thư mục**: tab treemap, bấm vào ô để đào sâu, chuột phải để mở trong trình quản lý tệp.
- **Xuất CSV**: danh sách đang hiển thị (theo bộ lọc), mở được bằng Excel.
- **Chạy nền**: trong Cài đặt, bật biểu tượng khay hệ thống, tự khởi động cùng máy và nhắc dọn sau N ngày. Cần tiện ích AppIndicator của GNOME (Ubuntu bật sẵn).
- Tìm kiếm (Ctrl+F), lọc theo mức độ, sắp xếp, chọn cả nhóm, ẩn mục không muốn thấy nữa, huỷ quét.

## An toàn khi xoá

- Bấm **Quét máy** chỉ đọc, không xoá gì.
- Xoá phải qua hộp xác nhận liệt kê từng mục. Cache và thư mục build bị xoá **vĩnh viễn** (chuyển vào thùng rác thì không giải phóng dung lượng). Tệp lớn và tệp trùng mặc định vào thùng rác (tắt được trong Cài đặt).
- Từ chối mọi đường dẫn nằm ngoài thư mục home.
- Chỉ nhận diện thư mục build khi có file dự án đi kèm (ví dụ `bin/` chỉ tính khi có `.csproj` cạnh nó), để không xoá nhầm thư mục trùng tên chứa mã nguồn thật.
- Lệnh chạy bằng quyền root và lệnh Docker là các lệnh cố định trong mã, không nhận gì từ bên ngoài.

## Phát triển

```bash
./bin/disk-cleaner                          # chạy giao diện
/usr/bin/python3 -m diskcleaner scan        # chỉ quét và in kết quả ra terminal
/usr/bin/python3 -m unittest discover -s tests -v
```

| Đường dẫn | Vai trò |
|---|---|
| `diskcleaner/scanner.py` | Logic quét, dọn, xuất CSV. Không phụ thuộc GTK |
| `diskcleaner/app.py` | Cửa sổ chính, cài đặt, luồng quét/dọn |
| `diskcleaner/widgets.py` | Vòng tròn dung lượng và treemap tự vẽ (cairo) |
| `diskcleaner/layout.py` | Thuật toán squarified treemap |
| `diskcleaner/tray.py` | Khay hệ thống qua D-Bus (StatusNotifierItem + dbusmenu), không cần GTK3 |
| `diskcleaner/store.py` | Cài đặt và thống kê, lưu ở `~/.config/disk-cleaner/settings.json` |
| `data/` | Icon và file `.desktop` |

## Hạn chế

- Chỉ Linux, nhắm tới GNOME. Trên shell không hỗ trợ khay thì tính năng chạy nền không hiện biểu tượng.
- Cache `~/.cache` ngoài danh sách có sẵn chỉ được liệt kê khi lớn hơn 200 MB và luôn ở mức "Xem lại".
- Mục `bin`/`obj` của .NET chỉ nhận diện qua file `.csproj`.
