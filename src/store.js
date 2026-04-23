const db = require('./db')

// ─── Flavors ──────────────────────────────────────────────────────────────────

async function listFlavors() {
  const { rows } = await db.query(
    `SELECT id, name, image_url AS "imageUrl", price_cents AS "priceCents", slices_total AS "slicesTotal",
            slices_available AS "slicesAvailable", is_active AS active
     FROM flavors ORDER BY id`,
  )
  return rows
}

async function createFlavor(payload) {
  const { rows } = await db.query(
    `INSERT INTO flavors (name, image_url, price_cents, slices_total, slices_available, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, image_url AS "imageUrl", price_cents AS "priceCents", slices_total AS "slicesTotal",
               slices_available AS "slicesAvailable", is_active AS active`,
    [payload.name, payload.imageUrl || null, payload.priceCents, payload.slicesTotal, payload.slicesAvailable, payload.active ?? true],
  )
  return rows[0]
}

async function updateFlavor(id, payload) {
  const map = {
    name: 'name',
    imageUrl: 'image_url',
    priceCents: 'price_cents',
    slicesTotal: 'slices_total',
    slicesAvailable: 'slices_available',
    active: 'is_active',
  }
  const setClauses = []
  const values = []
  let i = 1
  for (const [key, val] of Object.entries(payload)) {
    const col = map[key]
    if (col) {
      setClauses.push(`${col} = $${i++}`)
      values.push(val)
    }
  }
  if (setClauses.length === 0) return null
  values.push(id)
  const { rows } = await db.query(
    `UPDATE flavors SET ${setClauses.join(', ')}, updated_at = NOW()
     WHERE id = $${i}
     RETURNING id, name, image_url AS "imageUrl", price_cents AS "priceCents", slices_total AS "slicesTotal",
               slices_available AS "slicesAvailable", is_active AS active`,
    values,
  )
  return rows[0] || null
}

async function addSlices(id, amount) {
  const { rows } = await db.query(
    `UPDATE flavors
     SET slices_available = slices_available + $2,
         slices_total = slices_total + $2,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, image_url AS "imageUrl", price_cents AS "priceCents", slices_total AS "slicesTotal",
               slices_available AS "slicesAvailable", is_active AS active`,
    [id, amount],
  )
  return rows[0] || null
}

// ─── Costs ────────────────────────────────────────────────────────────────────

async function listCosts() {
  const { rows } = await db.query(
    `SELECT id, label, amount_cents AS "amountCents", cadence, category
     FROM costs WHERE is_active = true ORDER BY category, id`,
  )
  return rows
}

async function createCost(payload) {
  const { rows } = await db.query(
    `INSERT INTO costs (label, amount_cents, cadence, category)
     VALUES ($1, $2, $3, $4)
     RETURNING id, label, amount_cents AS "amountCents", cadence, category`,
    [payload.label, payload.amountCents, payload.cadence, payload.category || 'operational'],
  )
  return rows[0]
}

async function deleteCost(id) {
  const { rowCount } = await db.query(
    `UPDATE costs SET is_active = false WHERE id = $1`,
    [id],
  )
  return rowCount > 0
}

// ─── Orders ───────────────────────────────────────────────────────────────────

const ORDER_SELECT = `
  SELECT o.id, o.order_code, o.customer_name, o.payment_method, o.status, o.total_cents, o.created_at, o.paid_at,
         o.payment_intent_id, oi.flavor_id, f.name AS flavor_name, oi.qty
  FROM orders o
  LEFT JOIN order_items oi ON oi.order_id = o.id
  LEFT JOIN flavors f ON f.id = oi.flavor_id`

function rowToOrder(row) {
  return {
    id: row.id,
    code: row.order_code,
    customerName: row.customer_name || null,
    paymentMethod: row.payment_method || 'point',
    flavorId: row.flavor_id || null,
    flavorName: row.flavor_name || null,
    qty: row.qty ? Number(row.qty) : null,
    status: row.status,
    totalCents: Number(row.total_cents),
    createdAt: row.created_at,
    paidAt: row.paid_at,
    paymentIntentId: row.payment_intent_id || null,
  }
}

async function listOrders(status) {
  const params = []
  const where = status ? 'WHERE o.status = $1' : ''
  if (status) params.push(status)
  const { rows } = await db.query(
    `${ORDER_SELECT} ${where} ORDER BY o.created_at DESC`,
    params,
  )
  return rows.map(rowToOrder)
}

async function getOrder(orderId) {
  const { rows } = await db.query(`${ORDER_SELECT} WHERE o.id = $1`, [orderId])
  return rows[0] ? rowToOrder(rows[0]) : null
}

async function findOrderByPaymentIntentId(paymentIntentId) {
  const { rows } = await db.query(
    `${ORDER_SELECT} WHERE o.payment_intent_id = $1`,
    [paymentIntentId],
  )
  return rows[0] ? rowToOrder(rows[0]) : null
}

async function createOrder(payload) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    const { rows: fRows } = await client.query(
      `SELECT id, name, price_cents, slices_available, is_active
       FROM flavors WHERE id = $1 FOR UPDATE`,
      [payload.flavorId],
    )
    const flavor = fRows[0]

    if (!flavor || !flavor.is_active) {
      await client.query('ROLLBACK')
      return { error: 'Flavor unavailable' }
    }
    if (flavor.slices_available < payload.qty) {
      await client.query('ROLLBACK')
      return { error: 'Insufficient slices' }
    }

    await client.query(
      `UPDATE flavors SET slices_available = slices_available - $2, updated_at = NOW() WHERE id = $1`,
      [flavor.id, payload.qty],
    )

    const totalCents = payload.qty * flavor.price_cents
    const { rows: oRows } = await client.query(
      `INSERT INTO orders (status, total_cents, payment_method, customer_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, order_code, customer_name, payment_method, status, total_cents, created_at, paid_at, payment_intent_id`,
      ['aguardando pagamento', totalCents, payload.paymentMethod || 'point', payload.customerName || null],
    )
    const order = oRows[0]

    await client.query(
      `INSERT INTO order_items (order_id, flavor_id, qty, price_cents) VALUES ($1, $2, $3, $4)`,
      [order.id, flavor.id, payload.qty, flavor.price_cents],
    )

    await client.query('COMMIT')
    return {
      id: order.id,
      code: order.order_code,
      customerName: order.customer_name || null,
      paymentMethod: order.payment_method,
      flavorId: flavor.id,
      flavorName: flavor.name,
      qty: payload.qty,
      status: order.status,
      totalCents: Number(order.total_cents),
      createdAt: order.created_at,
      paidAt: null,
      paymentIntentId: null,
    }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

async function attachPaymentIntent(orderId, paymentIntentId) {
  const { rowCount } = await db.query(
    `UPDATE orders SET payment_intent_id = $2 WHERE id = $1`,
    [orderId, paymentIntentId],
  )
  return rowCount > 0
}

async function markOrderPaid(orderId, paymentId) {
  const code = paymentId ? String(paymentId).slice(-3) : null
  await db.query(
    `UPDATE orders SET status = 'em montagem', paid_at = NOW(), order_code = $2 WHERE id = $1`,
    [orderId, code],
  )
  return getOrder(orderId)
}

async function updateOrderStatus(orderId, status) {
  const { rowCount } = await db.query(
    `UPDATE orders SET status = $2 WHERE id = $1`,
    [orderId, status],
  )
  if (!rowCount) return null
  return getOrder(orderId)
}

async function updateOrderFromPayment(orderId, paymentId, status) {
  if (status === 'approved') return markOrderPaid(orderId, paymentId)
  const newStatus =
    status === 'rejected' ? 'pagamento recusado'
    : status === 'cancelled' || status === 'canceled' ? 'cancelado'
    : status
  return updateOrderStatus(orderId, newStatus)
}

async function cancelOrder(orderId) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    const { rows } = await client.query(
      `SELECT o.id, o.status, oi.flavor_id, oi.qty
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.id = $1`,
      [orderId],
    )
    if (!rows[0]) { await client.query('ROLLBACK'); return null }

    const { status, flavor_id, qty } = rows[0]
    const nonCancellable = ['em montagem', 'pronto', 'cancelado']
    if (nonCancellable.includes(status)) {
      await client.query('ROLLBACK')
      return { error: `Pedido não pode ser cancelado (status: ${status})` }
    }

    // Restaura estoque se pedido ainda não foi pago
    if (flavor_id && qty && status === 'aguardando pagamento') {
      await client.query(
        `UPDATE flavors SET slices_available = slices_available + $2, updated_at = NOW() WHERE id = $1`,
        [flavor_id, qty],
      )
    }

    await client.query(`UPDATE orders SET status = 'cancelado' WHERE id = $1`, [orderId])
    await client.query('COMMIT')
    return getOrder(orderId)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ─── Payments ─────────────────────────────────────────────────────────────────

async function createPayment(payload) {
  const { rows } = await db.query(
    `INSERT INTO payments (order_id, provider, status, provider_ref, receipt_code)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, order_id AS "orderId", provider, status,
               provider_ref AS "providerRef", receipt_code AS "receiptCode", created_at AS "createdAt"`,
    [payload.orderId, payload.provider, payload.status, payload.providerRef || null, payload.receiptCode || null],
  )
  return rows[0]
}

// ─── Stats ────────────────────────────────────────────────────────────────────

async function getStats() {
  const NON_CANCELLED = `status != 'cancelado'`
  const PAID = `status IN ('em montagem', 'pronto', 'retirado', 'entregue')`
  const { rows: t } = await db.query(`SELECT COUNT(*) AS total FROM orders WHERE ${NON_CANCELLED}`)
  const { rows: p } = await db.query(`SELECT COUNT(*) AS paid FROM orders WHERE ${PAID}`)
  const { rows: pend } = await db.query(`SELECT COUNT(*) AS pending FROM orders WHERE status = 'aguardando pagamento'`)
  const { rows: c } = await db.query(`SELECT COUNT(*) AS cancelled FROM orders WHERE status = 'cancelado'`)
  return {
    totalOrders: Number(t[0].total),
    paidOrders: Number(p[0].paid),
    pendingOrders: Number(pend[0].pending),
    cancelledOrders: Number(c[0].cancelled),
  }
}

// ─── Financials ───────────────────────────────────────────────────────────────

async function getFinancials() {
  const PAID_STATUSES = `('em montagem', 'pronto', 'entregue', 'retirado')`
  const { rows: g } = await db.query(
    `SELECT COALESCE(SUM(total_cents), 0) AS gross FROM orders WHERE status IN ${PAID_STATUSES}`,
  )
  const { rows: op } = await db.query(
    `SELECT COALESCE(SUM(amount_cents), 0) AS costs FROM costs WHERE is_active = true AND category = 'operational'`,
  )
  const { rows: pr } = await db.query(
    `SELECT COALESCE(SUM(amount_cents), 0) AS costs FROM costs WHERE is_active = true AND category = 'product'`,
  )
  const gross = Number(g[0].gross)
  const operationalCosts = Number(op[0].costs)
  const productCosts = Number(pr[0].costs)
  const totalCosts = operationalCosts + productCosts
  return { gross, operationalCosts, productCosts, totalCosts, net: gross - totalCosts }
}

module.exports = {
  listFlavors,
  createFlavor,
  updateFlavor,
  addSlices,
  listCosts,
  createCost,
  deleteCost,
  listOrders,
  getOrder,
  findOrderByPaymentIntentId,
  createOrder,
  attachPaymentIntent,
  markOrderPaid,
  updateOrderStatus,
  updateOrderFromPayment,
  cancelOrder,
  createPayment,
  getStats,
  getFinancials,
}
