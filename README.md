# 🎵 Unison

**Cả văn phòng nghe chung một bài: mỗi người nghe trên máy của mình, đồng bộ từng giây.**

Ai cũng thêm được bài, 👍 để bài lên trước, cùng bỏ phiếu bỏ qua, chat, xếp hạng tuần… Bạn tự cài trên máy của mình, không cần tài khoản, không có quảng cáo.

> **English:** Unison is a self-hosted "listen together" room for small teams. Everyone queues YouTube videos or uploaded MP3s, and every device plays the same track in sync. It also has votes, skip-by-majority, chat with @mentions, weekly leaderboards, polls, scheduled plays and an admin panel. Node.js, no build step, MIT licensed. The UI is in Vietnamese.

---

## Tính năng

| Nhóm | Có gì |
|---|---|
| **Nghe chung** | Đồng bộ theo đồng hồ máy chủ (lệch ≤ 2 giây). Hàng chờ chung xếp **lượt xen kẽ** để không ai chiếm cả hàng. 👍 để lên trước trong lượt. Bỏ qua khi quá nửa phòng đồng ý. Tạm dừng chung, sau 30 phút tự phát tiếp. Báo "bài tiếp theo" 15 giây cuối. |
| **Thêm bài** | Tìm YouTube, dán link bài hoặc playlist, tải mp3 lên (≤ 20 MB). Lời nhắn 💌 tặng bài. Playlist chung. |
| **Trên máy mình** | Âm lượng riêng. Cửa sổ nổi (Chrome/Edge). Phím tắt. Phím nhạc ⏯ trên bàn phím. Cài như app (PWA). Màn hình tối cho bài mp3. |
| **Lời bài** | Lời chạy theo nhạc (nguồn [LRCLIB](https://lrclib.net)). Chỉnh lệch ±1 giây, mỗi máy nhớ riêng từng bài. |
| **Giao lưu** | Chat có @tên và thả cảm xúc. Báo tin chat ra màn hình. Cảm xúc bay trên màn hình. Bình chọn. Xếp hạng tuần và tổng kết thứ Sáu. Huy hiệu. Tự chúc mừng sinh nhật. |
| **Chủ phòng** | Chuyển ngay, khoá thêm bài, tự phát khi trống (từ lịch sử hoặc một playlist). Chủ đề, pháo hoa chúc mừng, hẹn giờ phát, chặn tạm 1 giờ, xoá tin chat. Bảng tình trạng phòng, giờ yên lặng. |
| **Vận hành** | Lưu trạng thái ra JSON (ghi an toàn), sao lưu hằng ngày, `/healthz` cho máy canh. |

## Cài đặt

Cần **Node.js 22+**.

```bash
git clone https://github.com/<you>/unison.git
cd unison
npm install
cp .env.example .env      # Windows: copy .env.example .env
# mở .env, điền YT_API_KEY, ROOM_CODE, ADMIN_CODE
npm start
```

Sau đó mở `http://localhost:3456`.

### ⚠️ Phải mở bằng tên miền, không mở bằng địa chỉ IP

YouTube từ chối phát video nhúng (lỗi 150) khi trang được mở bằng IP trần, ví dụ `http://192.168.1.10:3456`. Có hai cách:

- **Dùng trong mạng nội bộ:** trỏ một tên miền nội bộ về máy chủ (DNS nội bộ hoặc tệp `hosts`).
- **Mở ra Internet (khuyên dùng):** dùng [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), miễn phí, không cần mở cổng router:
  ```bash
  cloudflared tunnel create unison
  cloudflared tunnel route dns unison nhac.example.com
  # config.yml: ingress -> service: http://localhost:3456
  cloudflared tunnel run unison
  ```
  Nhớ đặt `ROOM_CODE` khi mở ra Internet.

Riêng trên máy chủ thì `http://localhost:3456` vẫn dùng được.

### Tạo YouTube API key (miễn phí)

1. Vào [Google Cloud Console](https://console.cloud.google.com/), tạo dự án.
2. Vào **APIs & Services → Library**, tìm **YouTube Data API v3**, bấm **Enable**.
3. Vào **Credentials → Create credentials → API key**.
4. Chọn **Restrict key**, tick **YouTube Data API v3**, rồi lưu.
5. Dán key vào `.env` theo dạng `YT_API_KEY=...`.

Hạn mức miễn phí là 10.000 đơn vị mỗi ngày, tức khoảng 99 lần tìm. Dán link chỉ tốn 1 đơn vị, nên hết lượt tìm vẫn dán link được.

### Tự chạy khi khởi động máy

- **Linux:** dùng `systemd` (đặt `WorkingDirectory` là thư mục dự án, `ExecStart=/usr/bin/node server/index.js`, `Restart=always`) hoặc `pm2 start server/index.js --name unison`.
- **Windows:** dùng Task Scheduler, chạy `node server\index.js` khi đăng nhập, đặt thư mục làm việc là thư mục dự án.

## Cấu hình (`.env`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `APP_NAME` | Unison | tên hiển thị: tiêu đề trang, tên app khi cài lên điện thoại |
| `PORT` | 3456 | cổng |
| `YT_API_KEY` | (trống) | bắt buộc để tìm và thêm bài YouTube |
| `ROOM_CODE` | (trống) | mã phòng; trống thì ai có link cũng vào được |
| `ADMIN_CODE` | (trống) | mã chủ phòng |
| `MAX_DURATION_MIN` | 15 | bài dài nhất (phút) |
| `MAX_PER_USER` | 5 | số bài đang chờ tối đa mỗi người |
| `AUTO_RESUME_MIN` | 30 | tạm dừng quá chừng này phút thì tự phát tiếp |
| `BACKUP_DIR` | `./backups` | nơi sao lưu hằng ngày (giữ 14 ngày) |
| `TRUST_PROXY` | (trống) | đứng sau proxy thì đặt `cloudflare` (Cloudflare Tunnel) hoặc `proxy` (nginx, Caddy…) để chống dò mã theo đúng IP người dùng; **để trống nếu không có proxy** — header proxy giả được |

## Dữ liệu

| Thứ gì | Nằm ở đâu |
|---|---|
| Trạng thái phòng (hàng chờ, lịch sử, chat, thống kê, playlist, lịch hẹn…) | `data/state.json` |
| Tệp mp3 tải lên | `data/uploads/` |
| Danh mục mp3 | `data/library.json` |
| Bản sao lưu hằng ngày | `BACKUP_DIR/<ngày>/` (chỉ JSON, không chép mp3) |

**Khôi phục:** tắt máy chủ, chép `state.json` của ngày cần lấy vào `data/`, rồi bật lại.

Trang `GET /healthz` trả `{"ok":true}`. Dùng nó cho máy canh của bạn (UptimeRobot, cron + Telegram…).

## Phát triển

```bash
npm test
```

| Tệp | Vai trò |
|---|---|
| `server/room.js` | Toàn bộ luật phòng, thuần, không I/O (dễ test) |
| `server/app.js` | Express + Socket.IO |
| `public/` | Giao diện: HTML/JS/CSS thuần, không có bước build |

Khi đưa lên sau CDN, mỗi lần sửa giao diện nhớ tăng số `?v=` trong `public/index.html`.

## 🔒 Bảo mật

- **Chống dò mã:** sai mã phòng hoặc mã chủ phòng 5 lần trong 10 phút thì địa chỉ IP đó bị khoá thử 15 phút. Chạy sau Cloudflare Tunnel hay nginx thì nhớ đặt `TRUST_PROXY`, nếu không mọi người dùng sẽ bị tính chung một IP.
- **Mã:** dùng chuỗi dài, khoảng 8–10 ký tự có cả chữ và số, đặc biệt khi mở phòng ra Internet.
- **Danh tính dựa trên tin tưởng:** không có mật khẩu người dùng, ai cũng tự đặt tên. Người bị chủ phòng chặn có thể xoá dữ liệu trình duyệt để vào lại. Unison dành cho nhóm quen biết, không dành cho phòng công cộng.
- **Mã QR "vào phòng" có chứa sẵn mã phòng.** Ai cầm ảnh QR là vào được, nên chỉ chia sẻ trong nhóm.
- **API key YouTube** chỉ nằm trên máy chủ, không gửi xuống trình duyệt.
- Phát hiện lỗ hổng? Báo riêng cho người duy trì repo, đừng mở issue công khai.

## ⚖️ Lưu ý pháp lý (đọc trước khi dùng)

- Unison là **phần mềm tự cài, dùng nội bộ, phi thương mại**. Dự án không cung cấp nhạc và không phân phối nội dung nào.
- Bài YouTube được phát qua **trình phát nhúng chính thức** của YouTube. Người cài tự chịu trách nhiệm tuân thủ [Điều khoản YouTube API](https://developers.google.com/youtube/terms/api-services-terms-of-service). Không nên thu tiền truy cập, không che hay giấu trình phát.
- Phát nhạc cho nhiều người nghe ở nơi làm việc hay kinh doanh có thể cần **giấy phép biểu diễn công cộng** tại nơi bạn ở. Ở Việt Nam thường là VCPMC.
- Người tải mp3 lên tự chịu trách nhiệm bản quyền tệp đó.
- Lời bài lấy từ kho cộng đồng LRCLIB và chỉ hiển thị trong phòng.

## Giới hạn đã biết

- Trên điện thoại, khoá màn hình thì bài YouTube dừng (YouTube nhúng không phát nền). Bài mp3 thì vẫn phát được.
- Người không có YouTube Premium có thể bị quảng cáo xen vào. Máy đó lệch vài giây rồi tự canh lại.
- Một máy chủ chỉ chạy một phòng.

## Giấy phép

[MIT](LICENSE). Mã nguồn dùng: [Express](https://expressjs.com), [Socket.IO](https://socket.io), [NoSleep.js](https://github.com/richtr/NoSleep.js), [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator). Tất cả đều dùng giấy phép MIT.
