# Xưởng Caffe

## Ý tưởng

Xưởng Caffe là web game dành cho khách tại quán. Khách quét mã QR đặt trên bàn để mở web trên điện thoại. Màn hình chính là sơ đồ quán nhìn từ trên xuống, hiển thị vị trí bàn của khách và những bàn đang có người tham gia.

## Tính năng dự kiến

1. **Vào quán bằng QR.** Mỗi bàn có một mã riêng. Sau khi quét lần đầu, khách nhập tên hiển thị, chọn mẫu nhân vật và phối áo, quần, giày. Nhân vật xuất hiện ở bàn đã quét khi khách bấm **Bước vào phòng**.
2. **Chat làm quen.** Khách chọn một bàn đang online trên sơ đồ để bắt đầu trò chuyện.
3. **Mời chơi caro.** Khách gửi lời mời đến bàn khác. Khi lời mời được chấp nhận, hai bên vào ván trên web. Server kiểm tra lượt chơi và ô đánh, rồi gửi nước đi cho hai bên. Khi điện thoại kết nối lại, web lấy trạng thái ván từ server.
4. **Nhật ký ảnh cá nhân tại Xưởng.** Mỗi khách có album riêng tư để chụp hoặc tải ảnh kỷ niệm kèm ghi chú ngắn, tự động gắn vị trí bàn/ngày ghé, đánh dấu yêu thích, xem toàn màn hình và tải ảnh về máy.
5. **Xếp hình trượt ô (1 người chơi).** Khách chọn 1 trong 3 bức tranh thiên nhiên hoạt họa có sẵn hoặc lấy ảnh cá nhân từ thiết bị / Nhật ký, chia thành khung `3×3`, `4×4` hoặc `5×5` (trống 1 ô ở góc) để trượt ô ghép lại tranh hoàn chỉnh. Tiến độ chơi dở và kỷ lục cá nhân được lưu ngay trên trình duyệt.

## Công nghệ đề xuất

| Phần | Công nghệ | Vai trò |
| --- | --- | --- |
| Giao diện | React + Vite | Sơ đồ quán, chat, bàn cờ và nhật ký. Build thành file tĩnh để Caddy phục vụ. |
| Backend | Node.js LTS + Fastify + TypeScript | Xác thực mã QR, quản lý phiên theo bàn, xử lý nhật ký và luật caro. |
| Thời gian thực | Socket.IO | Cập nhật trạng thái online, gửi tin nhắn, lời mời và nước cờ. Mỗi cuộc chat hoặc ván cờ có một phòng riêng. |
| Cơ sở dữ liệu | SQLite bật WAL | Lưu dữ liệu bàn, hồ sơ nhân vật và nhật ký trên ổ đĩa VPS. SQLite chạy trong ứng dụng. |
| Vận hành | Caddy + systemd | Caddy phục vụ giao diện qua HTTPS và chuyển tiếp API, WebSocket. systemd quản lý tiến trình Node.js. |

## Lưu trữ và triển khai

- Bản đầu dự kiến phục vụ một quán với một tiến trình Node.js trên một VPS Linux.
- Giữ trạng thái online và lời mời đang chờ trong RAM. Lưu dữ liệu bàn và nhật ký vào SQLite, rồi sao lưu định kỳ ra ngoài VPS.
- Nếu cần tiếp tục ván sau khi VPS khởi động lại, lưu từng nước đi vào SQLite.
- Cấu hình khởi điểm để thử tải là **1 vCPU, 2 GB RAM và ổ SSD**. Đo CPU, RAM và độ trễ chat, nước cờ ở mức khách đồng thời dự kiến.
- Cân nhắc PostgreSQL khi thao tác ghi đồng thời gây nghẽn hoặc khi cần chạy ứng dụng trên nhiều VPS.

## Chạy dự án

Dùng Node.js 24 LTS và npm. Trên Windows, có thể dùng `npm.cmd` nếu PowerShell chặn `npm.ps1`.

```sh
npm ci
npm run dev
```

Trang khách chạy tại `http://localhost:5173`. Mở `http://localhost:5173/admin` và đăng nhập bằng `XUONG_ADMIN_PASSWORD` trong `.env`. Nếu chưa có `.env`, sao chép `.env.example` thành `.env` và đặt mật khẩu riêng. Vite chuyển yêu cầu API và Socket.IO sang Node.js, mặc định ở cổng 3000.

Để dùng bản production trên máy đang chạy dự án:

```sh
npm run build
npm start
```

Node.js phục vụ trang khách, `/admin`, API và Socket.IO tại `http://127.0.0.1:3000` theo cấu hình mặc định.

## Thử luồng QR và sơ đồ

1. Đăng nhập tại `/admin`, chọn bàn rồi mở **Mã QR**. Sao chép liên kết để thử trên cùng máy, hoặc tải PNG để in khi đã chạy trên tên miền của quán.
2. Mở liên kết ở hai hồ sơ trình duyệt riêng để thử hai bàn. Tạo nhân vật và bấm **Bước vào phòng**. Số bàn, dấu **Bạn đang ở đây** và nhân vật xuất hiện trên sơ đồ. Bấm số bàn ở đầu trang để chỉnh lại tên và trang phục. Hồ sơ đã lưu được dùng lại trên cùng trình duyệt.
3. Trong admin, kéo bàn để dời cả cụm hoặc kéo một ghế để chỉnh riêng. Có thể đổi kiểu bàn, xoay cụm và nhập tọa độ bằng bàn phím. Mở **Xem trước** để đối chiếu vị trí trên khung điện thoại.
4. Chọn **Lưu nháp**, rồi **Công bố**. Trang khách đang mở nhận sơ đồ mới qua Socket.IO. Các mã QR đã in tiếp tục dùng được cho những bàn còn trong sơ đồ.
5. Chạm một bàn có khách online để nhắn tin hoặc mời chơi. Ván caro dùng bàn 15 × 15 và thắng khi nối năm quân liên tiếp. Nhật ký riêng có thể mở lại trên trình duyệt đã quét QR.

SQLite tự tạo sơ đồ mẫu 12 bàn ở lần chạy đầu. Bố cục và nhật ký được lưu vào tệp `XUONG_DB`. Chat, lời mời và ván caro đang chơi được giữ trong RAM, nên các phiên này kết thúc khi tiến trình khởi động lại.

## Chạy trên VPS Linux

Ví dụ dưới đây đặt mã nguồn ở `/srv/xuong-caffe`. Trên VPS, chạy `npm ci` và `npm run build` từ thư mục đó. Tạo tài khoản dịch vụ `xuong-caffe`, cấp quyền đọc mã nguồn và đặt mật khẩu riêng trong `/etc/xuong-caffe.env` với biến `XUONG_ADMIN_PASSWORD`.

Ví dụ cấu hình `systemd` trong `/etc/systemd/system/xuong-caffe.service`:

```ini
[Unit]
Description=Xuong Caffe
After=network.target

[Service]
User=xuong-caffe
WorkingDirectory=/srv/xuong-caffe
StateDirectory=xuong-caffe
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment=XUONG_DB=/var/lib/xuong-caffe/xuong-caffe.sqlite
EnvironmentFile=/etc/xuong-caffe.env
ExecStart=/usr/bin/node /srv/xuong-caffe/server/index.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Dùng đường dẫn Node.js của VPS trong `ExecStart`. Đặt tên miền đã trỏ DNS vào cấu hình Caddy:

```caddyfile
cafe.example.com {
    encode zstd gzip

    @backend path /api/* /socket.io/*
    handle @backend {
        reverse_proxy 127.0.0.1:3000
    }

    handle {
        root * /srv/xuong-caffe/dist
        try_files {path} /index.html
        file_server
    }
}
```

Bật dịch vụ và kiểm tra kết nối sau khi Caddy tải cấu hình:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now xuong-caffe
sudo systemctl reload caddy
curl --fail https://cafe.example.com/api/health
```

Tạo mã QR bàn từ `/admin` trên tên miền chính thức. Sao lưu tệp SQLite định kỳ bằng lệnh `.backup` của SQLite cùng thư mục ảnh `/var/lib/xuong-caffe/journal-photos` và lưu một bản ngoài VPS.
