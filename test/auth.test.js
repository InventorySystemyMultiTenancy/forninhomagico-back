const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')

const { app, initializeAuthUsers } = require('../src/server')

const canRun = Boolean(process.env.DATABASE_URL)

if (!canRun) {
  test('auth integration tests', { skip: true }, () => {})
} else {
  let server
  let baseUrl

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      ...options,
    })

    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }

    return { response, body }
  }

  before(async () => {
    await initializeAuthUsers()
    server = app.listen(0)
    await once(server, 'listening')
    const address = server.address()
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  after(async () => {
    if (!server) return
    await new Promise((resolve) => server.close(resolve))
  })

  test('login returns token and user', async () => {
    const { response, body } = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    })

    assert.equal(response.status, 200)
    assert.equal(typeof body.token, 'string')
    assert.equal(body.user.username, 'admin')
    assert.equal(body.user.role, 'ADMIN')
  })

  test('login rejects invalid credentials', async () => {
    const { response, body } = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
    })

    assert.equal(response.status, 401)
    assert.equal(body.error, 'Credenciais inválidas')
  })

  test('me returns authenticated user', async () => {
    const login = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    })

    const { response, body } = await request('/api/auth/me', {
      headers: { Authorization: `Bearer ${login.body.token}` },
    })

    assert.equal(response.status, 200)
    assert.equal(body.user.username, 'admin')
    assert.equal(body.user.role, 'ADMIN')
  })

  test('me rejects invalid token', async () => {
    const { response, body } = await request('/api/auth/me', {
      headers: { Authorization: 'Bearer invalid-token' },
    })

    assert.equal(response.status, 401)
    assert.equal(body.error, 'Token inválido ou expirado')
  })

  test('USER cannot access admin routes', async () => {
    const login = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'operador', password: 'operador123' }),
    })

    const { response, body } = await request('/api/stats', {
      headers: { Authorization: `Bearer ${login.body.token}` },
    })

    assert.equal(response.status, 403)
    assert.equal(body.error, 'Acesso negado.')
  })

  test('public tracking endpoint stays accessible', async () => {
    const { response, body } = await request('/api/orders/ready')

    assert.equal(response.status, 200)
    assert.ok(Array.isArray(body))
  })
}
