// Service worker tối thiểu để trình duyệt cho "cài như app". Không lưu đệm gì — phòng nhạc luôn cần mạng.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
