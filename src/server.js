const express = require('express')
const cors = require('cors')
const { z } = require('zod')
const { config } = require('./config')
const store = require('./store')

const app = express()

app.use(cors({ origin: config.corsOrigin }))
app.use(express.json())

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

const paymentSchema = z.object({
  orderId: z.number().int(),
  status: z.enum(['pending', 'approved', 'rejected']),
  providerRef: z.string().optional(),
})

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'forninho-backend' })
})

app.get('/api/flavors', (_req, res) => {
  res.json(store.listFlavors())
})

app.post('/api/flavors', (req, res) => {
  const parsed = flavorSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }
  const flavor = store.createFlavor(parsed.data)
  return res.status(201).json(flavor)
})

app.patch('/api/flavors/:id', (req, res) => {
  const flavorId = Number(req.params.id)
  const flavor = store.updateFlavor(flavorId, req.body)
  if (!flavor) return res.status(404).json({ error: 'Flavor not found' })
  return res.json(flavor)
})

app.post('/api/flavors/:id/slices', (req, res) => {
  const parsed = slicesSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }
  const flavorId = Number(req.params.id)
  const flavor = store.addSlices(flavorId, parsed.data.amount)
  if (!flavor) return res.status(404).json({ error: 'Flavor not found' })
  return res.json(flavor)
})

app.get('/api/costs', (_req, res) => {
  res.json(store.listCosts())
})

app.post('/api/costs', (req, res) => {
  const parsed = costSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }
  const cost = store.createCost(parsed.data)
  return res.status(201).json(cost)
})

app.get('/api/orders', (req, res) => {
  const status = req.query.status ? String(req.query.status) : null
  res.json(store.listOrders(status))
})

app.post('/api/orders', (req, res) => {
  const parsed = orderSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }
  const order = store.createOrder(parsed.data)
  if (order.error) {
    return res.status(400).json({ error: order.error })
  }
  return res.status(201).json(order)
})

app.patch('/api/orders/:id/status', (req, res) => {
  const orderId = Number(req.params.id)
  const status = req.body.status
  if (!status) {
    return res.status(400).json({ error: 'Status required' })
  }
  const order = store.updateOrderStatus(orderId, status)
  if (!order) return res.status(404).json({ error: 'Order not found' })
  return res.json(order)
})

app.get('/api/orders/ready', (_req, res) => {
  res.json(store.listOrders('pronto'))
})

app.get('/api/financials', (_req, res) => {
  res.json(store.getFinancials())
})

app.post('/api/payments/mercadopago/terminal/charge', (req, res) => {
  const parsed = paymentSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }

  const order = store.markOrderPaid(parsed.data.orderId)
  if (!order) {
    return res.status(404).json({ error: 'Order not found' })
  }

  const payment = store.createPayment({
    orderId: order.id,
    provider: 'mercadopago',
    status: parsed.data.status,
    providerRef: parsed.data.providerRef || 'mp-placeholder',
    receiptCode: order.code,
  })

  res.json({
    status: payment.status,
    receiptCode: payment.receiptCode,
    order,
  })
})

app.post('/api/payments/mercadopago/webhook', (req, res) => {
  const parsed = paymentSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }

  if (parsed.data.status === 'approved') {
    const order = store.markOrderPaid(parsed.data.orderId)
    if (!order) return res.status(404).json({ error: 'Order not found' })
  }

  res.json({ received: true })
})

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

app.listen(config.port, () => {
  console.log(`Backend running on port ${config.port}`)
})
