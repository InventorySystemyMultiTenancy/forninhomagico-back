import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import { AppError } from "../errors/AppError.js";
import { MesaRepository } from "../repositories/MesaRepository.js";

export class MesaService {
  constructor(mesaRepository = new MesaRepository()) {
    this.mesaRepository = mesaRepository;
  }

  async create({ name, number, terminalId }) {
    try {
      return await this.mesaRepository.create({
        name,
        number,
        terminalId: terminalId ?? null,
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new AppError("Numero de mesa ja cadastrado.", 409);
      }
      throw err;
    }
  }

  async listAll() {
    return this.mesaRepository.findAll();
  }

  async update(id, data) {
    const mesa = await this.mesaRepository.findById(id);
    if (!mesa) throw new AppError("Mesa nao encontrada.", 404);
    try {
      return await this.mesaRepository.update(id, data);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new AppError("Numero de mesa ja cadastrado.", 409);
      }
      throw err;
    }
  }

  async delete(id) {
    const mesa = await this.mesaRepository.findById(id);
    if (!mesa) throw new AppError("Mesa nao encontrada.", 404);
    return this.mesaRepository.delete(id);
  }

  async regenerateToken(id) {
    const mesa = await this.mesaRepository.findById(id);
    if (!mesa) throw new AppError("Mesa nao encontrada.", 404);
    const { randomUUID } = await import("crypto");
    return this.mesaRepository.update(id, { accessToken: randomUUID() });
  }

  async access(token) {
    const mesa = await this.mesaRepository.findByAccessToken(token);
    if (!mesa || !mesa.isActive) {
      throw new AppError("Mesa nao encontrada ou inativa.", 404);
    }

    const accessToken = jwt.sign(
      { role: "MESA", mesaId: mesa.id, mesaNumber: mesa.number },
      process.env.JWT_SECRET,
      { subject: mesa.id, expiresIn: "12h" },
    );

    return {
      accessToken,
      mesa: { id: mesa.id, name: mesa.name, number: mesa.number },
    };
  }

  async getOrdersToday(mesaId) {
    return this.mesaRepository.findOrdersToday(mesaId);
  }
}
