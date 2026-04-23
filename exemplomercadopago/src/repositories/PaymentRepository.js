import { prisma } from "../lib/prisma.js";

export class PaymentRepository {
  async upsertFromWebhook({ orderId, externalId, status, payload, amount }) {
    return prisma.payment.upsert({
      where: { orderId },
      update: {
        externalId,
        status,
        payload,
        ...(amount ? { amount } : {}),
      },
      create: {
        orderId,
        provider: "MERCADO_PAGO",
        externalId,
        status,
        amount,
        payload,
      },
    });
  }
}
