# Xưởng Caffe — hướng dẫn cho agent

## Mục tiêu

Ứng dụng web cho khách quán cà phê: khách quét QR theo bàn, tạo nhân vật, xem sơ đồ quán, trò chuyện, mời chơi caro và ghi nhật ký. Giao diện và nội dung sản phẩm hiện dùng tiếng Việt.

## Công nghệ và cấu trúc

- `src/`: React 19 + TypeScript; `Guest.tsx` là trải nghiệm khách, `Admin.tsx` là trang quản trị, `Map.tsx` dùng chung cho sơ đồ và trình chỉnh sửa.
- `server/`: Fastify API, Socket.IO và lưu trữ SQLite. `server/index.ts` ghép API với realtime; `server/database.ts` quản lý dữ liệu; `server/social.ts` xử lý chat, lời mời và caro.
- `src/shared.ts`: kiểu dữ liệu và các lựa chọn nhân vật được dùng chung giữa frontend và backend.
- `public/art/`: hình nền quán, bàn ghế, biểu tượng và các lớp ảnh nhân vật.
- `vite.config.ts`: proxy `/api` và `/socket.io` từ Vite sang backend.

## Chạy dự án

Cần Node.js 24 trở lên và npm. Từ thư mục gốc:

```sh
npm ci
```

Tạo `.env` từ `.env.example`, sau đó đặt `XUONG_ADMIN_PASSWORD` riêng. Không đưa `.env` lên Git. Các biến mặc định gồm `HOST=127.0.0.1`, `PORT=3000` và `XUONG_DB=data/xuong-caffe.sqlite`.

```sh
npm run dev       # Vite và Node API cùng chạy
npm run check     # Kiểm tra TypeScript
npm run build     # Kiểm tra TypeScript rồi build frontend
npm start         # Chạy server và phục vụ dist nếu đã build
```

Giao diện dev mặc định ở `http://localhost:5173`; trang quản trị ở `/admin`. Backend mặc định ở cổng `3000`. Có thể dùng `npm.cmd` trong PowerShell nếu chính sách chặn `npm.ps1`.

## Luồng và API chính

- QR mang token bàn trong query `?table=...`; frontend gửi token tới `POST /api/check-in`. Hồ sơ nhân vật được lưu qua `PUT /api/guest/profile`.
- `GET /api/venue` trả sơ đồ đã công bố, bàn hiện tại và trạng thái khách.
- Quản trị: `POST /api/admin/login`, `GET/PUT /api/admin/layout`, `POST /api/admin/publish`, `POST /api/admin/logout`. Admin sửa bản nháp rồi công bố; cập nhật dùng `version` để phát hiện bản nháp cũ.
- Xã hội: `GET /api/social`, `POST /api/chat`, `POST /api/caro/invite`, `POST /api/caro/invites/:id`, `POST /api/caro/games/:id/move`.
- Nhật ký: `GET/POST /api/journal`.
- Server xác thực dữ liệu đầu vào. Giữ luật và kiểm tra quan trọng ở backend, không chỉ dựa vào giới hạn UI.

Socket.IO phát cập nhật hoạt động và sơ đồ cho khách. Thông báo xã hội gửi tới phòng theo khách; khi nhận `social:changed`, frontend tải lại `/api/social` để lấy trạng thái chat, lời mời và ván cờ.

## Lưu trữ và giới hạn

- Backend dùng `node:sqlite` tích hợp trong Node.js, bật WAL. Schema được tạo trong `server/database.ts`; lần đầu tự tạo sơ đồ 12 bàn mẫu.
- Sơ đồ, mã QR, khách, hồ sơ nhân vật và nhật ký được lưu trong SQLite. `data/`, file SQLite và WAL bị `.gitignore` loại trừ; không commit dữ liệu cá nhân hoặc bản database của máy phát triển.
- Trạng thái online, chat, lời mời và ván caro nằm trong RAM, mất khi server khởi động lại. Ghế khách hết hiệu lực sau 12 giờ; lời mời sau 2 phút; ván caro sau 45 phút không hoạt động.
- Chưa có hệ thống migration riêng; hiện schema dùng `CREATE TABLE IF NOT EXISTS`. Nếu thay đổi schema, hãy lên kế hoạch migration tương thích với database đã tồn tại.
- Sơ đồ giới hạn 80 bàn và 12 ghế mỗi bàn. Caro dùng bàn 15×15, nối 5 quân để thắng. Tin nhắn tối đa 500 ký tự; nhật ký tối đa 4.000 ký tự.

## Ghi chú khi làm việc

README hiện mô tả phòng Socket.IO riêng cho từng chat/ván cờ, còn code hiện tại dùng phòng theo khách và tải lại trạng thái xã hội qua API. Khi sửa realtime, hãy đối chiếu implementation và cập nhật tài liệu để hai phần không lệch nhau.
