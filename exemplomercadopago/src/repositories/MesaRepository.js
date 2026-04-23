import { prisma } from "../lib/prisma.js";

export class MesaRepository {
  async create(data) {
    return prisma.mesa.create({ data });
  }

  async findAll() {
    return prisma.mesa.findMany({ orderBy: { number: "asc" } });
  }

  async findById(id) {
    return prisma.mesa.findUnique({ where: { id } });
  }

  async findByAccessToken(accessToken) {
    return prisma.mesa.findUnique({ where: { accessToken } });
  }

  async update(id, data) {
    return prisma.mesa.update({ where: { id }, data });
  }

  async delete(id) {
    return prisma.mesa.delete({ where: { id } });
  }

  async findOrdersToday(mesaId) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return prisma.order.findMany({
      where: {
        mesaId,
        createdAt: { gte: today },
        status: { notIn: ["CANCELADO"] },
      },
      include: {
        items: true,
        payment: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }
}
