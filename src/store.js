const { randomInt } = require('crypto')

const store = {
  flavors: [
    {
      id: 1,
      name: 'Brigadeiro da Casa',
      priceCents: 1200,
      slicesTotal: 30,
      slicesAvailable: 18,
      active: true,
    },
    {
      id: 2,
      name: 'Doce de Leite Fino',
      priceCents: 1100,
      slicesTotal: 24,
      slicesAvailable: 4,
      active: true,
    },
  ],
  costs: [
    { id: 1, label: 'Leite condensado', amountCents: 28000, cadence: 'monthly' },
    { id: 2, label: 'Gas e energia', amountCents: 19000, cadence: 'monthly' },
  ],
  orders: [],
  payments: [],
}

const counters = {
  flavorId: store.flavors.length + 1,
  costId: store.costs.length + 1,
  orderId: 1000,
  paymentId: 1,
}

function generateOrderCode() {
  return String(randomInt(0, 1000)).padStart(3, '0')
}

function listFlavors() {
  return store.flavors
}

function createFlavor(payload) {
  const flavor = {
    id: counters.flavorId++,
    name: payload.name,
    priceCents: payload.priceCents,
    slicesTotal: payload.slicesTotal,
    slicesAvailable: payload.slicesAvailable,
    active: payload.active ?? true,
  }
  store.flavors.push(flavor)
  return flavor
}

function updateFlavor(id, payload) {
  const flavor = store.flavors.find((item) => item.id === id)
  if (!flavor) return null
  Object.assign(flavor, payload)
  return flavor
}

function addSlices(id, amount) {
  const flavor = store.flavors.find((item) => item.id === id)
  if (!flavor) return null
  flavor.slicesTotal += amount
  flavor.slicesAvailable += amount
  return flavor
}

function listCosts() {
  return store.costs
}

function createCost(payload) {
  const cost = {
    id: counters.costId++,
    label: payload.label,
    amountCents: payload.amountCents,
    cadence: payload.cadence,
  }
  store.costs.push(cost)
  return cost
}

function listOrders(status) {
  if (!status) return store.orders
  return store.orders.filter((order) => order.status === status)
}

function createOrder(payload) {
  const flavor = store.flavors.find((item) => item.id === payload.flavorId)
  if (!flavor || !flavor.active) {
    return { error: 'Flavor unavailable' }
  }
  if (flavor.slicesAvailable < payload.qty) {
    return { error: 'Insufficient slices' }
  }

  flavor.slicesAvailable -= payload.qty

  const totalCents = payload.qty * flavor.priceCents
  const order = {
    id: counters.orderId++,
    code: generateOrderCode(),
    flavorId: flavor.id,
    flavorName: flavor.name,
    qty: payload.qty,
    status: 'aguardando pagamento',
    totalCents,
    createdAt: new Date().toISOString(),
    paidAt: null,
  }

  store.orders.push(order)
  return order
}

function markOrderPaid(orderId) {
  const order = store.orders.find((item) => item.id === orderId)
  if (!order) return null
  order.status = 'em montagem'
  order.paidAt = new Date().toISOString()
  return order
}

function updateOrderStatus(orderId, status) {
  const order = store.orders.find((item) => item.id === orderId)
  if (!order) return null
  order.status = status
  return order
}

function createPayment(payload) {
  const payment = {
    id: counters.paymentId++,
    orderId: payload.orderId,
    provider: payload.provider,
    status: payload.status,
    providerRef: payload.providerRef,
    receiptCode: payload.receiptCode,
    createdAt: new Date().toISOString(),
  }
  store.payments.push(payment)
  return payment
}

function getFinancials() {
  const gross = store.orders
    .filter((order) => order.status !== 'aguardando pagamento')
    .reduce((total, order) => total + order.totalCents, 0)
  const costs = store.costs.reduce((total, cost) => total + cost.amountCents, 0)
  const net = gross - costs
  return { gross, costs, net }
}

module.exports = {
  listFlavors,
  createFlavor,
  updateFlavor,
  addSlices,
  listCosts,
  createCost,
  listOrders,
  createOrder,
  markOrderPaid,
  updateOrderStatus,
  createPayment,
  getFinancials,
}
