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
  } catch (err) {
    console.error('[GET /api/orders/ready] erro:', err)
    res.status(500).json({ error: 'Internal server error', detail: err.message })
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
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { collectorId, qrStoreId, qrExternalPosId } = config.mercadoPago
  if (!collectorId || !qrStoreId || !qrExternalPosId) {
    return res.status(503).json({
      error: 'QR POS não configurado. Defina MERCADOPAGO_COLLECTOR_ID, MERCADOPAGO_QR_STORE_ID e MERCADOPAGO_QR_EXTERNAL_POS_ID no Render.',
    })
  }

  try {
    const order = await store.getOrder(parsed.data.orderId)
    if (!order) return res.status(404).json({ error: 'Order not found' })
    if (order.status !== 'aguardando pagamento') {
      return res.status(400).json({ error: `Pedido não está aguardando pagamento (status: ${order.status})` })
    }

    const amountInReais = order.totalCents / 100
    const body = {
      external_reference: String(order.id),
      items: [
        {
          sku_number: String(order.id),
          category: 'food',
          title: 'Pedido Forninho Mágico',
          description: `Pedido #${order.id}`,
          unit_price: amountInReais,
          quantity: 1,
          unit_measure: 'unit',
          total_amount: amountInReais,
        },
      ],
      total_amount: amountInReais,
    }

    if (config.serverUrl) {
      body.notification_url = `${config.serverUrl}/api/payments/mercadopago/pos/webhook`
    }

    await mpRequest(
      `/instore/qr/seller/collectors/${collectorId}/stores/${qrStoreId}/pos/${qrExternalPosId}/orders`,
      { method: 'PUT', body: JSON.stringify(body) },
    )

    console.log(`[pos/intent] QR order criado para pedido ${order.id}, R$${amountInReais.toFixed(2)}`)
    return res.json({ success: true, orderId: order.id, totalCents: order.totalCents })
  } catch (err) {
    console.error('[pos/intent] erro:', err)
    return res.status(err.status || 500).json({ error: err.payload || err.message })
  }
})

// Confirmação manual de pagamento (atendente clica após receber na maquininha)
app.patch('/api/orders/:id/confirm', async (req, res) => {
  const orderId = Number(req.params.id)
  const providerRef = req.body.providerRef || `manual-${Date.now()}`
  try {
    const order = await store.getOrder(orderId)
    if (!order) return res.status(404).json({ error: 'Order not found' })
    if (order.status !== 'aguardando pagamento') {
      return res.status(400).json({ error: `Order already in status: ${order.status}` })
    }
    const updated = await store.markOrderPaid(orderId, providerRef)
    await store.createPayment({
      orderId: updated.id,
      provider: 'manual',
      status: 'approved',
      providerRef,
      receiptCode: updated.code,
    })
    console.log(`[confirm] pedido ${orderId} confirmado, code=${updated.code}`)
    return res.json(updated)
  } catch (err) {
    console.error('[confirm] erro:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

app.post('/api/payments/mercadopago/pos/webhook', async (req, res) => {
  console.log('[webhook] recebido:', JSON.stringify(req.body))

  // Suporte a formato v1 (topic) e v2 (action/type)
  const topic = req.body?.type || req.body?.topic
  const paymentId = req.body?.data?.id || req.body?.id

  if (topic !== 'payment' || !paymentId) {
    return res.status(200).json({ received: true })
  }

  try {
    const payment = await mpRequest(`/v1/payments/${paymentId}`)
    const orderId = Number(payment.external_reference)
    const status = payment.status
    const mpPaymentId = String(payment.id)

    console.log(`[webhook] payment ${mpPaymentId} status=${status} orderId=${orderId}`)

    if (Number.isNaN(orderId)) {
      console.warn('[webhook] external_reference inválido:', payment.external_reference)
      return res.status(200).json({ received: true })
    }

    const order = await store.getOrder(orderId)
    if (!order) return res.status(404).json({ error: 'Order not found' })

    const updated = await store.updateOrderFromPayment(order.id, mpPaymentId, status)

    if (status === 'approved') {
      await store.createPayment({
        orderId: updated.id,
        provider: 'mercadopago',
        status,
        providerRef: mpPaymentId,
        receiptCode: updated.code,
      })
      console.log(`[webhook] pedido ${orderId} aprovado, code=${updated.code}`)
    }

    return res.json({ received: true })
  } catch (err) {
    console.error('[webhook] erro:', err)
    return res.status(err.status || 500).json({ error: err.payload || err.message })
  }
})

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

app.listen(config.port, () => {
  console.log(`Backend running on port ${config.port}`)
})
