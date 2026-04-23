const express = require('express')
const cors = require('cors')
const { z } = require('zod')
const { config } = require('./config')
const store = require('./store')

const app = express()

app.use(cors({ origin: config.corsOrigin }))
app.use(express.json())

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`, req.body)
  next()
})

const flavorSchema = z.object({
  name: z.string().min(2),
  priceCents: z.number().int().positive(),
  slicesTotal: z.number().int().nonnegative(),
  slicesAvailable: z.number().int().nonnegative(),
  active: z.boolean().optional(),
})

const slicesSchema = z.object({
  amount: z.number().int().positive(),
})

const costSchema = z.object({
  label: z.string().min(2),
  amountCents: z.number().int().positive(),
  cadence: z.enum(['monthly']),
})

const orderSchema = z.object({
  flavorId: z.number().int(),
  qty: z.number().int().positive(),
  paymentMethod: z.string().min(2),
})

const paymentIntentSchema = z.object({
  orderId: z.number().int(),
})

async function mpRequest(path, options = {}) {
  if (!config.mercadoPago.accessToken) {
    throw new Error('Mercado Pago access token not configured')
  }

  const response = await fetch(`https://api.mercadopago.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.mercadoPago.accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })

  const text = await response.text()
  const data = text ? JSON.parse(text) : null

  if (!response.ok) {
    const error = new Error('Mercado Pago request failed')
    error.status = response.status
    error.payload = data
    throw error
  }

  return data
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'forninho-backend' })
})

app.get('/api/flavors', async (_req, res) => {
  try {
    res.json(await store.listFlavors())
  } catch (err) {
    console.error('[GET /api/flavors]', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.post('/api/flavors', async (req, res) => {
  console.log('[POST /api/flavors] body recebido:', req.body)
  const parsed = flavorSchema.safeParse(req.body)
  if (!parsed.success) {
    console.warn('[POST /api/flavors] validacao falhou:', parsed.error.flatten())
    return res.status(400).json({ error: parsed.error.flatten() })
  }
  try {
    const flavor = await store.createFlavor(parsed.data)
    console.log('[POST /api/flavors] sabor criado:', flavor)
    return res.status(201).json(flavor)
  } catch (err) {
    console.error('[POST /api/flavors] erro ao criar sabor:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

app.patch('/api/flavors/:id', async (req, res) => {
  console.log(`[PATCH /api/flavors/${req.params.id}] body recebido:`, req.body)
  try {
    const flavor = await store.updateFlavor(Number(req.params.id), req.body)
    if (!flavor) {
      console.warn(`[PATCH /api/flavors/${req.params.id}] sabor nao encontrado`)
      return res.status(404).json({ error: 'Flavor not found' })
    }
    return res.json(flavor)
  } catch (err) {
    console.error(`[PATCH /api/flavors/${req.params.id}] erro:`, err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

app.post('/api/flavors/:id/slices', async (req, res) => {
  const parsed = slicesSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  try {
    const flavor = await store.addSlices(Number(req.params.id), parsed.data.amount)
    if (!flavor) return res.status(404).json({ error: 'Flavor not found' })
    return res.json(flavor)
  } catch {
    return res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/costs', async (_req, res) => {
  try {
    res.json(await store.listCosts())
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.post('/api/costs', async (req, res) => {
  const parsed = costSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  try {
    const cost = await store.createCost(parsed.data)
    return res.status(201).json(cost)
  } catch {
    return res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/orders', async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null
    res.json(await store.listOrders(status))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/orders/ready', async (_req, res) => {
  try {
    res.json(await store.listOrders('pronto'))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.post('/api/orders', async (req, res) => {
  const parsed = orderSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  try {
    const order = await store.createOrder(parsed.data)
    if (order.error) return res.status(400).json({ error: order.error })
    return res.status(201).json(order)
  } catch {
    return res.status(500).json({ error: 'Internal server error' })
  }
})

app.patch('/api/orders/:id/status', async (req, res) => {
  const status = req.body.status
  if (!status) return res.status(400).json({ error: 'Status required' })
  try {
    const order = await store.updateOrderStatus(Number(req.params.id), status)
    if (!order) return res.status(404).json({ error: 'Order not found' })
    return res.json(order)
  } catch {
    return res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/financials', async (_req, res) => {
  try {
    res.json(await store.getFinancials())
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.post('/api/payments/mercadopago/pos/intent', async (req, res) => {
  const parsed = paymentIntentSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }

  try {
    const order = await store.getOrder(parsed.data.orderId)
    if (!order) return res.status(404).json({ error: 'Order not found' })

    if (!config.mercadoPago.posId) {
      return res.status(400).json({ error: 'MERCADOPAGO_POS_ID not configured' })
    }

    const intent = await mpRequest('/point/integrations/v1/payment-intents', {
      method: 'POST',
      body: JSON.stringify({
        amount: Number((order.totalCents / 100).toFixed(2)),
        description: `Pedido ${order.id}`,
        external_reference: String(order.id),
        pos_id: config.mercadoPago.posId,
      }),
    })

    await store.attachPaymentIntent(order.id, intent.id)

    return res.status(201).json({
      status: intent.status,
      paymentIntentId: intent.id,
      orderId: order.id,
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.payload || err.message })
  }
})

app.post('/api/payments/mercadopago/pos/webhook', async (req, res) => {
  const paymentIntentId = req.body?.data?.id || req.body?.id
  if (!paymentIntentId) {
    return res.status(400).json({ error: 'Payment intent id required' })
  }

  try {
    const intent = await mpRequest(`/point/integrations/v1/payment-intents/${paymentIntentId}`)
    const payment = intent.transactions?.payments?.[0]
    const paymentId = payment?.id
    const status = payment?.status || intent.status
    const orderId = Number(intent.external_reference)

    const order = Number.isNaN(orderId)
      ? await store.findOrderByPaymentIntentId(paymentIntentId)
      : await store.getOrder(orderId)

    if (!order) return res.status(404).json({ error: 'Order not found' })

    const updated = await store.updateOrderFromPayment(order.id, paymentId, status)

    if (paymentId) {
      await store.createPayment({
        orderId: updated.id,
        provider: 'mercadopago',
        status,
        providerRef: paymentId,
        receiptCode: updated.code,
      })
    }

    return res.json({ received: true })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.payload || err.message })
  }
})

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

app.listen(config.port, () => {
  console.log(`Backend running on port ${config.port}`)
})
