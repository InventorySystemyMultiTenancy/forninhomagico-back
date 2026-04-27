import { prisma } from "../lib/prisma.js";

export class OrderRepository {
  // Helpers: Prisma v6 não suporta arrays em $queryRaw template tags;
  // usamos $queryRawUnsafe com placeholders IN ($1, $2, ...) em vez de ANY($1::text[])
  async _fetchItemsForOrders(orderIds) {
    if (!orderIds.length) return [];
    const ph = orderIds.map((_, i) => `$${i + 1}`).join(", ");
    return prisma.$queryRawUnsafe(
      `SELECT oi.*, p.name AS "productName",
              fp.name AS "firstHalfProductName",
              sp.name AS "secondHalfProductName",
              cp.name AS "crustProductName"
       FROM "OrderItem" oi
       LEFT JOIN "Product" p ON p.id = oi."productId"
       LEFT JOIN "Product" fp ON fp.id = oi."firstHalfProductId"
       LEFT JOIN "Product" sp ON sp.id = oi."secondHalfProductId"
       LEFT JOIN "Product" cp ON cp.id = oi."crustProductId"
       WHERE oi."orderId" IN (${ph})`,
      ...orderIds,
    );
  }

  async _fetchPaymentsForOrders(orderIds) {
    if (!orderIds.length) return [];
    const ph = orderIds.map((_, i) => `$${i + 1}`).join(", ");
    return prisma.$queryRawUnsafe(
      `SELECT * FROM "Payment" WHERE "orderId" IN (${ph})`,
      ...orderIds,
    );
  }

  async _fetchUsersForOrders(orderIds) {
    if (!orderIds.length) return [];
    const ph = orderIds.map((_, i) => `$${i + 1}`).join(", ");
    return prisma.$queryRawUnsafe(
      `SELECT u.id, u.name FROM "User" u
       WHERE u.id IN (
         SELECT DISTINCT "userId" FROM "Order"
         WHERE id IN (${ph}) AND "userId" IS NOT NULL
       )`,
      ...orderIds,
    );
  }

  async createOrder(data) {
    return prisma.order.create({
      data,
      include: {
        items: true,
        payment: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });
  }

  async findById(orderId) {
    const rows = await prisma.$queryRaw`
      SELECT o.id, o."userId", o."mesaId", o.status::text AS status,
             o."paymentStatus"::text AS "paymentStatus",
             o."deliveryAddress", o.notes, o."paymentMethod",
             o.total, o."deliveryFee", o."deliveryLat", o."deliveryLon",
             o."isPickup", o."assignedMotoboyId", o."deliveryCode",
             o."createdAt", o."updatedAt", o."deliveredAt"
      FROM "Order" o WHERE o.id = ${orderId}
    `;
    if (!rows.length) return null;
    const order = rows[0];

    const items = await prisma.$queryRaw`
      SELECT oi.*, p.name AS "productName",
             fp.name AS "firstHalfProductName",
             sp.name AS "secondHalfProductName",
             cp.name AS "crustProductName"
      FROM "OrderItem" oi
      LEFT JOIN "Product" p ON p.id = oi."productId"
      LEFT JOIN "Product" fp ON fp.id = oi."firstHalfProductId"
      LEFT JOIN "Product" sp ON sp.id = oi."secondHalfProductId"
      LEFT JOIN "Product" cp ON cp.id = oi."crustProductId"
      WHERE oi."orderId" = ${orderId}
    `;
    const payments = await prisma.$queryRaw`
      SELECT * FROM "Payment" WHERE "orderId" = ${orderId}
    `;
    return { ...order, items, payment: payments[0] ?? null };
  }

  async findByIdWithUser(orderId) {
    const rows = await prisma.$queryRaw`
      SELECT o.id, o."userId", o."mesaId", o.status::text AS status,
             o."paymentStatus"::text AS "paymentStatus",
             u.id AS "uId", u.role::text AS "uRole"
      FROM "Order" o
      LEFT JOIN "User" u ON u.id = o."userId"
      WHERE o.id = ${orderId}
    `;
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      userId: r.userId,
      mesaId: r.mesaId,
      status: r.status,
      paymentStatus: r.paymentStatus,
      user: r.uId ? { id: r.uId, role: r.uRole } : null,
    };
  }

  async updateStatus(orderId, status, deliveredAt = null) {
    // Usa raw SQL para todos os updates de status para evitar problemas
    // com o Prisma Client desatualizado que não conhece CANCELADO
    const deliveredClause = deliveredAt
      ? `, "deliveredAt" = '${new Date(deliveredAt).toISOString()}'`
      : "";
    await prisma.$executeRawUnsafe(
      `UPDATE "Order" SET "status" = $1::"OrderStatus", "updatedAt" = NOW()${deliveredClause} WHERE "id" = $2`,
      status,
      orderId,
    );
    return this.findById(orderId);
  }

  async updatePaymentStatus(orderId, paymentStatus) {
    return prisma.order.update({
      where: { id: orderId },
      data: { paymentStatus },
    });
  }

  async findByUserId(userId) {
    console.log("[findByUserId] start userId=", userId);
    let orders;
    try {
      orders = await prisma.$queryRaw`
        SELECT
          o.id, o."userId", o.status::text AS status,
          o."paymentStatus"::text AS "paymentStatus",
          o."deliveryAddress", o.notes, o."paymentMethod",
          o.total, o."deliveryFee", o."deliveryLat", o."deliveryLon",
          o."isPickup", o."assignedMotoboyId", o."deliveryCode",
          o."createdAt", o."updatedAt", o."deliveredAt"
        FROM "Order" o
        WHERE o."userId" = ${userId}
        ORDER BY o."createdAt" DESC
      `;
      console.log("[findByUserId] orders count=", orders.length);
    } catch (e) {
      console.error("[findByUserId] FALHOU na query de orders:", e);
      throw e;
    }

    if (!orders.length) return [];

    const orderIds = orders.map((o) => o.id);
    console.log("[findByUserId] orderIds=", orderIds);

    let items, payments;
    try {
      items = await this._fetchItemsForOrders(orderIds);
      console.log("[findByUserId] items count=", items.length);
    } catch (e) {
      console.error("[findByUserId] FALHOU em _fetchItemsForOrders:", e);
      throw e;
    }
    try {
      payments = await this._fetchPaymentsForOrders(orderIds);
      console.log("[findByUserId] payments count=", payments.length);
    } catch (e) {
      console.error("[findByUserId] FALHOU em _fetchPaymentsForOrders:", e);
      throw e;
    }

    return orders.map((o) => ({
      ...o,
      items: items.filter((i) => i.orderId === o.id),
      payment: payments.find((p) => p.orderId === o.id) ?? null,
    }));
  }

  async assignMotoboy(orderId, motoboyId) {
    await prisma.$executeRaw`
      UPDATE "Order" SET "assignedMotoboyId" = ${motoboyId} WHERE id = ${orderId}
    `;
  }

  async confirmDelivery(orderId, code) {
    const rows = await prisma.$queryRaw`
      SELECT "deliveryCode", status::text AS status, "isPickup"
      FROM "Order" WHERE id = ${orderId}
    `;
    if (!rows.length) return null;
    const order = rows[0];
    if (order.status !== "SAIU_PARA_ENTREGA") {
      throw new Error("STATUS_INVALID");
    }
    if (order.isPickup) {
      throw new Error("IS_PICKUP");
    }
    if (order.deliveryCode !== code) {
      throw new Error("CODE_INVALID");
    }
    return this.updateStatus(orderId, "ENTREGUE", new Date());
  }

  async deleteById(orderId, userId) {
    // Must delete related rows first (Payment, OrderItem) then the Order itself
    await prisma.$transaction([
      prisma.$executeRaw`DELETE FROM "Payment" WHERE "orderId" = ${orderId}`,
      prisma.$executeRaw`DELETE FROM "OrderItem" WHERE "orderId" = ${orderId}`,
      prisma.$executeRaw`DELETE FROM "Order" WHERE id = ${orderId} AND "userId" = ${userId} AND status::text = 'CANCELADO'`,
    ]);
  }

  async findOwnerAndStatus(orderId) {
    const rows = await prisma.$queryRaw`
      SELECT "userId", status::text AS status FROM "Order" WHERE id = ${orderId}
    `;
    return rows[0] ?? null;
  }

  async _fetchMesasForOrders(orderIds) {
    if (!orderIds.length) return [];
    const ph = orderIds.map((_, i) => `$${i + 1}`).join(", ");
    return prisma.$queryRawUnsafe(
      `SELECT m.id, m.name, m.number FROM "Mesa" m
       WHERE m.id IN (
         SELECT DISTINCT "mesaId" FROM "Order"
         WHERE id IN (${ph}) AND "mesaId" IS NOT NULL
       )`,
      ...orderIds,
    );
  }

  async findAllActive() {
    console.log("[findAllActive] start");
    let orders;
    try {
      orders = await prisma.$queryRaw`
        SELECT
          o.id, o."userId", o."mesaId", o.status::text AS status,
          o."paymentStatus"::text AS "paymentStatus",
          o."deliveryAddress", o.notes, o."paymentMethod",
          o.total, o."deliveryFee", o."deliveryLat", o."deliveryLon",
          o."isPickup", o."assignedMotoboyId",
          o."createdAt", o."updatedAt", o."deliveredAt"
        FROM "Order" o
        WHERE o.status::text NOT IN ('ENTREGUE','CANCELADO')
        ORDER BY o."createdAt" ASC
      `;
      console.log("[findAllActive] orders count=", orders.length);
    } catch (e) {
      console.error("[findAllActive] FALHOU na query de orders:", e);
      throw e;
    }

    if (!orders.length) return [];

    const orderIds = orders.map((o) => o.id);
    console.log("[findAllActive] orderIds=", orderIds);

    let items, users, mesas;
    try {
      items = await this._fetchItemsForOrders(orderIds);
      console.log("[findAllActive] items count=", items.length);
    } catch (e) {
      console.error("[findAllActive] FALHOU em _fetchItemsForOrders:", e);
      throw e;
    }
    try {
      users = await this._fetchUsersForOrders(orderIds);
      console.log("[findAllActive] users count=", users.length);
    } catch (e) {
      console.error("[findAllActive] FALHOU em _fetchUsersForOrders:", e);
      throw e;
    }
    try {
      mesas = await this._fetchMesasForOrders(orderIds);
    } catch (e) {
      mesas = [];
    }

    return orders.map((o) => ({
      ...o,
      items: items.filter((i) => i.orderId === o.id),
      user: users.find((u) => u.id === o.userId) ?? null,
      mesa: mesas.find((m) => m.id === o.mesaId) ?? null,
    }));
  }

  async findForMotoboy() {
    return prisma.order.findMany({
      where: { status: "SAIU_PARA_ENTREGA" },
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true } },
            firstHalfProduct: { select: { id: true, name: true } },
            secondHalfProduct: { select: { id: true, name: true } },
            crustProduct: { select: { id: true, name: true } },
          },
        },
        user: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  async findAllHistory({ clientName, dateFrom, dateTo } = {}) {
    const hasFilter = clientName || dateFrom || dateTo;

    // Constrói cláusulas WHERE dinamicamente para raw SQL
    const conditions = [];
    const params = [];
    let idx = 1;

    if (clientName) {
      conditions.push(`u.name ILIKE $${idx}`);
      params.push(`%${clientName}%`);
      idx++;
    }
    if (dateFrom) {
      conditions.push(`o."createdAt" >= $${idx}`);
      params.push(new Date(dateFrom));
      idx++;
    }
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      conditions.push(`o."createdAt" <= $${idx}`);
      params.push(end);
      idx++;
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const limitClause = hasFilter ? "" : "LIMIT 15";

    const orders = await prisma.$queryRawUnsafe(
      `SELECT o.id, o."userId", o.status::text AS status,
              o."paymentStatus"::text AS "paymentStatus",
              o."deliveryAddress", o.notes, o."paymentMethod",
              o.total, o."deliveryFee", o."deliveryLat", o."deliveryLon",
              o."isPickup", o."assignedMotoboyId",
              o."createdAt", o."updatedAt", o."deliveredAt",
              u.name AS "userName"
       FROM "Order" o
       LEFT JOIN "User" u ON u.id = o."userId"
       ${whereClause}
       ORDER BY o."createdAt" DESC
       ${limitClause}`,
      ...params,
    );

    if (!orders.length) return [];

    const orderIds = orders.map((o) => o.id);

    const items = await this._fetchItemsForOrders(orderIds);
    const payments = await this._fetchPaymentsForOrders(orderIds);

    return orders.map((o) => ({
      ...o,
      user: { id: o.userId, name: o.userName },
      items: items.filter((i) => i.orderId === o.id),
      payment: payments.find((p) => p.orderId === o.id) ?? null,
    }));
  }

  async findAllForAnalytics() {
    const orders = await prisma.$queryRaw`
      SELECT o.id, o."userId", o.status::text AS status,
             o."paymentStatus"::text AS "paymentStatus",
             o.total, o."deliveryFee", o."createdAt"
      FROM "Order" o
      ORDER BY o."createdAt" ASC
    `;

    if (!orders.length) return [];

    const orderIds = orders.map((o) => o.id);

    // Busca itens com costPrice do tamanho correspondente
    const ph = orderIds.map((_, i) => `$${i + 1}`).join(", ");
    const items = await prisma.$queryRawUnsafe(
      `SELECT oi."orderId", oi.quantity, oi.type, oi.size,
              oi."unitPrice", oi."totalPrice",
              oi."productId", oi."firstHalfProductId", oi."secondHalfProductId", oi."crustProductId",
              p.name AS "productName",
              fp.name AS "firstHalfProductName",
              sp.name AS "secondHalfProductName",
              cp.name AS "crustProductName",
              COALESCE(ps."costPrice", 0) + COALESCE(cps."costPrice", 0) AS "costPrice"
       FROM "OrderItem" oi
       LEFT JOIN "Product" p ON p.id = oi."productId"
       LEFT JOIN "Product" fp ON fp.id = oi."firstHalfProductId"
       LEFT JOIN "Product" sp ON sp.id = oi."secondHalfProductId"
       LEFT JOIN "Product" cp ON cp.id = oi."crustProductId"
       LEFT JOIN "ProductSize" ps ON (
         ps."productId" = COALESCE(oi."productId", oi."firstHalfProductId")
         AND ps.size = oi.size::\"ProductSizeEnum\"
       )
       LEFT JOIN "ProductSize" cps ON (
         cps."productId" = oi."crustProductId"
         AND cps.size = oi.size::\"ProductSizeEnum\"
       )
       WHERE oi."orderId" IN (${ph})`,
      ...orderIds,
    );

    return orders.map((o) => ({
      ...o,
      items: items.filter((i) => i.orderId === o.id),
    }));
  }
}
