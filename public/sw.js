// Service worker: nhận thông báo đẩy nhắc học và mở app khi bấm vào thông báo.
// Thông báo đẩy được gửi KHÔNG kèm nội dung (không cần mã hóa), nên lời nhắc cố định ở đây.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let body = 'Đến giờ học tiếng Anh rồi! Một buổi 30 phút mỗi ngày là đủ.'
  try {
    // nếu sau này máy chủ gửi kèm nội dung JSON {"body": "..."} thì dùng luôn
    const data = event.data && event.data.json()
    if (data && typeof data.body === 'string') body = data.body.slice(0, 200)
  } catch (_) {
    // không có nội dung hoặc không phải JSON: dùng lời nhắc mặc định
  }
  event.waitUntil(
    self.registration.showNotification('English Coach', {
      body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'daily-reminder', // nhắc mới thay thế nhắc cũ chưa đọc, không chất đống
      data: { url: '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.navigate && c.navigate(target)
          return c.focus()
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})
