import { ZodError } from "zod";
import { AppError } from "../errors/AppError.js";
import { MesaService } from "../services/MesaService.js";
import {
  createMesaSchema,
  updateMesaSchema,
} from "../validators/mesaSchemas.js";

const mesaService = new MesaService();

export class MesaController {
  async create(req, res, next) {
    try {
      const data = createMesaSchema.parse(req.body);
      const mesa = await mesaService.create(data);
      return res.status(201).json({ message: "Mesa criada.", data: mesa });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async list(_req, res, next) {
    try {
      const mesas = await mesaService.listAll();
      return res.status(200).json({ data: mesas });
    } catch (error) {
      return next(error);
    }
  }

  async update(req, res, next) {
    try {
      const data = updateMesaSchema.parse(req.body);
      const mesa = await mesaService.update(req.params.mesaId, data);
      return res.status(200).json({ message: "Mesa atualizada.", data: mesa });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async delete(req, res, next) {
    try {
      await mesaService.delete(req.params.mesaId);
      return res.status(200).json({ message: "Mesa removida." });
    } catch (error) {
      return next(error);
    }
  }

  async regenerateToken(req, res, next) {
    try {
      const mesa = await mesaService.regenerateToken(req.params.mesaId);
      return res.status(200).json({ message: "Token regenerado.", data: mesa });
    } catch (error) {
      return next(error);
    }
  }

  async access(req, res, next) {
    try {
      const result = await mesaService.access(req.params.token);
      return res.status(200).json({ data: result });
    } catch (error) {
      return next(error);
    }
  }

  async myOrders(req, res, next) {
    try {
      const orders = await mesaService.getOrdersToday(req.user.id);
      return res.status(200).json({ data: orders });
    } catch (error) {
      return next(error);
    }
  }

  #handleError(error, next) {
    if (error instanceof ZodError) {
      return next(
        new AppError(error.errors[0]?.message ?? "Dados invalidos.", 422),
      );
    }
    return next(error);
  }
}
