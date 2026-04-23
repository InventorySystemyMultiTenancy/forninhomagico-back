import jwt from "jsonwebtoken";
import { AppError } from "../errors/AppError.js";
import { OrderRepository } from "../repositories/OrderRepository.js";

const orderRepository = new OrderRepository();

export const authenticateToken = (req, _res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      throw new AppError("Token nao fornecido.", 401);
    }

    const token = authHeader.split(" ")[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    req.user = {
      id: payload.sub,
      role: payload.role,
      email: payload.email,
    };

    return next();
  } catch (error) {
    if (error instanceof AppError) {
      return next(error);
    }

    return next(new AppError("Token invalido ou expirado.", 401));
  }
};

export const authorizeRoles =
  (...allowedRoles) =>
  (req, _res, next) => {
    if (!req.user?.role) {
      return next(new AppError("Usuario nao autenticado.", 401));
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(new AppError("Acesso negado.", 403));
    }

    return next();
  };

export const enforceOrderOwnership = async (req, _res, next) => {
  try {
    const orderId = req.params.orderId || req.params.id;

    if (!orderId) {
      throw new AppError("orderId nao informado.", 400);
    }

    if (
      req.user.role === "ADMIN" ||
      req.user.role === "COZINHA" ||
      req.user.role === "FUNCIONARIO" ||
      req.user.role === "MOTOBOY"
    ) {
      return next();
    }

    const order = await orderRepository.findByIdWithUser(orderId);

    if (!order) {
      throw new AppError("Pedido nao encontrado.", 404);
    }

    if (req.user.role === "MESA") {
      if (order.mesaId !== req.user.id) {
        throw new AppError(
          "Voce nao tem permissao para acessar este pedido.",
          403,
        );
      }
      return next();
    }

    if (req.user.role !== "CLIENTE") {
      throw new AppError("Perfil sem permissao para acessar pedido.", 403);
    }

    if (!order.user || order.user.id !== req.user.id) {
      throw new AppError(
        "Voce nao tem permissao para acessar este pedido.",
        403,
      );
    }

    return next();
  } catch (error) {
    return next(error);
  }
};
