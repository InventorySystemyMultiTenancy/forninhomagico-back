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
app.use(express.urlencoded({ extended: true }))

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
  let data = null

  // Tenta fazer parse JSON, mas se falhar e for HTML, lida com graciosidade
  try {
    data = text ? JSON.parse(text) : null
  } catch (parseErr) {
    // Se não consegue fazer parse (ex: HTML), cria objeto de erro
    if (text?.startsWith('<!DOCTYPE') || text?.startsWith('<html')) {
      console.warn(`[mpRequest] resposta HTML recebida de ${path}:`, text.substring(0, 200))
      data = {
        error: 'INVALID_RESPONSE_FORMAT',
        message: `API retornou HTML em vez de JSON (status: ${response.status}). Possível erro 404, 401 ou timeout.`,
        response_snippet: text.substring(0, 100)
      }
    } else {
      throw parseErr
    }
  }

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
  const paymentDebug = {
    id: payment?.id,
    external_reference: payment?.external_reference,
    metadata: payment?.metadata,
    additional_info: payment?.additional_info,
    description: payment?.description,
  }
  console.log('[webhook] tentando resolver order de payment com:', JSON.stringify(paymentDebug))
  
  const directOrderId = resolveOrderIdFromPayment(payment)
  if (!Number.isNaN(directOrderId)) {
    const order = await store.getOrder(directOrderId)
    if (order) {
      console.log(`[webhook] order ${directOrderId} resolvida via external_reference`)
      return order
    }
  }

  const merchantOrderId = payment?.order?.id
  if (merchantOrderId) {
    try {
      const mo = await mpRequest(`/merchant_orders/${merchantOrderId}`)
      const moOrderId = Number(mo.external_reference)
      if (!Number.isNaN(moOrderId)) {
        const order = await store.getOrder(moOrderId)
        if (order) {
          console.log(`[webhook] order ${moOrderId} resolvida via merchant_order`)
          return order
        }
      }
    } catch (err) {
      console.warn('[webhook] falha ao resolver merchant_order:', err?.payload || err?.message)
    }
  }

  console.warn('[webhook] não foi possível resolver order de payment (nenhuma estratégia funcionou)')
  return null
}

async function resolveOrderByPaymentIdFromIntents(paymentId) {
  console.log(`[webhook] tentando resolver order de payment ${paymentId} via intents...`)
  const orders = await store.listOrders()
  const candidates = orders.filter((order) => {
    if (!order.paymentIntentId) return false
    if (order.status === 'cancelado') return false
    if (order.status === 'em montagem' || order.status === 'pronto' || order.status === 'retirado' || order.status === 'entregue') return false
    return true
  })

  console.log(`[webhook] ${candidates.length} intents candidatas para consultar`)
  
  for (const order of candidates) {
    try {
      const intent = await mpRequest(`/point/integration-api/payment-intents/${order.paymentIntentId}`)
      const intentPayments = []
      if (intent?.payment?.id) intentPayments.push(String(intent.payment.id))
      if (Array.isArray(intent?.transactions?.payments)) {
        for (const p of intent.transactions.payments) {
          if (p?.id) intentPayments.push(String(p.id))
        }
      }
      
      if (intentPayments.includes(String(paymentId))) {
        console.log(`[webhook] payment ${paymentId} encontrado em intent de order ${order.id}`)
        return order
      }
    } catch (err) {
      console.warn(`[webhook] falha ao consultar intent ${order.paymentIntentId}:`, err?.payload?.error || err?.message)
    }
  }

  console.warn(`[webhook] payment ${paymentId} não encontrado em nenhuma intent`)
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
  if (!collectorId || !qrStoreId || !qrExternalPosId) {
    console.log('[pos] QR não configurado, pulando limpeza')
    return
  }
  try {
    await mpRequest(
      `/instore/qr/seller/collectors/${collectorId}/stores/${qrStoreId}/pos/${qrExternalPosId}/orders`,
      { method: 'DELETE' },
    )
    console.log('[pos] QR order limpo com sucesso')
  } catch (err) {
    // QR cleanup é opcionl (usado para pagamentos por QR, não para Point)
    // Não falha se error (pode ser 404 se QR não existe, ou credenciais inválidas)
    if (err?.status === 404) {
      console.log('[pos] QR order não encontrado (normal se está usando Point)')
      return
    }
    if (err?.status === 401) {
      console.warn('[pos] credenciais inválidas para QR, verifique config.mercadoPago.collectorId/qrStoreId/qrExternalPosId')
      return
    }
    // Para outros erros (HTML, timeout, etc), apenas loga e não bloqueia
    console.warn('[pos] falha ao limpar QR order (não crítico):', {
      status: err?.status,
      message: err?.message?.substring(0, 100),
      hint: 'Se está usando Point, QR cleanup pode ser ignorado com segurança'
    })
  }
}

async function cancelPointIntent(intentId) {
  if (!intentId) return

  try {
    // Rota correta da API: DELETE /point/integration-api/payment-intents/{intentId}
    // (sem /devices/{deviceId}/ no path para cancelamento)
    await mpRequest(
      `/point/integration-api/payment-intents/${intentId}`,
      { method: 'DELETE' },
    )
    console.log(`[pos] intent ${intentId} cancelado`)
  } catch (err) {
    // Não falha se intent não existe ou operação não suportada
    // (pode ter já sido deletado, ou ser uma intent legada)
    if (err?.status === 404 || err?.status === 405) {
      console.log(`[pos] intent ${intentId} não pode ser deletada (404/405 - pode ser legada ou já deletada)`, {
        status: err?.status,
      })
      return
    }
    throw err // relança outros erros (error de conexão, etc)
  }
}

function isQueuedIntentConflict(err) {
  return err?.status === 409 && String(err?.payload?.error || '') === '2205'
}

function collectIntentIdsFromUnknown(source, out = new Set()) {
  if (!source) return out

  if (Array.isArray(source)) {
    for (const item of source) collectIntentIdsFromUnknown(item, out)
    return out
  }

  if (typeof source !== 'object') return out

  const addMaybeIntentId = (value) => {
    if (typeof value === 'number' || typeof value === 'string') {
      const str = String(value).trim()
      if (str && str !== 'null' && str !== 'undefined') out.add(str)
    }
  }

  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.toLowerCase()
    const looksLikeIntentField =
      normalizedKey.includes('payment_intent') ||
      normalizedKey.includes('paymentintent') ||
      normalizedKey === 'intent' ||
      normalizedKey === 'intentid' ||
      normalizedKey === 'intent_id'

    if (looksLikeIntentField) {
      if (value && typeof value === 'object') {
        addMaybeIntentId(value.id)
      } else {
        addMaybeIntentId(value)
      }
    }

    if (value && typeof value === 'object') {
      collectIntentIdsFromUnknown(value, out)
    }
  }

  return out
}

function parseIntentIdsFromListResponse(response) {
  const intents = Array.isArray(response)
    ? response
    : (Array.isArray(response?.results) ? response.results : (Array.isArray(response?.events) ? response.events : []))

  const ids = []
  for (const item of intents) {
    const id = item?.id || item?.payment_intent_id || item?.paymentIntentId
    if (id) ids.push(String(id))
  }
  return ids
}

async function discoverPointIntentIds(pointDeviceId, sourceTag) {
  const ids = new Set()
  const allOrders = await store.listOrders()

  // Estratégia: consultar status de cada intent conhecido no banco
  // A API não fornece listagem de intents por device, então fazemos lookup por ordem
  for (const order of allOrders) {
    if (!order.paymentIntentId) continue

    try {
      const intent = await mpRequest(`/point/integration-api/payment-intents/${order.paymentIntentId}`)
      // Se consegui consultar, intent ainda existe
      ids.add(order.paymentIntentId)
    } catch (err) {
      // Se 404, intent não existe mais (foi deletado ou expirou)
      if (err?.status !== 404) {
        console.warn(`[${sourceTag}] falha ao consultar intent ${order.paymentIntentId}:`, {
          status: err?.status,
          payload: err?.payload,
        })
      }
    }
  }

  if (ids.size > 0) {
    console.log(`[${sourceTag}] intents vivos descobertos: ${Array.from(ids).join(', ')}`)
  }

  return Array.from(ids)
}

async function forceClearDeviceQueue(pointDeviceId, sourceTag) {
  // Nota: A API do Mercado Pago não fornece um endpoint para limpar toda a fila por device
  // Devemos cancelar intents conhecidos um a um
  console.log(`[${sourceTag}] note: não existe endpoint para limpar fila por device, removendo intents conhecidos...`)
  return false
}

async function cancelKnownIntentsFromDatabase(sourceTag) {
  const allOrders = await store.listOrders()
  let cancelled = 0
  let reconciled = 0

  for (const order of allOrders) {
    if (!order.paymentIntentId) continue

    const wasReconciled = await reconcileOrderByPointIntent(order, sourceTag)
    if (wasReconciled) {
      reconciled++
      continue
    }

    try {
      await cancelPointIntent(order.paymentIntentId)
      await store.attachPaymentIntent(order.id, null)
      cancelled++
    } catch (err) {
      console.warn(`[${sourceTag}] falha ao cancelar intent ${order.paymentIntentId} do pedido ${order.id}:`, err?.message)
    }
  }

  return { cancelled, reconciled }
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
    
    // Tenta cancelar intent na maquininha, mas não bloqueia a deleção se falhar
    if (order.paymentIntentId) {
      try {
        await cancelPointIntent(order.paymentIntentId)
      } catch (err) {
        // Log como warning, mas continua com a deleção local
        console.warn(
          `[DELETE /api/orders/:id] aviso: não conseguiu cancelar intent ${order.paymentIntentId}:`,
          err?.message || err,
        )
      }
    }
    
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

// Endpoint de diagnóstico: consulta status completo de um intent pelo ID
app.get('/api/payment-intent/diagnose/:intentId', async (req, res) => {
  const { intentId } = req.params
  const { pointDeviceId } = config.mercadoPago

  if (!intentId) {
    return res.status(400).json({ error: 'intentId é obrigatório' })
  }

  try {
    const intent = await mpRequest(`/point/integration-api/payment-intents/${intentId}`)
    const payment = intent.payment ?? intent.transactions?.payments?.[0]

    return res.json({
      intentId,
      intent: {
        id: intent.id,
        state: intent.state,
        status: intent.status,
        created_at: intent.created_at,
        updated_at: intent.updated_at,
        additional_info: intent.additional_info,
        external_reference: intent.external_reference,
      },
      payment: payment ? {
        id: payment.id,
        status: payment.status,
        amount: payment.amount,
        created_at: payment.created_at,
      } : null,
      resolvedStatus: payment?.status ?? intent.state,
      shouldMarkAsApproved: (payment?.status ?? intent.state) === 'FINISHED' || payment?.status === 'approved',
    })
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message,
      payload: err.payload,
    })
  }
})

app.get('/api/payments/mercadopago/pos/device-status', async (_req, res) => {
  const { pointDeviceId } = config.mercadoPago
  if (!pointDeviceId) {
    return res.status(503).json({ error: 'Maquininha não configurada' })
  }

  try {
    const discoveredIntentIds = await discoverPointIntentIds(pointDeviceId, 'device-status')

    let device = null
    try {
      device = await mpRequest(`/point/integration-api/devices/${pointDeviceId}`)
    } catch (err) {
      return res.status(err.status || 500).json({
        error: 'Falha ao consultar status do device',
        details: {
          status: err?.status,
          payload: err?.payload,
          message: err?.message,
        },
        discoveredIntentIds,
      })
    }

    return res.json({
      success: true,
      pointDeviceId,
      discoveredIntentIds,
      device,
    })
  } catch (err) {
    return res.status(500).json({
      error: 'Erro ao diagnosticar device',
      details: err?.message,
    })
  }
})

app.get('/api/payments/mercadopago/pos/intent-status/:orderId', async (req, res) => {
  const orderId = Number(req.params.orderId)
  if (Number.isNaN(orderId)) return res.status(400).json({ error: 'orderId inválido' })

  try {
    const order = await store.getOrder(orderId)
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado' })

    if (order.status === 'em montagem' || order.status === 'pronto' || order.status === 'retirado' || order.status === 'entregue') {
      return res.json({
        success: true,
        message: 'Pedido já confirmado como pago',
        orderId,
        orderStatus: order.status,
      })
    }

    if (!order.paymentIntentId) {
      return res.json({
        success: false,
        message: 'Pedido sem payment intent',
        orderId,
        orderStatus: order.status,
      })
    }

    console.log(`[polling] consultando intent ${order.paymentIntentId} para pedido ${orderId}`)

    const intent = await mpRequest(`/point/integration-api/payment-intents/${order.paymentIntentId}`)
    const payment = intent.payment ?? intent.transactions?.payments?.[0]
    const intentStatus = payment?.status ?? intent.state
    const normalizedStatus = normalizePaymentState(intentStatus)

    console.log(`[polling] intent ${order.paymentIntentId}: state=${intent.state}, payment.status=${payment?.status}, normalizado=${normalizedStatus}`)

    if (normalizedStatus === 'approved' && order.status === 'aguardando pagamento') {
      const mpPaymentId = payment?.id ? String(payment.id) : null
      const updated = await store.updateOrderFromPayment(orderId, mpPaymentId, 'approved')
      if (mpPaymentId) {
        await store.createPayment({
          orderId: updated.id,
          provider: 'mercadopago',
          status: 'approved',
          providerRef: mpPaymentId,
          receiptCode: updated.code,
        })
      }
      await clearPosOrder()
      console.log(`[polling] pedido ${orderId} reconciliado como pago (via polling)`)
      return res.json({
        success: true,
        message: 'Pagamento aprovado (detectado via polling)',
        orderId,
        orderStatus: 'em montagem',
        intentStatus,
        normalizedStatus,
        paymentId: payment?.id,
      })
    }

    if (normalizedStatus === 'rejected' || normalizedStatus === 'cancelled') {
      const updated = await store.updateOrderFromPayment(orderId, null, normalizedStatus)
      await releasePointQueueForOrder(order, 'polling')
      return res.json({
        success: false,
        message: `Pagamento ${normalizedStatus}`,
        orderId,
        orderStatus: updated.status,
        intentStatus,
        normalizedStatus,
      })
    }

    return res.json({
      success: false,
      message: 'Pagamento ainda está sendo processado',
      orderId,
      orderStatus: order.status,
      intentStatus,
      normalizedStatus,
    })
  } catch (err) {
    return res.status(err.status || 500).json({
      error: 'Erro ao consultar status do intent',
      details: {
        status: err?.status,
        payload: err?.payload,
        message: err?.message,
      },
    })
  }
})

async function runPointQueueCleanup(pointDeviceId, sourceTag) {
  let intentsDeleted = 0
  const intentsFailedToDelete = []
  let discoveredIntentCount = 0

  try {
    const intentIds = await discoverPointIntentIds(pointDeviceId, sourceTag)
    discoveredIntentCount = intentIds.length

    for (const intentId of intentIds) {
      if (!intentId) continue
      try {
        await cancelPointIntent(String(intentId))
        intentsDeleted++
      } catch (err) {
        intentsFailedToDelete.push(String(intentId))
        console.warn(`[${sourceTag}] falha ao deletar intent ${intentId}:`, err?.payload?.error || err?.message)
      }
    }
  } catch (err) {
    console.warn(`[${sourceTag}] não conseguiu descobrir intents da API:`, err?.payload || err?.message)
  }

  const allOrders = await store.listOrders()
  let ordersCleaned = 0
  let ordersReconciled = 0
  let ordersWithIntent = 0

  for (const order of allOrders) {
    if (!order.paymentIntentId) continue
    ordersWithIntent++

    try {
      const reconciled = await reconcileOrderByPointIntent(order, sourceTag)
      if (reconciled) {
        ordersReconciled++
        continue
      }

      await cancelPointIntent(order.paymentIntentId)
      await store.attachPaymentIntent(order.id, null)
      ordersCleaned++
    } catch (err) {
      console.warn(`[${sourceTag}] falha ao limpar intent do pedido ${order.id}:`, err?.message)
    }
  }

  const likelyManualTerminalActionRequired =
    discoveredIntentCount === 0 &&
    intentsDeleted === 0 &&
    ordersWithIntent === 0 &&
    ordersCleaned === 0 &&
    ordersReconciled === 0

  return {
    discoveredIntentCount,
    intentsDeleted,
    intentsFailedToDelete,
    ordersWithIntent,
    ordersCleaned,
    ordersReconciled,
    likelyManualTerminalActionRequired,
  }
}

app.post('/api/payments/mercadopago/pos/clear-queue', async (_req, res) => {
  const { pointDeviceId } = config.mercadoPago
  if (!pointDeviceId) {
    return res.status(503).json({
      error: 'Maquininha não configurada',
    })
  }

  try {
    console.log('[clear-queue] iniciando limpeza forçada da fila...')

    const cleanup = await runPointQueueCleanup(pointDeviceId, 'clear-queue')

    console.log(`[clear-queue] concluído: ${cleanup.intentsDeleted} intents deletados (${cleanup.intentsFailedToDelete.length} falharam), ${cleanup.ordersCleaned} pedidos limpos no banco, ${cleanup.ordersReconciled} pedidos reconciliados`)
    return res.json({
      success: true,
      ...cleanup,
      intentsFailedToDelete: cleanup.intentsFailedToDelete.length > 0 ? cleanup.intentsFailedToDelete : undefined,
      message: cleanup.likelyManualTerminalActionRequired
        ? 'Não há intents visíveis na API nem no banco. A fila parece estar presa apenas no terminal. Cancele na maquininha e reinicie o modo integração.'
        : cleanup.intentsFailedToDelete.length > 0
          ? `${cleanup.intentsDeleted} intents deletados, mas ${cleanup.intentsFailedToDelete.length} não conseguiram ser deletados. Tente novamente ou use POST /api/payments/mercadopago/pos/force-reset`
          : 'Fila da maquininha limpa com sucesso',
    })
  } catch (err) {
    console.error('[clear-queue] erro:', err)
    return res.status(500).json({ error: err.message || 'Falha ao limpar fila' })
  }
})

// Reset total: força nullificação de TODOS os intents no banco SEM tentar deletar da API
app.post('/api/payments/mercadopago/pos/force-reset', async (_req, res) => {
  try {
    console.log('[force-reset] iniciando reset total do sistema...')

    // 1. Limpa QR order (sem falhar se erro)
    try {
      await clearPosOrder()
      console.log('[force-reset] QR order limpo')
    } catch (err) {
      console.warn('[force-reset] falha ao limpar QR:', err?.message)
    }

    // 2. Nullifica TODOS os intents no banco
    const allOrders = await store.listOrders()
    let ordersCleaned = 0
    const failedOrders = []

    for (const order of allOrders) {
      if (order.paymentIntentId) {
        try {
          await store.attachPaymentIntent(order.id, null)
          console.log(`[force-reset] pedido ${order.id}: intent ${order.paymentIntentId} removido do banco`)
          ordersCleaned++
        } catch (err) {
          console.error(`[force-reset] erro ao limpar pedido ${order.id}:`, err?.message)
          failedOrders.push({ orderId: order.id, error: err?.message })
        }
      }
    }

    // 3. Log final
    console.log(`[force-reset] concluído: ${ordersCleaned} pedidos limpos`)
    
    return res.json({
      success: failedOrders.length === 0,
      ordersCleaned,
      failedOrders: failedOrders.length > 0 ? failedOrders : undefined,
      message: failedOrders.length === 0
        ? 'Sistema resetado com sucesso. Todos os intents foram removidos do banco.'
        : `${ordersCleaned} pedidos limpos, mas ${failedOrders.length} falharam. Verifique o banco manualmente.`,
      nextSteps: 'Agora você pode tentar criar um novo intent normalmente.',
    })
  } catch (err) {
    console.error('[force-reset] erro crítico:', err)
    return res.status(500).json({ 
      error: err.message || 'Falha crítica no reset',
      hint: 'Contacte suporte técnico se o problema persistir'
    })
  }
})

// Force sync: consulta intent na API e marca pedido como pago se pagamento foi aprovado
app.post('/api/payments/mercadopago/pos/force-sync/:orderId', async (req, res) => {
  const orderId = Number(req.params.orderId)
  
  if (Number.isNaN(orderId)) {
    return res.status(400).json({ error: 'orderId inválido' })
  }

  try {
    const order = await store.getOrder(orderId)
    if (!order) {
      return res.status(404).json({ error: `Pedido ${orderId} não encontrado` })
    }

    if (!order.paymentIntentId) {
      return res.status(400).json({ error: `Pedido ${orderId} não tem payment_intent associado` })
    }

    console.log(`[force-sync] consultando intent ${order.paymentIntentId} para pedido ${orderId}...`)

    // Consulta intent na API
    const intent = await mpRequest(`/point/integration-api/payment-intents/${order.paymentIntentId}`)
    const payment = intent.payment ?? intent.transactions?.payments?.[0]
    const mpPaymentId = payment?.id ? String(payment.id) : null
    const paymentStatus = payment?.status ?? intent.state
    const normalizedPaymentStatus = normalizePaymentState(paymentStatus)

    console.log(`[force-sync] intent ${order.paymentIntentId}: status=${paymentStatus}, payment_id=${mpPaymentId}`)

    // Se pagamento foi aprovado, marca pedido como pago
    if (normalizedPaymentStatus === 'approved') {
      const updated = await store.updateOrderFromPayment(order.id, mpPaymentId, 'approved')
      if (mpPaymentId) {
        await store.createPayment({
          orderId: updated.id,
          provider: 'mercadopago',
          status: 'approved',
          providerRef: mpPaymentId,
          receiptCode: updated.code,
        })
      }
      console.log(`[force-sync] pedido ${orderId} marcado como pago, code=${updated.code}`)
      
      await clearPosOrder()

      return res.json({
        success: true,
        message: `Pedido ${orderId} atualizado para PAGO`,
        orderId,
        status: updated.status,
        code: updated.code,
        paymentStatus,
        normalizedPaymentStatus,
      })
    } else {
      // Se ainda não foi aprovado, apenas retorna o status
      return res.json({
        success: false,
        message: `Pagamento ainda não foi aprovado (status: ${paymentStatus})`,
        orderId,
        currentStatus: order.status,
        paymentStatus,
        normalizedPaymentStatus,
        hint: 'Tente novamente em alguns segundos',
      })
    }
  } catch (err) {
    console.error(`[force-sync] erro:`, err)
    return res.status(err.status || 500).json({
      error: err.message,
      payload: err.payload,
      hint: 'Se o intent não existe mais, use POST /api/payments/mercadopago/pos/force-reset',
    })
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
    if (order.paymentMethod !== 'point') {
      return res.status(400).json({
        error: `Pedido ${order.id} está com método ${order.paymentMethod}. A intent Point só pode ser criada para pedidos com paymentMethod=point.`,
      })
    }
    if (order.status !== 'aguardando pagamento') {
      return res.status(400).json({ error: `Pedido não está aguardando pagamento (status: ${order.status})` })
    }

    // Comportamento solicitado: sempre substituir intent anterior por uma nova tentativa.
    if (order.paymentIntentId) {
      console.log(`[pos/intent] pedido ${order.id} já tinha intent ${order.paymentIntentId}; cancelando antes de criar nova`)
      try {
        await cancelPointIntent(order.paymentIntentId)
      } catch (err) {
        console.warn(`[pos/intent] não foi possível cancelar intent antiga ${order.paymentIntentId}:`, err?.message)
      }
      await store.attachPaymentIntent(order.id, null)
    }

    // Limpeza preventiva da fila no device antes da criação (best effort)
    await forceClearDeviceQueue(pointDeviceId, 'pos/intent-preflight')

    const preflightDbCleanup = await cancelKnownIntentsFromDatabase('pos/intent-preflight')
    console.log(`[pos/intent] preflight concluído (${preflightDbCleanup.cancelled} cancelados, ${preflightDbCleanup.reconciled} reconciliados)`)

    const body = {
      amount: order.totalCents,
      description: `Pedido #${order.id} - Forninho Magico`,
      additional_info: {
        external_reference: String(order.id),
        print_on_terminal: true,
      },
    }

    if (config.serverUrl) {
      // Usa IPN como canal principal de confirmação
      body.notification_url = `${config.serverUrl}/api/notifications/mercadopago`
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
      if (!isQueuedIntentConflict(err)) throw err // não é 409, relança direto

      // 409 detectado - fila travada. Tenta limpeza rápida UMA VEZ
      console.warn(`[pos/intent] 409 detectado (fila travada), tentando limpeza rápida...`)

      let cleanupReport = null
      try {
        cleanupReport = await runPointQueueCleanup(pointDeviceId, 'pos/intent-cleanup')
        console.log(`[pos/intent] limpeza rápida: ${cleanupReport.intentsDeleted} deletados da API, ${cleanupReport.ordersCleaned} cancelados no banco, ${cleanupReport.ordersReconciled} reconciliados`)
      } catch (e) {
        console.warn(`[pos/intent] limpeza rápida falhou:`, e?.message)
      }

      // Tentar UMA VEZ mais
      try {
        console.log(`[pos/intent] tentando criar intent novamente...`)
        intent = await createIntent()
      } catch (retryErr) {
        if (isQueuedIntentConflict(retryErr)) {
          // Se continua 409, não conseguimos resolver via cleanup - sugere clear-queue
          const msg = cleanupReport?.likelyManualTerminalActionRequired
            ? 'Fila presa no terminal (intent não visível na API). Cancele a operação diretamente na maquininha e reinicie o modo integração.'
            : 'Fila da maquininha travada com intent não identificado. Execute: POST /api/payments/mercadopago/pos/clear-queue'
          console.error(`[pos/intent] ${msg}`)
          throw Object.assign(new Error(msg), {
            status: 503,
            payload: {
              ...retryErr?.payload,
              clearQueueRequired: true,
              manualTerminalActionRequired: Boolean(cleanupReport?.likelyManualTerminalActionRequired),
              cleanupReport,
            }
          })
        }
        throw retryErr
      }
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

function extractNotificationTopicAndResource(source) {
  const rawTopic =
    source.query?.topic ||
    source.query?.type ||
    source.body?.type ||
    source.body?.topic ||
    source.body?.action

  const rawResource =
    source.query?.resource ||
    source.query?.id ||
    source.body?.resource ||
    source.body?.id ||
    source.body?.data?.id

  const topic = String(rawTopic || '').toLowerCase()
  return { topic, rawResource: rawResource ? String(rawResource) : null }
}

async function processPointOrderNotification(orderId, notificationBody, sourceTag) {
  try {
    const action = String(notificationBody?.action || '').toLowerCase()
    const orderData = notificationBody?.data || {}
    const orderStatus = String(orderData.status || '').toLowerCase()
    const payments = orderData.transactions?.payments || []
    const payment = payments[0] || {}
    const paymentStatus = String(payment.status || '').toLowerCase()
    const paymentId = payment.id ? String(payment.id) : null

    console.log(
      `[${sourceTag}] order=${orderId} action=${action} status=${orderStatus} payment_status=${paymentStatus} payment_id=${paymentId}`,
    )

    if (!orderId) {
      console.warn(`[${sourceTag}] orderId ausente na notificação, ignorando`)
      return
    }

    const order = await store.getOrder(Number(orderId))
    if (!order) {
      console.warn(`[${sourceTag}] order ${orderId} não encontrada no banco`)
      return
    }

    // Mapeamento oficial de status da API Point
    if (action === 'order.processed' && orderStatus === 'processed') {
      // ✅ Pagamento confirmado - transição para "em montagem"
      console.log(`[${sourceTag}] ✅ Pagamento processado: order ${orderId}`, { paymentStatus, detail: payment.status_detail })
      await store.updateOrderFromPayment(order.id, paymentId, 'approved')
      await releasePointQueueForOrder(order, sourceTag)
    } else if (action === 'order.action_required') {
      // ⏳ Aguardando confirmação no terminal
      console.log(`[${sourceTag}] ⏳ Aguardando confirmação: order ${orderId}`)
    } else if (action === 'order.failed' && orderStatus === 'failed') {
      // ❌ Pagamento rejeitado
      console.log(`[${sourceTag}] ❌ Pagamento falhou: order ${orderId}`, { reason: payment.status_detail })
      await store.attachPaymentIntent(order.id, null)
    } else if (action === 'order.canceled' && orderStatus === 'canceled') {
      // ❌ Cancelado
      console.log(`[${sourceTag}] ❌ Order cancelada: ${orderId}`)
      await store.attachPaymentIntent(order.id, null)
    } else if (action === 'order.expired' && orderStatus === 'expired') {
      // ⏱️ Expirou
      console.log(`[${sourceTag}] ⏱️ Order expirada: ${orderId}`)
      await store.attachPaymentIntent(order.id, null)
    } else if (action !== 'order.refunded') {
      // order.refunded é ignorado por enquanto
      console.log(`[${sourceTag}] evento de order não reconhecido (aguardando tratamento): action=${action} status=${orderStatus}`)
    }
  } catch (err) {
    console.error(`[${sourceTag}] erro ao processar notificação de order:`, err?.message || err)
  }
}

function normalizePaymentState(status) {
  const normalized = String(status || '').toLowerCase().trim()
  // FINISHED é o status oficial do Point quando pagamento é completado
  if (normalized === 'finished' || normalized === 'approved' || normalized === 'authorized' || normalized === 'accredited' || normalized === 'processed') return 'approved'
  if (normalized === 'rejected' || normalized === 'refunded' || normalized === 'charged_back') return 'rejected'
  if (normalized === 'canceled' || normalized === 'cancelled' || normalized === 'error') return 'cancelled'
  return normalized
}

function isLikelyNonPointPayment(payment) {
  const paymentType = String(payment?.payment_type_id || '').toLowerCase()
  const pointType = String(payment?.point_of_interaction?.type || '').toLowerCase()
  const description = String(payment?.description || '').toLowerCase()

  if (pointType.includes('point') || pointType.includes('pos')) return false
  if (paymentType === 'bank_transfer') return true
  if (description.includes('pix')) return true
  return false
}

async function reconcileOrderByPointIntent(order, sourceTag) {
  if (!order?.paymentIntentId) return false

  try {
    const intent = await mpRequest(`/point/integration-api/payment-intents/${order.paymentIntentId}`)
    const payment = intent.payment ?? intent.transactions?.payments?.[0]
    const mpPaymentId = payment?.id ? String(payment.id) : null
    const normalizedStatus = normalizePaymentState(payment?.status ?? intent.state)

    if (normalizedStatus !== 'approved' && normalizedStatus !== 'rejected' && normalizedStatus !== 'cancelled') {
      return false
    }

    const freshOrder = await store.getOrder(order.id)
    if (!freshOrder) return false

    if (freshOrder.status === 'em montagem' || freshOrder.status === 'pronto' || freshOrder.status === 'retirado' || freshOrder.status === 'entregue') {
      await releasePointQueueForOrder(freshOrder, sourceTag)
      return true
    }

    const updated = await store.updateOrderFromPayment(freshOrder.id, mpPaymentId, normalizedStatus)
    if (normalizedStatus === 'approved' && mpPaymentId) {
      await store.createPayment({
        orderId: updated.id,
        provider: 'mercadopago',
        status: 'approved',
        providerRef: mpPaymentId,
        receiptCode: updated.code,
      })
      await clearPosOrder()
    }

    await releasePointQueueForOrder(freshOrder, sourceTag)
    console.log(`[${sourceTag}] intent ${order.paymentIntentId} reconciliado com status ${normalizedStatus} para pedido ${freshOrder.id}`)
    return true
  } catch (err) {
    console.warn(`[${sourceTag}] falha ao reconciliar intent ${order.paymentIntentId}:`, err?.payload || err?.message)
    return false
  }
}

async function releasePointQueueForOrder(order, sourceTag) {
  if (!order?.paymentIntentId) return
  try {
    await cancelPointIntent(order.paymentIntentId)
  } catch (err) {
    console.warn(`[${sourceTag}] falha ao cancelar intent ${order.paymentIntentId} durante release:`, err?.message)
  }
  try {
    await store.attachPaymentIntent(order.id, null)
  } catch (err) {
    console.warn(`[${sourceTag}] falha ao limpar vínculo de intent no pedido ${order.id}:`, err?.message)
  }
}

async function processPaymentNotification(paymentId, sourceTag) {
  try {
    console.log(`[${sourceTag}] consultando payment ${paymentId}...`)
    const payment = await mpRequest(`/v1/payments/${paymentId}`)
    const mpPaymentId = String(payment.id)
    const normalizedStatus = normalizePaymentState(payment.status)

    console.log(`[${sourceTag}] payment ${mpPaymentId} status=${normalizedStatus}`, {
      created: payment.created_date,
      description: payment.description,
      hasExternalRef: !!payment.external_reference,
    })

    let order = await resolveOrderByPaymentFallback(payment)
    if (!order) order = await resolveOrderByPaymentIdFromIntents(mpPaymentId)
    if (!order) {
      if (isLikelyNonPointPayment(payment)) {
        console.log(`[${sourceTag}] payment ${mpPaymentId} ignorado: parece ser PIX/não-Point e não tem vínculo com pedido local`)
        return
      }
      console.warn(`[${sourceTag}] payment ${mpPaymentId} sem pedido correspondente (debug: nenhuma estratégia em resolveOrderBy* funcionou)`)
      return
    }

    if (order.status === 'em montagem' || order.status === 'pronto' || order.status === 'retirado' || order.status === 'entregue') {
      console.log(`[${sourceTag}] payment ${mpPaymentId} já processado (order ${order.id} status=${order.status})`)
      return
    }

    const updated = await store.updateOrderFromPayment(order.id, mpPaymentId, normalizedStatus)
    if (normalizedStatus === 'approved') {
      await store.createPayment({
        orderId: updated.id,
        provider: 'mercadopago',
        status: 'approved',
        providerRef: mpPaymentId,
        receiptCode: updated.code,
      })
      console.log(`[${sourceTag}] ✅ payment ${mpPaymentId} aprovado para pedido ${order.id}`)
      await releasePointQueueForOrder(order, sourceTag)
      await clearPosOrder()
    } else if (normalizedStatus === 'rejected' || normalizedStatus === 'cancelled') {
      console.log(`[${sourceTag}] ❌ payment ${mpPaymentId} finalizou com status ${normalizedStatus} para pedido ${order.id}`)
      await releasePointQueueForOrder(order, sourceTag)
    }
  } catch (err) {
    console.error(`[${sourceTag}] erro ao processar payment:`, err?.message || err)
  }
}

async function processMerchantOrderNotification(merchantOrderId, sourceTag) {
  const mo = await mpRequest(`/merchant_orders/${merchantOrderId}`)
  const approvedPayment = (mo.payments || []).find((p) => normalizePaymentState(p.status) === 'approved')
  if (!approvedPayment) return

  const orderId = Number(mo.external_reference)
  if (Number.isNaN(orderId)) return

  const order = await store.getOrder(orderId)
  if (!order) return
  if (order.status === 'em montagem' || order.status === 'pronto' || order.status === 'retirado' || order.status === 'entregue') return

  const mpPaymentId = String(approvedPayment.id)
  const updated = await store.updateOrderFromPayment(order.id, mpPaymentId, 'approved')
  await store.createPayment({
    orderId: updated.id,
    provider: 'mercadopago',
    status: 'approved',
    providerRef: mpPaymentId,
    receiptCode: updated.code,
  })
  console.log(`[${sourceTag}] merchant_order ${merchantOrderId} aprovou pedido ${orderId}`)
  await releasePointQueueForOrder(order, sourceTag)
  await clearPosOrder()
}

async function processPointIntentNotification(intentId, sourceTag) {
  try {
    const intent = await mpRequest(`/point/integration-api/payment-intents/${intentId}`)
    const payment = intent.payment ?? intent.transactions?.payments?.[0]
    const mpPaymentId = payment?.id ? String(payment.id) : null
    const intentState = payment?.status ?? intent.state
    const normalizedStatus = normalizePaymentState(intentState)

    console.log(`[${sourceTag}] processando intent ${intentId}: state=${intent.state}, payment.status=${payment?.status}, normalizado=${normalizedStatus}`)

    const resolvedOrderId = Number(intent.additional_info?.external_reference ?? intent.external_reference)
    let order = null
    if (!Number.isNaN(resolvedOrderId)) order = await store.getOrder(resolvedOrderId)
    if (!order) order = await store.findOrderByPaymentIntentId(String(intentId))
    if (!order) {
      console.warn(`[${sourceTag}] intent ${intentId} sem pedido correspondente`)
      return
    }

    if (order.status !== 'aguardando pagamento') {
      console.log(`[${sourceTag}] intent ${intentId} para pedido ${order.id} que já está em status ${order.status}, ignorando`)
      return
    }

    const updated = await store.updateOrderFromPayment(order.id, mpPaymentId, normalizedStatus)
    if (normalizedStatus === 'approved' && mpPaymentId) {
      await store.createPayment({
        orderId: updated.id,
        provider: 'mercadopago',
        status: 'approved',
        providerRef: mpPaymentId,
        receiptCode: updated.code,
      })
      console.log(`[${sourceTag}] ✅ point_intent ${intentId} APROVADO para pedido ${order.id}`)
      await releasePointQueueForOrder(order, sourceTag)
      await clearPosOrder()
    } else if (normalizedStatus === 'rejected' || normalizedStatus === 'cancelled') {
      console.log(`[${sourceTag}] ❌ point_intent ${intentId} ${normalizedStatus.toUpperCase()} para pedido ${order.id}`)
      await releasePointQueueForOrder(order, sourceTag)
    } else {
      console.log(`[${sourceTag}] ⏳ point_intent ${intentId} status ${normalizedStatus} para pedido ${order.id}, aguardando...`)
    }
  } catch (err) {
    console.error(`[${sourceTag}] erro ao processar intent ${intentId}:`, {
      status: err?.status,
      payload: err?.payload,
      message: err?.message,
    })
  }
}

async function processMercadoPagoNotification(source, sourceTag) {
  const { topic, rawResource } = extractNotificationTopicAndResource(source)
  const resourceId = rawResource ? rawResource.split('/').pop() : null

  console.log(`[${sourceTag}] recebido topic=${topic} resource=${resourceId}`)

  if (!topic || !resourceId) return

  // API NOVA do Mercado Pago Point (atual)
  // Webhooks de order: order.processed, order.action_required, order.failed, order.canceled, order.refunded, order.expired
  if (topic === 'order.processed' || topic === 'order.action_required' || topic === 'order.failed' || topic === 'order.canceled' || topic === 'order.refunded' || topic === 'order.expired') {
    await processPointOrderNotification(resourceId, source.body, sourceTag)
    return
  }

  // Webhooks antigos/legados (compatibilidade)
  if (topic === 'payment' || topic.startsWith('payment.')) {
    await processPaymentNotification(resourceId, sourceTag)
    return
  }

  if (topic === 'merchant_order' || topic.startsWith('merchant_order.')) {
    await processMerchantOrderNotification(resourceId, sourceTag)
    return
  }

  // IPN clássico do Point (API legada)
  if (
    topic === 'point_integration_ipn' ||
    topic === 'payment_intent' ||
    topic.startsWith('point_integration_ipn.') ||
    topic.startsWith('payment_intent.')
  ) {
    await processPointIntentNotification(resourceId, sourceTag)
  }
}

// Endpoint principal de IPN (responde imediatamente e processa em background)
function handleMercadoPagoIpn(req, res, sourceTag) {
  console.log(`[${sourceTag}] recebido:`, JSON.stringify({ method: req.method, query: req.query, body: req.body }))
  res.status(200).send('OK')

  setImmediate(async () => {
    try {
      await processMercadoPagoNotification({ query: req.query, body: req.body }, sourceTag)
    } catch (err) {
      console.error(`[${sourceTag}] erro no processamento:`, err)
    }
  })
}

app.post('/api/notifications/mercadopago', (req, res) => handleMercadoPagoIpn(req, res, 'ipn'))
// O botão "Experimentar" do Mercado Pago pode enviar GET com query params.
app.get('/api/notifications/mercadopago', (req, res) => handleMercadoPagoIpn(req, res, 'ipn-get'))

// Mantém compatibilidade com webhook antigo, mas no mesmo pipeline do IPN
app.post('/api/payments/mercadopago/pos/webhook', (req, res) => {
  console.log('[webhook] recebido:', JSON.stringify(req.body))
  res.status(200).json({ received: true })

  setImmediate(async () => {
    try {
      await processMercadoPagoNotification({ query: req.query, body: req.body }, 'webhook')
    } catch (err) {
      console.error('[webhook] erro no processamento:', err)
    }
  })
})

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

app.listen(config.port, () => {
  console.log(`Backend running on port ${config.port}`)
})
