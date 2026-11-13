import http from 'node:http'

// Publish the app without Wrangler's local database explorer or development APIs.
const appPath = /^\/(?:api(?:\/[a-zA-Z0-9_-]+)*|assets\/[a-zA-Z0-9_.-]+|placement|adjustments|session\/\d+|uploads|settings|roadmap|vocab|review|progress|history|icon\.svg|manifest\.webmanifest|sw\.js|favicon\.ico)$/
http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== '/' && !appPath.test(url.pathname)) {
    res.writeHead(404).end('Not found')
    return
  }
  const upstream = http.request({
    hostname: '127.0.0.1', port: 8788,
    path: url.pathname + url.search, method: req.method,
    headers: { ...req.headers, host: '127.0.0.1:8788' },
  }, response => {
    res.writeHead(response.statusCode ?? 502, response.headers)
    response.pipe(res)
  })
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502)
    res.end('Local app unavailable')
  })
  req.pipe(upstream)
}).listen(8790, '127.0.0.1', () => {
  console.log('App tunnel gateway ready at http://127.0.0.1:8790')
})
