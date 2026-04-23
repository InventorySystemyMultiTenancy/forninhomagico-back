import { MercadoPagoConfig, Payment as MPPayment } from "mercadopago";
import { Prisma } from "@prisma/client";
import { AppError } from "../errors/AppError.js";
import { OrderRepository } from "../repositories/OrderRepository.js";
import { PaymentRepository } from "../repositories/PaymentRepository.js";
import { ProductRepository } from "../repositories/ProductRepository.js";
import {
  emitOrderCreated,
  emitOrderStatusUpdated,
  emitPaymentUpdated,
} from "../realtime/socketServer.js";

const ORDER_TRANSITIONS = {
  RECEBIDO: ["PREPARANDO"],
  PREPARANDO: ["NO_FORNO"],
  NO_FORNO: ["SAIU_PARA_ENTREGA"],
  SAIU_PARA_ENTREGA: ["ENTREGUE"],
  ENTREGUE: [],
};

const PAYMENT_STATUS_MAP = {
  approved: "APROVADO",
  rejected: "RECUSADO",
  cancelled: "RECUSADO",
  refunded: "ESTORNADO",
  in_process: "PENDENTE",
  pending: "PENDENTE",
};

const toCents = (value) => Math.round(Number(value) * 100);
const fromCents = (value) => (value / 100).toFixed(2);
const startOfDay = (date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());
const startOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1);

export class OrderService {
  constructor(
    orderRepository = new OrderRepository(),
    productRepository = new ProductRepository(),
    paymentRepository = new PaymentRepository(),
  ) {
    this.orderRepository = orderRepository;
    this.productRepository = productRepository;
    this.paymentRepository = paymentRepository;
  }

  async createOrder({
    userId,
    mesaId,
    deliveryAddress,
    notes,
    items,
    paymentMethod,
    deliveryFee,
    deliveryLat,
    deliveryLon,
    isPickup,
  }) {
    if (!userId && !mesaId) {
      throw new AppError(
        "Pedido deve ser vinculado a um usuario ou mesa.",
        422,
      );
    }

    if (!items?.length) {
      throw new AppError("Pedido deve conter ao menos 1 item.", 422);
    }

    const normalizedItems = [];

    for (const item of items) {
      if (item.type === "INTEIRA") {
        const normalized = await this.#normalizeWholeItem(item);
        normalizedItems.push(normalized);
        continue;
      }

      if (item.type === "MEIO_A_MEIO") {
        const normalized = await this.#normalizeHalfHalfItem(item);
        normalizedItems.push(normalized);
        continue;
      }

      throw new AppError("Tipo de item invalido.", 422);
    }

    const totalCents = normalizedItems.reduce(
      (acc, item) => acc + item.totalPriceCents,
      0,
    );

    const order = await this.orderRepository.createOrder({
      ...(userId ? { userId } : {}),
      ...(mesaId ? { mesaId } : {}),
      deliveryAddress: deliveryAddress ?? null,
      notes,
      total: new Prisma.Decimal(fromCents(totalCents)),
      paymentStatus: "PENDENTE",
      ...(isPickup != null ? { isPickup } : {}),
      ...(isPickup
        ? {}
        : { deliveryCode: String(Math.floor(1000 + Math.random() * 9000)) }),
      ...(paymentMethod != null ? { paymentMethod } : {}),
      ...(deliveryFee != null
        ? { deliveryFee: new Prisma.Decimal(deliveryFee) }
        : {}),
      ...(deliveryLat != null ? { deliveryLat } : {}),
      ...(deliveryLon != null ? { deliveryLon } : {}),
      items: {
        create: normalizedItems.map((item) => ({
          quantity: item.quantity,
          type: item.type,
          size: item.size,
          unitPrice: new Prisma.Decimal(fromCents(item.unitPriceCents)),
          totalPrice: new Prisma.Decimal(fromCents(item.totalPriceCents)),
          ...(item.crustUnitPriceCents != null
            ? {
                crustUnitPrice: new Prisma.Decimal(
                  fromCents(item.crustUnitPriceCents),
                ),
              }
            : {}),
          productId: item.productId,
          firstHalfProductId: item.firstHalfProductId,
          secondHalfProductId: item.secondHalfProductId,
          crustProductId: item.crustProductId,
        })),
      },
      payment: {
        create: {
          provider: "MERCADO_PAGO",
          amount: new Prisma.Decimal(fromCents(totalCents)),
          status: "PENDENTE",
          payload: {
            paymentMethod: paymentMethod || "nao_informado",
          },
        },
      },
    });

    emitOrderCreated({
      orderId: order.id,
      userId: order.userId,
      mesaId: order.mesaId,
      status: order.status,
      total: Number(order.total),
    });

    return order;
  }

  async cancelOrder(orderId) {
    const order = await this.orderRepository.findById(orderId);

    if (!order) {
      throw new AppError("Pedido nao encontrado.", 404);
    }

    if (order.status === "ENTREGUE") {
      throw new AppError("Pedido ja entregue nao pode ser cancelado.", 409);
    }

    if (order.status === "CANCELADO") {
      throw new AppError("Pedido ja esta cancelado.", 409);
    }

    const updatedOrder = await this.orderRepository.updateStatus(
      orderId,
      "CANCELADO",
    );

    emitOrderStatusUpdated({
      orderId: updatedOrder.id,
      userId: order.userId,
      previousStatus: order.status,
      status: "CANCELADO",
      paymentWasPending: order.paymentStatus === "PENDENTE",
    });

    return updatedOrder;
  }

  async updateOrderStatus(orderId, nextStatus) {
    const order = await this.orderRepository.findById(orderId);

    if (!order) {
      throw new AppError("Pedido nao encontrado.", 404);
    }

    const allowedTransitions = ORDER_TRANSITIONS[order.status] ?? [];

    if (!allowedTransitions.includes(nextStatus)) {
      throw new AppError(
        `Transicao invalida de ${order.status} para ${nextStatus}.`,
        409,
      );
    }

    const deliveredAt = nextStatus === "ENTREGUE" ? new Date() : null;
    const updatedOrder = await this.orderRepository.updateStatus(
      orderId,
      nextStatus,
      deliveredAt,
    );

    emitOrderStatusUpdated({
      orderId: updatedOrder.id,
      userId: order.userId,
      previousStatus: order.status,
      status: updatedOrder.status,
    });

    return updatedOrder;
  }

  async handlePaymentWebhook(payload) {
    // MP sends { type: "payment", data: { id: "<payment_id>" } } — formato novo
    // MP Point envia { type: "point_integration_wh", data: { id: "<intent_id>", payment_id: 123 } }
    // MP também pode enviar formato ANTIGO: { resource: "123456", topic: "payment" }
    const isPointWebhook = payload?.type === "point_integration_wh";
    const isLegacyWebhook =
      !!payload?.topic && !!payload?.resource && !payload?.type;

    let providerStatus = "pending";
    let orderId =
      payload?.external_reference ??
      payload?.additional_info?.external_reference ??
      payload?.data?.metadata?.order_id ??
      payload?.metadata?.order_id;
    let externalId = "";

    const mpToken = process.env.MP_ACCESS_TOKEN;

    if (isLegacyWebhook) {
      // Formato antigo: { resource: "156011841118", topic: "payment" }
      // resource pode ser um número ou URL como /v1/payments/123456
      const rawResource = String(payload.resource ?? "");
      const rawPaymentId = rawResource.replace(/\D/g, "") || rawResource;
      externalId = rawPaymentId;
      console.log(
        "[webhook] Formato antigo. topic:",
        payload.topic,
        "paymentId:",
        rawPaymentId,
      );

      if (rawPaymentId && mpToken) {
        try {
          const client = new MercadoPagoConfig({ accessToken: mpToken });
          const paymentApi = new MPPayment(client);
          const paymentData = await paymentApi.get({ id: rawPaymentId });
          providerStatus = (paymentData.status ?? "pending").toLowerCase();
          // MP Point coloca o external_reference dentro de additional_info
          orderId =
            orderId ||
            paymentData.external_reference ||
            paymentData.additional_info?.external_reference;
          externalId = String(paymentData.id ?? rawPaymentId);
          console.log(
            "[webhook] Legacy payment status:",
            providerStatus,
            "orderId:",
            orderId,
            "ext_ref:",
            paymentData.external_reference,
            "additional_info:",
            JSON.stringify(paymentData.additional_info),
          );
        } catch (e) {
          console.error("[webhook] Falha ao buscar payment legado:", e.message);
        }
      }
    } else if (isPointWebhook) {
      // Para pagamentos da maquininha:
      // 1. Buscar o intent para pegar external_reference e estado
      // 2. Se houver payment_id, buscar o pagamento para confirmar status
      const intentId = payload?.data?.id;
      const paymentId = payload?.data?.payment_id;

      console.log(
        "[webhook] Point webhook. intentId:",
        intentId,
        "paymentId:",
        paymentId,
      );

      if (intentId && mpToken) {
        try {
          const intentResp = await fetch(
            `https://api.mercadopago.com/point/integration-api/payment-intents/${intentId}`,
            { headers: { Authorization: `Bearer ${mpToken}` } },
          );
          const intentData = await intentResp.json();
          orderId = orderId || intentData?.additional_info?.external_reference;
          console.log("[webhook] intent data:", JSON.stringify(intentData));
        } catch (e) {
          console.error("[webhook] Falha ao buscar intent:", e.message);
        }
      }

      if (paymentId && mpToken) {
        try {
          const client = new MercadoPagoConfig({ accessToken: mpToken });
          const paymentApi = new MPPayment(client);
          const paymentData = await paymentApi.get({ id: String(paymentId) });
          providerStatus = (paymentData.status ?? "pending").toLowerCase();
          orderId = orderId || paymentData.external_reference;
          externalId = String(paymentData.id ?? paymentId);
          console.log(
            "[webhook] Point payment status:",
            providerStatus,
            "orderId:",
            orderId,
          );
        } catch (e) {
          console.error("[webhook] Falha ao buscar payment:", e.message);
          // Derivar status do state do intent
          const state = String(payload?.data?.state ?? "").toUpperCase();
          if (state === "FINISHED") providerStatus = "approved";
          else if (state === "CANCELED" || state === "CANCELLED")
            providerStatus = "cancelled";
          externalId = String(paymentId ?? intentId ?? "");
        }
      } else {
        // Sem payment_id ainda (intent ainda processando) — ignorar
        const state = String(payload?.data?.state ?? "").toUpperCase();
        if (state === "FINISHED") providerStatus = "approved";
        else if (state === "CANCELED" || state === "CANCELLED")
          providerStatus = "cancelled";
        else providerStatus = "pending";
        externalId = String(intentId ?? "");
        console.log("[webhook] Point sem payment_id, state:", state);
      }
    } else {
      // Webhook normal de pagamento (PIX / checkout)
      const rawPaymentId = payload?.data?.id ?? payload?.id;
      externalId = String(rawPaymentId ?? "");

      if (rawPaymentId && mpToken) {
        try {
          const client = new MercadoPagoConfig({ accessToken: mpToken });
          const paymentApi = new MPPayment(client);
          const paymentData = await paymentApi.get({
            id: String(rawPaymentId),
          });
          providerStatus = (paymentData.status ?? "pending").toLowerCase();
          orderId = orderId || paymentData.external_reference;
          externalId = String(paymentData.id ?? rawPaymentId);
        } catch {
          // fall through with defaults
        }
      } else {
        providerStatus = String(
          payload?.data?.status ?? payload?.status ?? "pending",
        ).toLowerCase();
      }
    }

    const paymentStatus = PAYMENT_STATUS_MAP[providerStatus] ?? "PENDENTE";

    if (!orderId) {
      console.error("[webhook] Sem orderId. Payload:", JSON.stringify(payload));
      throw new AppError(
        "Webhook sem order_id no metadata/external_reference.",
        422,
      );
    }

    const order = await this.orderRepository.findById(orderId);

    if (!order) {
      throw new AppError("Pedido nao encontrado para o webhook recebido.", 404);
    }

    await this.paymentRepository.upsertFromWebhook({
      orderId,
      externalId: externalId || null,
      status: paymentStatus,
      payload,
      amount: order.total,
    });

    await this.orderRepository.updatePaymentStatus(orderId, paymentStatus);

    emitPaymentUpdated({
      orderId,
      userId: order.userId,
      paymentStatus,
    });

    return {
      orderId,
      paymentStatus,
    };
  }

  async adminSetPaymentStatus(orderId, paymentStatus) {
    const order = await this.orderRepository.findById(orderId);
    if (!order) throw new AppError("Pedido não encontrado.", 404);
    return this.orderRepository.updatePaymentStatus(orderId, paymentStatus);
  }

  async listOrdersByUser(userId) {
    return this.orderRepository.findByUserId(userId);
  }

  async listMotoboyOrders() {
    return this.orderRepository.findForMotoboy();
  }

  async listActiveOrders() {
    const orders = await this.orderRepository.findAllActive();
    return orders.filter((o) => o.status !== "CANCELADO");
  }

  async listOrderHistory({ clientName, dateFrom, dateTo } = {}) {
    return this.orderRepository.findAllHistory({
      clientName,
      dateFrom,
      dateTo,
    });
  }

  async getSalesAnalytics({ from, to } = {}) {
    const orders = await this.orderRepository.findAllForAnalytics();
    const now = new Date();
    const todayStart = startOfDay(now);
    const monthStart = startOfMonth(now);

    // Build date range
    let rangeStart = null;
    let rangeEnd = null;
    if (from) {
      rangeStart = new Date(from);
      rangeEnd = new Date(to ?? now);
      rangeEnd.setHours(23, 59, 59, 999);
    }

    // All paid orders (unfiltered) — used for today/month sub-metrics
    const allPaidOrders = orders.filter(
      (order) => order.paymentStatus === "APROVADO",
    );

    // Paid orders filtered to the selected period — used for main totals
    const paidOrders = rangeStart
      ? allPaidOrders.filter((o) => {
          const d = new Date(o.createdAt);
          return d >= rangeStart && d <= rangeEnd;
        })
      : allPaidOrders;

    const filteredOrders = rangeStart
      ? orders.filter((o) => {
          const d = new Date(o.createdAt);
          return d >= rangeStart && d <= rangeEnd;
        })
      : orders;

    const paidToday = allPaidOrders.filter(
      (order) => new Date(order.createdAt) >= todayStart,
    );
    const paidThisMonth = allPaidOrders.filter(
      (order) => new Date(order.createdAt) >= monthStart,
    );

    // Calcula custo total de um pedido: soma costPrice * quantity de cada item
    const orderCost = (order) =>
      (order.items ?? []).reduce(
        (sum, item) =>
          sum + Number(item.costPrice ?? 0) * Number(item.quantity ?? 1),
        0,
      );

    const totalRevenue = paidOrders.reduce(
      (sum, o) => sum + Number(o.total),
      0,
    );
    const totalCost = paidOrders.reduce((sum, o) => sum + orderCost(o), 0);

    const revenueToday = paidToday.reduce((sum, o) => sum + Number(o.total), 0);
    const costToday = paidToday.reduce((sum, o) => sum + orderCost(o), 0);

    const revenueThisMonth = paidThisMonth.reduce(
      (sum, o) => sum + Number(o.total),
      0,
    );
    const costThisMonth = paidThisMonth.reduce(
      (sum, o) => sum + orderCost(o),
      0,
    );

    const averageTicket = paidOrders.length
      ? totalRevenue / paidOrders.length
      : 0;

    const statusCounts = filteredOrders.reduce((acc, order) => {
      acc[order.status] = (acc[order.status] ?? 0) + 1;
      return acc;
    }, {});

    // Determine chart range and grouping
    const last7DaysStart = new Date(todayStart);
    last7DaysStart.setDate(last7DaysStart.getDate() - 6);
    const chartFrom = rangeStart ?? last7DaysStart;
    const chartToDate =
      rangeEnd ??
      (() => {
        const d = new Date(now);
        d.setHours(23, 59, 59, 999);
        return d;
      })();
    const diffDays = Math.ceil(
      (chartToDate - chartFrom) / (1000 * 60 * 60 * 24),
    );
    const groupByMonth = diffDays > 60;

    const salesMap = new Map();
    if (groupByMonth) {
      const cur = new Date(chartFrom.getFullYear(), chartFrom.getMonth(), 1);
      const end = new Date(
        chartToDate.getFullYear(),
        chartToDate.getMonth(),
        1,
      );
      while (cur <= end) {
        const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`;
        salesMap.set(key, { revenue: 0, cost: 0 });
        cur.setMonth(cur.getMonth() + 1);
      }
      for (const order of paidOrders) {
        const d = new Date(order.createdAt);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (salesMap.has(key)) {
          const entry = salesMap.get(key);
          entry.revenue += Number(order.total);
          entry.cost += orderCost(order);
        }
      }
    } else {
      const cur = new Date(chartFrom);
      cur.setHours(0, 0, 0, 0);
      while (cur <= chartToDate) {
        const key = cur.toISOString().slice(0, 10);
        salesMap.set(key, { revenue: 0, cost: 0 });
        cur.setDate(cur.getDate() + 1);
      }
      for (const order of paidOrders) {
        const createdAt = new Date(order.createdAt);
        const key = createdAt.toISOString().slice(0, 10);
        if (salesMap.has(key)) {
          const entry = salesMap.get(key);
          entry.revenue += Number(order.total);
          entry.cost += orderCost(order);
        }
      }
    }

    const topProductsMap = new Map();
    for (const order of paidOrders) {
      for (const item of order.items ?? []) {
        if (item.type === "INTEIRA" && item.productName) {
          topProductsMap.set(
            item.productName,
            (topProductsMap.get(item.productName) ?? 0) + Number(item.quantity),
          );
          continue;
        }
        if (item.firstHalfProductName) {
          topProductsMap.set(
            item.firstHalfProductName,
            (topProductsMap.get(item.firstHalfProductName) ?? 0) +
              Number(item.quantity),
          );
        }
        if (item.secondHalfProductName) {
          topProductsMap.set(
            item.secondHalfProductName,
            (topProductsMap.get(item.secondHalfProductName) ?? 0) +
              Number(item.quantity),
          );
        }
      }
    }

    const topProducts = [...topProductsMap.entries()]
      .map(([name, quantity]) => ({ name, quantity }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5);

    return {
      summary: {
        totalRevenue: Number(totalRevenue.toFixed(2)),
        totalCost: Number(totalCost.toFixed(2)),
        totalProfit: Number((totalRevenue - totalCost).toFixed(2)),
        revenueToday: Number(revenueToday.toFixed(2)),
        costToday: Number(costToday.toFixed(2)),
        profitToday: Number((revenueToday - costToday).toFixed(2)),
        revenueThisMonth: Number(revenueThisMonth.toFixed(2)),
        costThisMonth: Number(costThisMonth.toFixed(2)),
        profitThisMonth: Number((revenueThisMonth - costThisMonth).toFixed(2)),
        ordersCount: filteredOrders.length,
        paidOrdersCount: paidOrders.length,
        averageTicket: Number(averageTicket.toFixed(2)),
      },
      statusCounts,
      dailySales: [...salesMap.entries()].map(([date, { revenue, cost }]) => ({
        date,
        revenue: Number(revenue.toFixed(2)),
        cost: Number(cost.toFixed(2)),
        profit: Number((revenue - cost).toFixed(2)),
      })),
      topProducts,
    };
  }

  async getOrderById(orderId) {
    const order = await this.orderRepository.findById(orderId);

    if (!order) {
      throw new AppError("Pedido nao encontrado.", 404);
    }

    return order;
  }

  async assignMotoboy(orderId, motoboyId) {
    await this.orderRepository.assignMotoboy(orderId, motoboyId);
  }

  async confirmDelivery(orderId, code) {
    try {
      const updatedOrder = await this.orderRepository.confirmDelivery(
        orderId,
        code,
      );
      if (!updatedOrder) throw new AppError("Pedido não encontrado.", 404);
      emitOrderStatusUpdated({
        orderId: updatedOrder.id,
        userId: updatedOrder.userId,
        previousStatus: "SAIU_PARA_ENTREGA",
        status: "ENTREGUE",
      });
      return updatedOrder;
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err.message === "CODE_INVALID")
        throw new AppError("Código inválido.", 400);
      if (err.message === "STATUS_INVALID")
        throw new AppError("Pedido não está em trânsito.", 400);
      if (err.message === "IS_PICKUP")
        throw new AppError("Pedido de retirada não usa código.", 400);
      throw err;
    }
  }

  async deleteOrder(orderId, userId) {
    const row = await this.orderRepository.findOwnerAndStatus(orderId);
    if (!row) throw new AppError("Pedido nao encontrado.", 404);
    if (row.userId !== userId) throw new AppError("Acesso negado.", 403);
    if (row.status !== "CANCELADO") {
      throw new AppError(
        "Somente pedidos cancelados podem ser excluidos.",
        422,
      );
    }
    await this.orderRepository.deleteById(orderId, userId);
  }

  async #normalizeWholeItem(item) {
    const quantity = item.quantity ?? 1;
    if (!item.productId || !item.size) {
      throw new AppError("Item INTEIRA exige productId e size.", 422);
    }

    const [priceBySize, crustPriceBySize] = await Promise.all([
      this.productRepository.findSizePrice(item.productId, item.size, {
        isCrust: false,
      }),
      item.crustProductId
        ? this.productRepository.findSizePrice(item.crustProductId, item.size, {
            isCrust: true,
          })
        : Promise.resolve(null),
    ]);

    if (!priceBySize) {
      throw new AppError("Produto ou tamanho invalido para item INTEIRA.", 422);
    }

    if (item.crustProductId && !crustPriceBySize) {
      throw new AppError("Borda recheada invalida para este tamanho.", 422);
    }

    const crustUnitPriceCents = crustPriceBySize
      ? toCents(crustPriceBySize.price)
      : 0;
    const unitPriceCents = toCents(priceBySize.price) + crustUnitPriceCents;
    const totalPriceCents = unitPriceCents * quantity;

    return {
      quantity,
      type: "INTEIRA",
      size: item.size,
      unitPriceCents,
      totalPriceCents,
      crustUnitPriceCents,
      productId: item.productId,
      firstHalfProductId: null,
      secondHalfProductId: null,
      crustProductId: item.crustProductId ?? null,
    };
  }

  async #normalizeHalfHalfItem(item) {
    const quantity = item.quantity ?? 1;

    if (!item.firstHalfProductId || !item.secondHalfProductId || !item.size) {
      throw new AppError(
        "Item MEIO_A_MEIO exige firstHalfProductId, secondHalfProductId e size.",
        422,
      );
    }

    const [firstHalfPrice, secondHalfPrice, crustPriceBySize] =
      await Promise.all([
        this.productRepository.findSizePrice(
          item.firstHalfProductId,
          item.size,
          {
            isCrust: false,
          },
        ),
        this.productRepository.findSizePrice(
          item.secondHalfProductId,
          item.size,
          { isCrust: false },
        ),
        item.crustProductId
          ? this.productRepository.findSizePrice(
              item.crustProductId,
              item.size,
              {
                isCrust: true,
              },
            )
          : Promise.resolve(null),
      ]);

    if (!firstHalfPrice || !secondHalfPrice) {
      throw new AppError(
        "Sabor(es) invalidos para pizza meio a meio no tamanho selecionado.",
        422,
      );
    }

    if (item.crustProductId && !crustPriceBySize) {
      throw new AppError("Borda recheada invalida para este tamanho.", 422);
    }

    const firstHalfCents = toCents(firstHalfPrice.price);
    const secondHalfCents = toCents(secondHalfPrice.price);
    const crustUnitPriceCents = crustPriceBySize
      ? toCents(crustPriceBySize.price)
      : 0;

    const unitPriceCents =
      Math.max(firstHalfCents, secondHalfCents) + crustUnitPriceCents;
    const totalPriceCents = unitPriceCents * quantity;

    return {
      quantity,
      type: "MEIO_A_MEIO",
      size: item.size,
      unitPriceCents,
      totalPriceCents,
      crustUnitPriceCents,
      productId: null,
      firstHalfProductId: item.firstHalfProductId,
      secondHalfProductId: item.secondHalfProductId,
      crustProductId: item.crustProductId ?? null,
    };
  }
}
