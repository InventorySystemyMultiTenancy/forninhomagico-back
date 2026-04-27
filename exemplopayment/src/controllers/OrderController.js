import { ZodError } from "zod";
import { AppError } from "../errors/AppError.js";
import { OrderService } from "../services/OrderService.js";
import {
  createOrderSchema,
  paymentWebhookSchema,
  updateOrderStatusSchema,
} from "../validators/orderSchemas.js";

const orderService = new OrderService();

export class OrderController {
  async create(req, res, next) {
    try {
      const payload = createOrderSchema.parse(req.body);
      const isMesa = req.user.role === "MESA";
      const order = await orderService.createOrder({
        ...(isMesa ? { mesaId: req.user.id } : { userId: req.user.id }),
        ...payload,
      });

      return res.status(201).json({
        message: "Pedido criado com sucesso.",
        data: order,
      });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async updateStatus(req, res, next) {
    try {
      const { status } = updateOrderStatusSchema.parse(req.body);
      const updatedOrder = await orderService.updateOrderStatus(
        req.params.orderId,
        status,
      );

      return res.status(200).json({
        message: "Status do pedido atualizado.",
        data: updatedOrder,
      });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async getById(req, res, next) {
    try {
      const order = await orderService.getOrderById(req.params.orderId);

      return res.status(200).json({
        data: order,
      });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async getMyOrders(req, res, next) {
    try {
      const orders = await orderService.listOrdersByUser(req.user.id);

      return res.status(200).json({
        data: orders,
      });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async listAll(_req, res, next) {
    try {
      const orders = await orderService.listActiveOrders();

      return res.status(200).json({
        data: orders,
      });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async motoboyOrders(_req, res, next) {
    try {
      const orders = await orderService.listMotoboyOrders();
      return res.status(200).json({ data: orders });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async history(req, res, next) {
    try {
      const { clientName, dateFrom, dateTo } = req.query;
      const orders = await orderService.listOrderHistory({
        clientName: clientName || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      });
      return res.status(200).json({ data: orders });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async cancel(req, res, next) {
    try {
      const updatedOrder = await orderService.cancelOrder(req.params.orderId);

      return res.status(200).json({
        message: "Pedido cancelado.",
        data: updatedOrder,
      });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async analytics(req, res, next) {
    try {
      const { from, to } = req.query;
      const analytics = await orderService.getSalesAnalytics({ from, to });

      return res.status(200).json({
        data: analytics,
      });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async adminUpdatePaymentStatus(req, res, next) {
    try {
      const { paymentStatus } = req.body;
      const ALLOWED = ["APROVADO", "PENDENTE", "RECUSADO"];
      if (!ALLOWED.includes(paymentStatus)) {
        throw new AppError("paymentStatus inválido.", 422);
      }
      const order = await orderService.adminSetPaymentStatus(
        req.params.orderId,
        paymentStatus,
      );
      return res
        .status(200)
        .json({ message: "Status de pagamento atualizado.", data: order });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async paymentWebhook(req, res, next) {
    try {
      const payload = paymentWebhookSchema.parse(req.body);
      const result = await orderService.handlePaymentWebhook(payload);

      return res.status(200).json({
        message: "Webhook processado com sucesso.",
        data: result,
      });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async assignMotoboy(req, res, next) {
    try {
      const { motoboyId } = req.body;
      if (!motoboyId || typeof motoboyId !== "string") {
        throw new AppError("motoboyId é obrigatório.", 422);
      }
      await orderService.assignMotoboy(req.params.orderId, motoboyId);
      return res.status(200).json({ message: "Motoboy atribuído." });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async deleteOrder(req, res, next) {
    try {
      await orderService.deleteOrder(req.params.orderId, req.user.id);
      return res.status(200).json({ message: "Pedido excluido com sucesso." });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async confirmDelivery(req, res, next) {
    try {
      const { code } = req.body;
      if (!code || typeof code !== "string") {
        throw new AppError("Código é obrigatório.", 422);
      }
      const order = await orderService.confirmDelivery(
        req.params.orderId,
        code.trim(),
      );
      return res
        .status(200)
        .json({ message: "Entrega confirmada.", data: order });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  #handleError(error, next) {
    if (error instanceof ZodError) {
      return next(new AppError("Payload invalido.", 422, error.flatten()));
    }

    return next(error);
  }
}
