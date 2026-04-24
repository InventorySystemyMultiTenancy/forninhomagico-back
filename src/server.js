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

async function resolveOrderByPaymentIdFromIntents(paymentId) {
  const orders = await store.listOrders()
  const candidates = orders.filter((order) => {
    if (!order.paymentIntentId) return false
    if (order.status === 'cancelado') return false
    if (order.status === 'em montagem' || order.status === 'pronto' || order.status === 'retirado' || order.status === 'entregue') return false
    return true
  })

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
        return order
      }
    } catch (err) {
      console.warn(`[webhook] falha ao consultar intent ${order.paymentIntentId}:`, err?.payload || err?.message)
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
  const { pointDeviceId } = config.mercadoPago
  if (!pointDeviceId || !intentId) return

  try {
    await mpRequest(
      `/point/integration-api/devices/${pointDeviceId}/payment-intents/${intentId}`,
      { method: 'DELETE' },
    )
    console.log(`[pos] intent ${intentId} cancelado na maquininha`)
  } catch (err) {
    // Não falha se intent não existe na API (pode ter já sido deletado)
    if (err?.status === 404) {
      console.log(`[pos] intent ${intentId} já não existe na maquininha`)
      return
    }
    throw err // relança outros erros
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

app.post('/api/payments/mercadopago/pos/clear-queue', async (_req, res) => {
  const { pointDeviceId } = config.mercadoPago
  if (!pointDeviceId) {
    return res.status(503).json({
      error: 'Maquininha não configurada',
    })
  }

  try {
    console.log('[clear-queue] iniciando limpeza forçada da fila...')

    let intentsDeleted = 0
    let intentsFailedToDelete = []
    
    try {
      console.log('[clear-queue] listando intents da API...')
      const response = await mpRequest(`/point/integration-api/devices/${pointDeviceId}/payment-intents`)
      const intents = Array.isArray(response) ? response : (Array.isArray(response?.results) ? response.results : [])
      console.log(`[clear-queue] encontrados ${intents.length} intents`)

      for (const intent of intents) {
        if (intent?.id) {
          try {
            await mpRequest(
              `/point/integration-api/devices/${pointDeviceId}/payment-intents/${intent.id}`,
              { method: 'DELETE' },
            )
            console.log(`[clear-queue] intent ${intent.id} deletado`)
            intentsDeleted++
          } catch (err) {
            console.warn(`[clear-queue] falha ao deletar intent ${intent.id}:`, err?.payload?.error || err?.message)
            intentsFailedToDelete.push(intent.id)
          }
        }
      }
    } catch (err) {
      console.warn('[clear-queue] não conseguiu listar intents da API:', err?.payload || err?.message)
    }

    // Fallback importante: tenta cancelar intents já vinculados no banco
    // (quando listagem da API falha, ainda conseguimos limpar a fila da maquininha)
    const allOrders = await store.listOrders()
    let ordersCleaned = 0
    let ordersReconciled = 0
    for (const order of allOrders) {
      if (order.paymentIntentId) {
        try {
          const reconciled = await reconcileOrderByPointIntent(order, 'clear-queue')
          if (reconciled) {
            ordersReconciled++
            continue
          }

          await cancelPointIntent(order.paymentIntentId)
          await store.attachPaymentIntent(order.id, null)
          ordersCleaned++
        } catch (err) {
          console.warn(`[clear-queue] falha ao limpar intent do pedido ${order.id}:`, err?.message)
        }
      }
    }

    console.log(`[clear-queue] concluído: ${intentsDeleted} intents deletados (${intentsFailedToDelete.length} falharam), ${ordersCleaned} pedidos limpos no banco, ${ordersReconciled} pedidos reconciliados`)
    return res.json({
      success: true,
      intentsDeleted,
      intentsFailedToDelete: intentsFailedToDelete.length > 0 ? intentsFailedToDelete : undefined,
      ordersCleaned,
      ordersReconciled,
      message: intentsFailedToDelete.length > 0 
        ? `${intentsDeleted} intents deletados, mas ${intentsFailedToDelete.length} não conseguiram ser deletados. Tente novamente ou use POST /api/payments/mercadopago/pos/force-reset`
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
    let lastError
    const MAX_RETRIES = 3
    const INITIAL_DELAY = 500 // ms

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        intent = await createIntent()
        break // sucesso, sai do loop
      } catch (err) {
        lastError = err
        if (!isQueuedIntentConflict(err)) throw err // não é 409, relança

        if (attempt < MAX_RETRIES) {
          console.log(`[pos/intent] tentativa ${attempt}/${MAX_RETRIES}: 409 detectado, limpando intents...`)

          // Cleanup agressivo em cada retry:
          // 1. Lista intents da API e deleta todos
          try {
            const response = await mpRequest(`/point/integration-api/devices/${pointDeviceId}/payment-intents`)
            const intents = Array.isArray(response) ? response : (Array.isArray(response?.results) ? response.results : [])
            for (const i of intents) {
              if (i?.id) {
                await cancelPointIntent(String(i.id))
              }
            }
            console.log(`[pos/intent] ${intents.length} intent(s) deletado(s) da API`)
          } catch (e) {
            console.warn(`[pos/intent] não conseguiu listar intents da API:`, e?.message)
          }

          // 2. Cancela intents conhecidos pelo banco e remove vínculo
          try {
            const allOrders = await store.listOrders('aguardando pagamento')
            let cancelledFromDb = 0
            let reconciledFromDb = 0
            for (const o of allOrders) {
              if (o.paymentIntentId) {
                try {
                  const reconciled = await reconcileOrderByPointIntent(o, 'pos/intent-retry')
                  if (reconciled) {
                    reconciledFromDb++
                    continue
                  }

                  await cancelPointIntent(o.paymentIntentId)
                  await store.attachPaymentIntent(o.id, null)
                  cancelledFromDb++
                } catch (cancelErr) {
                  console.warn(`[pos/intent] falha ao cancelar intent ${o.paymentIntentId} no device:`, cancelErr?.message)
                }
              }
            }
            console.log(`[pos/intent] intents tratados no fallback (${cancelledFromDb} cancelados, ${reconciledFromDb} reconciliados)`)
          } catch (e) {
            console.warn(`[pos/intent] erro ao atualizar banco:`, e?.message)
          }

          // Delay antes da próxima tentativa (exponencial: 500ms, 1s, 2s)
          const delayMs = INITIAL_DELAY * Math.pow(2, attempt - 1)
          console.log(`[pos/intent] aguardando ${delayMs}ms antes de tentar novamente...`)
          await new Promise(resolve => setTimeout(resolve, delayMs))
        }
      }
    }

    // Se chegou aqui, intent ainda não foi criado
    if (!intent) {
      const msg = `Não conseguiu criar intent após ${MAX_RETRIES} tentativas. A fila da maquininha pode estar travada. Use POST /api/payments/mercadopago/pos/clear-queue`
      console.error(`[pos/intent] ${msg}`)
      throw Object.assign(new Error(msg), { status: 503, payload: lastError?.payload })
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

function normalizePaymentState(status) {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'finished' || normalized === 'approved' || normalized === 'authorized' || normalized === 'accredited') return 'approved'
  if (normalized === 'rejected' || normalized === 'refunded' || normalized === 'charged_back') return 'rejected'
  if (normalized === 'canceled' || normalized === 'cancelled' || normalized === 'error') return 'cancelled'
  return normalized
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
  const payment = await mpRequest(`/v1/payments/${paymentId}`)
  const mpPaymentId = String(payment.id)
  const normalizedStatus = normalizePaymentState(payment.status)

  let order = await resolveOrderByPaymentFallback(payment)
  if (!order) order = await resolveOrderByPaymentIdFromIntents(mpPaymentId)
  if (!order) {
    console.warn(`[${sourceTag}] payment ${mpPaymentId} sem pedido correspondente`)
    return
  }

  if (order.status === 'em montagem' || order.status === 'pronto' || order.status === 'retirado' || order.status === 'entregue') {
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
    console.log(`[${sourceTag}] payment ${mpPaymentId} aprovado para pedido ${order.id}`)
    await releasePointQueueForOrder(order, sourceTag)
    await clearPosOrder()
  } else if (normalizedStatus === 'rejected' || normalizedStatus === 'cancelled') {
    console.log(`[${sourceTag}] payment ${mpPaymentId} finalizou com status ${normalizedStatus} para pedido ${order.id}`)
    await releasePointQueueForOrder(order, sourceTag)
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
  const intent = await mpRequest(`/point/integration-api/payment-intents/${intentId}`)
  const payment = intent.payment ?? intent.transactions?.payments?.[0]
  const mpPaymentId = payment?.id ? String(payment.id) : null
  const normalizedStatus = normalizePaymentState(payment?.status ?? intent.state)

  const resolvedOrderId = Number(intent.additional_info?.external_reference ?? intent.external_reference)
  let order = null
  if (!Number.isNaN(resolvedOrderId)) order = await store.getOrder(resolvedOrderId)
  if (!order) order = await store.findOrderByPaymentIntentId(String(intentId))
  if (!order) {
    console.warn(`[${sourceTag}] intent ${intentId} sem pedido correspondente`)
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
    console.log(`[${sourceTag}] point_intent ${intentId} aprovado para pedido ${order.id}`)
    await releasePointQueueForOrder(order, sourceTag)
    await clearPosOrder()
  } else if (normalizedStatus === 'rejected' || normalizedStatus === 'cancelled') {
    console.log(`[${sourceTag}] point_intent ${intentId} finalizado com status ${normalizedStatus} para pedido ${order.id}`)
    await releasePointQueueForOrder(order, sourceTag)
  }
}

async function processMercadoPagoNotification(source, sourceTag) {
  const { topic, rawResource } = extractNotificationTopicAndResource(source)
  const resourceId = rawResource ? rawResource.split('/').pop() : null

  console.log(`[${sourceTag}] recebido topic=${topic} resource=${resourceId}`)

  if (!topic || !resourceId) return

  if (topic === 'payment' || topic.startsWith('payment.')) {
    await processPaymentNotification(resourceId, sourceTag)
    return
  }

  if (topic === 'merchant_order' || topic.startsWith('merchant_order.')) {
    await processMerchantOrderNotification(resourceId, sourceTag)
    return
  }

  // IPN clássico do Point
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
