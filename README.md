# Disk Cleaner

Ứng dụng desktop (Electron) tìm và dọn rác trên đĩa cho Linux: `node_modules`, thư mục build, cache và dữ liệu Docker không dùng.

Giao diện chia hai nửa: bên trái là vòng tròn dung lượng ổ đĩa với con số "có thể dọn" đếm chạy lên, bên phải là danh sách rác theo nhóm.

## Quét được gì

| Nhóm | Ví dụ |
|---|---|
| Build / cài đặt trong project | `node_modules`, `.next`, `target` (Maven/Cargo), `bin`/`obj` (.NET), `.venv`, `.gradle` |
| Cache | npm, npx, pip, Playwright, Prisma, Electron, cache VS Code, thùng rác, các thư mục lớn trong `~/.cache` |
| Docker | build cache, image, container đã dừng, volume không dùng |
| Hệ thống | cache apt, journal. Cần root nên chỉ hiện lệnh để sao chép, app không tự chạy |

Mỗi mục có kèm cách tạo lại (ví dụ `npm install`) và được gắn nhãn:

- **An toàn**: cache, hoặc project đã lâu không hoạt động. Được chọn sẵn.
- **Xem lại**: project có hoạt động trong 14 ngày gần đây (theo commit git và thời gian sửa `package.json`), hoặc dữ liệu có thể mất như Docker volume, model đã tải. Không chọn sẵn.

## An toàn khi xoá

- Bấm **Quét máy** chỉ đọc, không xoá gì.
- Xoá phải qua hộp xác nhận liệt kê từng mục. Việc xoá là **vĩnh viễn** (không vào thùng rác), vì chuyển vào thùng rác thì không giải phóng được dung lượng.
- Giao diện chỉ gửi *id* của mục đã quét, không gửi đường dẫn. Tiến trình chính chỉ xoá những mục có trong lần quét gần nhất.
- Từ chối mọi đường dẫn nằm ngoài thư mục home.
- Chỉ nhận diện thư mục build khi có file dự án đi kèm (ví dụ `bin/` chỉ tính khi có `.csproj` cạnh nó), để không xoá nhầm thư mục trùng tên chứa mã nguồn thật.

## Chạy

```bash
npm install
npm start          # mở giao diện
npm run scan       # chỉ quét và in kết quả ra terminal, không mở giao diện
```

Hoặc dùng `./disk-cleaner.sh` (đường dẫn trong script đang trỏ tới thư mục trên máy tác giả, hãy sửa lại nếu clone về máy khác).

## Đóng gói AppImage

```bash
npm run dist       # tạo dist/DiskCleaner-<version>.AppImage
```

Chép file AppImage vào `~/Applications` và tạo file `.desktop` để có lối tắt trong menu ứng dụng. AppImage cần `libfuse2` (`sudo apt install libfuse2`).

## Cấu trúc

| File | Vai trò |
|---|---|
| `scanner.js` | Logic quét và dọn, dùng được độc lập qua `npm run scan` |
| `main.js` | Tiến trình chính Electron, cầu nối IPC |
| `preload.js` | Cầu nối an toàn giữa giao diện và tiến trình chính |
| `renderer/` | Giao diện (HTML, CSS, JS thuần) |
| `build/icon.png` | Icon ứng dụng |

## Hạn chế

- Chỉ quét thư mục home, chưa quét các phân vùng khác.
- Chưa gợi ý gỡ kernel cũ hay ứng dụng không dùng.
- Chỉ hỗ trợ Linux.
