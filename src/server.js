const express = require('express')
const cors = require('cors')
const multer = require('multer')
const { v2: cloudinary } = require('cloudinary')
const { z } = require('zod')
const { config } = require('./config')
const store = require('./store')

const app = express()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
})

if (config.cloudinary.cloudName && config.cloudinary.apiKey && config.cloudinary.apiSecret) {
  cloudinary.config({
    cloud_name: config.cloudinary.cloudName,
    api_key: config.cloudinary.apiKey,
    api_secret: config.cloudinary.apiSecret,
  })
}

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: config.cloudinary.folder,
        resource_type: 'image',
      },
      (error, result) => {
        if (error) return reject(error)
        return resolve(result)
      },
    )
    stream.end(buffer)
  })
}

app.use(cors({ origin: config.corsOrigin }))
app.use(express.json())

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`, req.body)
  next()
})

const flavorSchema = z.object({
  name: z.string().min(2),
  imageUrl: z.string().url().optional().nullable(),
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
  cadence: z.enum(['monthly', 'once']),
  category: z.enum(['operational', 'product']).optional().default('operational'),
})

const orderSchema = z.object({
  flavorId: z.number().int(),
  qty: z.number().int().positive(),
  paymentMethod: z.enum(['point', 'pix', 'dinheiro']),
  customerName: z.string().min(1).max(60).optional(),
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

function resolveOrderIdFromPayment(payment) {
  const candidates = [
    payment?.external_reference,
    payment?.metadata?.external_reference,
    payment?.additional_info?.external_reference,
  ]
  for (const ref of candidates) {
    const value = Number(ref)
    if (!Number.isNaN(value)) return value
  }

  const description = String(payment?.description || '')
  const match = description.match(/Pedido\s*#(\d+)/i)
  if (match) {
    const value = Number(match[1])
    if (!Number.isNaN(value)) return value
  }

  return NaN
}

async function resolveOrderByPaymentFallback(payment) {
  const directOrderId = resolveOrderIdFromPayment(payment)
  if (!Number.isNaN(directOrderId)) {
    const order = await store.getOrder(directOrderId)
    if (order) return order
  }

  const merchantOrderId = payment?.order?.id
  if (merchantOrderId) {
    try {
      const mo = await mpRequest(`/merchant_orders/${merchantOrderId}`)
      const moOrderId = Number(mo.external_reference)
      if (!Number.isNaN(moOrderId)) {
        const order = await store.getOrder(moOrderId)
        if (order) return order
      }
    } catch (err) {
      console.warn('[webhook] falha ao resolver merchant_order:', err?.payload || err?.message)
    }
  }

  return null
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'forninho-backend' })
})

app.post('/api/upload', upload.single('image'), async (req, res) => {
  if (!config.cloudinary.cloudName || !config.cloudinary.apiKey || !config.cloudinary.apiSecret) {
    return res.status(500).json({ error: 'Cloudinary not configured' })
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Arquivo obrigatório no campo image' })
  }

  if (!req.file.mimetype || !req.file.mimetype.startsWith('image/')) {
    return res.status(400).json({ error: 'Arquivo deve ser uma imagem' })
  }

  try {
    const result = await uploadToCloudinary(req.file.buffer)
    return res.status(201).json({ url: result.secure_url })
  } catch (err) {
    console.error('[POST /api/upload] erro:', err)
    return res.status(500).json({ error: 'Falha no upload da imagem' })
  }
})

app.get('/api/stats', async (_req, res) => {
  try {
    res.json(await store.getStats())
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
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

app.delete('/api/costs/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' })
  try {
    const deleted = await store.deleteCost(id)
    if (!deleted) return res.status(404).json({ error: 'Custo não encontrado' })
    return res.status(204).send()
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

app.patch('/api/orders/:id/pickup', async (req, res) => {
  try {
    const order = await store.getOrder(Number(req.params.id))
    if (!order) return res.status(404).json({ error: 'Order not found' })
    if (order.status !== 'pronto') return res.status(409).json({ error: 'Pedido não está pronto para retirada' })
    const updated = await store.updateOrderStatus(Number(req.params.id), 'retirado')
    return res.json(updated)
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

// ─── Helpers Mercado Pago ────────────────────────────────────────────────────

async function clearPosOrder() {
  const { collectorId, qrStoreId, qrExternalPosId } = config.mercadoPago
  if (!collectorId || !qrStoreId || !qrExternalPosId) return
  try {
    await mpRequest(
      `/instore/qr/seller/collectors/${collectorId}/stores/${qrStoreId}/pos/${qrExternalPosId}/orders`,
      { method: 'DELETE' },
    )
    console.log('[pos] QR order limpo')
  } catch (err) {
    console.warn('[pos] falha ao limpar QR order:', err?.payload || err?.message)
  }
}

async function cancelPointIntent(intentId) {
  const { pointDeviceId } = config.mercadoPago
  if (!pointDeviceId || !intentId) return
  try {
    await mpRequest(
      `/point/integration-api/devices/${pointDeviceId}/payment-intents/${intentId}`,
      { method: 'DELETE' },
    )
    console.log(`[pos] intent ${intentId} cancelado na maquininha`)
  } catch (err) {
    console.warn('[pos] falha ao cancelar intent:', err?.payload || err?.message)
  }
}

function normalizeIntentsList(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.results)) return payload.results
  if (Array.isArray(payload?.payment_intents)) return payload.payment_intents
  return []
}

function resolveOrderIdFromIntent(intent) {
  const fromRef = Number(intent?.additional_info?.external_reference ?? intent?.external_reference)
  if (!Number.isNaN(fromRef)) return fromRef
  const description = String(intent?.description || '')
  const match = description.match(/Pedido\s*#(\d+)/i)
  if (!match) return NaN
  const parsed = Number(match[1])
  return Number.isNaN(parsed) ? NaN : parsed
}

async function listDevicePaymentIntents(deviceId) {
  try {
    const payload = await mpRequest(`/point/integration-api/devices/${deviceId}/payment-intents`)
    return normalizeIntentsList(payload)
  } catch (err) {
    console.warn('[pos] falha ao listar payment-intents do device:', err?.payload || err?.message)
    return []
  }
}

function isQueuedIntentConflict(err) {
  return err?.status === 409 && String(err?.payload?.error || '') === '2205'
}

// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/orders/:id', async (req, res) => {
  const orderId = Number(req.params.id)
  if (Number.isNaN(orderId)) return res.status(400).json({ error: 'Invalid order id' })
  try {
    const order = await store.getOrder(orderId)
    if (!order) return res.status(404).json({ error: 'Order not found' })
    return res.json(order)
  } catch (err) {
    console.error('[GET /api/orders/:id] erro:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

app.delete('/api/orders/:id', async (req, res) => {
  const orderId = Number(req.params.id)
  if (Number.isNaN(orderId)) return res.status(400).json({ error: 'Invalid order id' })
  try {
    const order = await store.getOrder(orderId)
    if (!order) return res.status(404).json({ error: 'Order not found' })
    // Cancela intent na maquininha antes de cancelar o pedido
    if (order.paymentIntentId) await cancelPointIntent(order.paymentIntentId)
    await clearPosOrder()
    const result = await store.cancelOrder(orderId)
    if (!result) return res.status(404).json({ error: 'Order not found' })
    if (result.error) return res.status(400).json({ error: result.error })
    return res.json(result)
  } catch (err) {
    console.error('[DELETE /api/orders/:id] erro:', err)
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

  const { pointDeviceId } = config.mercadoPago
  if (!pointDeviceId) {
    return res.status(503).json({
      error: 'Maquininha não configurada. Defina MERCADOPAGO_POINT_DEVICE_ID no Render após ativar o modo integração no Point Pro 3.',
    })
  }

  try {
    const order = await store.getOrder(parsed.data.orderId)
    if (!order) return res.status(404).json({ error: 'Order not found' })
    if (order.status !== 'aguardando pagamento') {
      return res.status(400).json({ error: `Pedido não está aguardando pagamento (status: ${order.status})` })
    }

    // Idempotência: se já existe intent ativo, retorna sem criar novo
    if (order.paymentIntentId) {
      console.log(`[pos/intent] intent ${order.paymentIntentId} já existe para pedido ${order.id}`)
      return res.json({ success: true, intentId: order.paymentIntentId, orderId: order.id, totalCents: order.totalCents })
    }

    const body = {
      amount: order.totalCents,
      description: `Pedido #${order.id} - Forninho Magico`,
      additional_info: {
        external_reference: String(order.id),
        print_on_terminal: true,
      },
    }

    if (config.serverUrl) {
      body.notification_url = `${config.serverUrl}/api/payments/mercadopago/pos/webhook`
    }

    async function createIntent() {
      return mpRequest(
        `/point/integration-api/devices/${pointDeviceId}/payment-intents`,
        { method: 'POST', body: JSON.stringify(body) },
      )
    }

    let intent
    try {
      intent = await createIntent()
    } catch (err) {
      if (!isQueuedIntentConflict(err)) throw err

      const intents = await listDevicePaymentIntents(pointDeviceId)
      const sameOrderIntent = intents.find((it) => resolveOrderIdFromIntent(it) === order.id)
      if (sameOrderIntent?.id) {
        await store.attachPaymentIntent(order.id, String(sameOrderIntent.id))
        console.log(`[pos/intent] reaproveitado intent ${sameOrderIntent.id} em fila para pedido ${order.id}`)
        return res.json({
          success: true,
          reusedQueuedIntent: true,
          intentId: String(sameOrderIntent.id),
          orderId: order.id,
          totalCents: order.totalCents,
        })
      }

      // Se não achar intent do mesmo pedido, tenta limpar fila e recriar 1x
      for (const pendingIntent of intents) {
        if (pendingIntent?.id) {
          await cancelPointIntent(String(pendingIntent.id))
        }
      }
      intent = await createIntent()
    }

    await store.attachPaymentIntent(order.id, intent.id)

    console.log(`[pos/intent] intent ${intent.id} criado para pedido ${order.id}, R$${(order.totalCents/100).toFixed(2)}`)
    return res.json({ success: true, intentId: intent.id, orderId: order.id, totalCents: order.totalCents })
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

// Rota alternativa usada pelo Mercado Pago Point (notification_url configurada no painel)
app.post('/api/notifications/mercadopago', async (req, res) => {
  console.log('[notifications] recebido:', JSON.stringify(req.body))

  const topic = req.body?.type || req.body?.topic
  // resource pode ser ID direto ou URL como "https://.../payments/123"
  const rawResource = req.body?.resource || req.body?.data?.id
  const paymentId = rawResource ? String(rawResource).split('/').pop() : null

  if (topic === 'payment' && paymentId) {
    try {
      const payment = await mpRequest(`/v1/payments/${paymentId}`)
      const status = payment.status
      const mpPaymentId = String(payment.id)

      const order = await resolveOrderByPaymentFallback(payment)
      if (!order) return res.status(200).json({ received: true })

      console.log(`[notifications] payment ${mpPaymentId} status=${status} orderId=${order.id}`)

      if (order.status === 'em montagem' || order.status === 'pronto') {
        return res.status(200).json({ received: true })
      }

      const updated = await store.updateOrderFromPayment(order.id, mpPaymentId, status)
      if (status === 'approved') {
        await store.createPayment({
          orderId: updated.id, provider: 'mercadopago', status: 'approved',
          providerRef: mpPaymentId, receiptCode: updated.code,
        })
        console.log(`[notifications] pedido ${order.id} aprovado, code=${updated.code}`)
        await clearPosOrder()
      }
      return res.json({ received: true })
    } catch (err) {
      console.error('[notifications] erro:', err)
      return res.status(200).json({ received: true })
    }
  }

  if (topic === 'merchant_order' && rawResource) {
    try {
      const moId = String(rawResource).split('/').pop()
      const mo = await mpRequest(`/merchant_orders/${moId}`)
      const approvedPayment = (mo.payments || []).find(p => p.status === 'approved')
      if (!approvedPayment) return res.status(200).json({ received: true })
      const orderId = Number(mo.external_reference)
      if (Number.isNaN(orderId)) return res.status(200).json({ received: true })
      const order = await store.getOrder(orderId)
      if (!order || order.status === 'em montagem' || order.status === 'pronto') {
        return res.status(200).json({ received: true })
      }
      const mpPaymentId = String(approvedPayment.id)
      const updated = await store.updateOrderFromPayment(order.id, mpPaymentId, 'approved')
      await store.createPayment({
        orderId: updated.id, provider: 'mercadopago', status: 'approved',
        providerRef: mpPaymentId, receiptCode: updated.code,
      })
      console.log(`[notifications] merchant_order: pedido ${orderId} aprovado, code=${updated.code}`)
      await clearPosOrder()
      return res.json({ received: true })
    } catch (err) {
      console.error('[notifications] merchant_order erro:', err)
      return res.status(200).json({ received: true })
    }
  }

  return res.status(200).json({ received: true })
})

app.post('/api/payments/mercadopago/pos/webhook', async (req, res) => {
  console.log('[webhook] recebido:', JSON.stringify(req.body))

  const topic = req.body?.type || req.body?.topic

  // ── Point Terminal: envia payment_intent ─────────────────────────────────
  if (topic === 'payment_intent') {
    const intentId = req.body?.data?.id || req.body?.id
    if (!intentId) return res.status(200).json({ received: true })
    try {
      const intent = await mpRequest(`/point/integration-api/payment-intents/${intentId}`)
      const payment = (intent.payment ?? intent.transactions?.payments?.[0])
      const mpPaymentId = payment?.id ? String(payment.id) : null
      const status = payment?.status ?? intent.state

      const resolvedOrderId = Number(intent.additional_info?.external_reference ?? intent.external_reference)
      let order = null
      if (!Number.isNaN(resolvedOrderId)) {
        order = await store.getOrder(resolvedOrderId)
      }
      if (!order) {
        order = await store.findOrderByPaymentIntentId(String(intentId))
      }

      if (!order) {
        console.warn('[webhook] não foi possível resolver pedido para payment_intent:', intentId)
        return res.status(200).json({ received: true })
      }

      const updated = await store.updateOrderFromPayment(order.id, mpPaymentId, status === 'FINISHED' ? 'approved' : status)
      if (status === 'FINISHED' && mpPaymentId) {
        await store.createPayment({
          orderId: updated.id, provider: 'mercadopago', status: 'approved',
          providerRef: mpPaymentId, receiptCode: updated.code,
        })
        console.log(`[webhook] Point: pedido ${order.id} aprovado, code=${updated.code}`)
      }
      return res.json({ received: true })
    } catch (err) {
      console.error('[webhook] payment_intent erro:', err)
      return res.status(200).json({ received: true })
    }
  }

  // ── QR Dinâmico: envia merchant_order ────────────────────────────────────
  if (topic === 'merchant_order') {
    const resource = req.body?.resource
    if (!resource) return res.status(200).json({ received: true })
    try {
      const moId = resource.split('/').pop()
      const mo = await mpRequest(`/merchant_orders/${moId}`)
      const approvedPayment = (mo.payments || []).find(p => p.status === 'approved')
      if (!approvedPayment) {
        console.log(`[webhook] merchant_order ${moId} sem pagamento aprovado ainda`)
        return res.status(200).json({ received: true })
      }
      const orderId = Number(mo.external_reference)
      const mpPaymentId = String(approvedPayment.id)
      if (Number.isNaN(orderId)) return res.status(200).json({ received: true })
      const order = await store.getOrder(orderId)
      if (!order) return res.status(200).json({ received: true })
      if (order.status === 'em montagem' || order.status === 'pronto') {
        return res.status(200).json({ received: true })
      }
      const updated = await store.updateOrderFromPayment(order.id, mpPaymentId, 'approved')
      await store.createPayment({
        orderId: updated.id, provider: 'mercadopago', status: 'approved',
        providerRef: mpPaymentId, receiptCode: updated.code,
      })
      console.log(`[webhook] QR: pedido ${orderId} aprovado, code=${updated.code}`)
      return res.json({ received: true })
    } catch (err) {
      console.error('[webhook] merchant_order erro:', err)
      return res.status(200).json({ received: true })
    }
  }

  // ── Formato v2 (type: payment) ────────────────────────────────────────────
  if (topic === 'payment') {
    const paymentId = req.body?.data?.id
    if (!paymentId) return res.status(200).json({ received: true })
    try {
      const payment = await mpRequest(`/v1/payments/${paymentId}`)
      const order = await resolveOrderByPaymentFallback(payment)
      if (!order) return res.status(200).json({ received: true })
      const updated = await store.updateOrderFromPayment(order.id, String(payment.id), payment.status)
      if (payment.status === 'approved') {
        await store.createPayment({
          orderId: updated.id, provider: 'mercadopago', status: 'approved',
          providerRef: String(payment.id), receiptCode: updated.code,
        })
        console.log(`[webhook] payment: pedido ${order.id} aprovado, code=${updated.code}`)
      }
      return res.json({ received: true })
    } catch (err) {
      console.error('[webhook] payment erro:', err)
      return res.status(200).json({ received: true })
    }
  }

  return res.status(200).json({ received: true })
})

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

app.listen(config.port, () => {
  console.log(`Backend running on port ${config.port}`)
})
