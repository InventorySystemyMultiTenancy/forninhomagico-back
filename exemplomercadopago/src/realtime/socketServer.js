import { Server } from "socket.io";
import jwt from "jsonwebtoken";

let ioInstance = null;

const STAFF_ROLES = new Set(["ADMIN", "FUNCIONARIO", "COZINHA", "MOTOBOY"]);

function getOrigin() {
  return process.env.CORS_ORIGIN || "http://localhost:5173";
}

export function initializeSocketServer(server) {
  ioInstance = new Server(server, {
    cors: {
      origin: getOrigin(),
      methods: ["GET", "POST"],
    },
  });

  ioInstance.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;

      if (!token) {
        return next(new Error("Token nao fornecido."));
      }

      const payload = jwt.verify(token, process.env.JWT_SECRET);

      socket.data.user = {
        id: payload.sub,
        role: payload.role,
        email: payload.email,
      };

      return next();
    } catch {
      return next(new Error("Token invalido ou expirado."));
    }
  });

  ioInstance.on("connection", (socket) => {
    const { id, role } = socket.data.user;

    socket.join(`user:${id}`);
    socket.join(`role:${role}`);

    if (STAFF_ROLES.has(role)) {
      socket.join("staff");
    }
  });

  return ioInstance;
}

function emitToUserAndStaff(eventName, payload) {
  if (!ioInstance) {
    return;
  }

  ioInstance.to("staff").emit(eventName, payload);

  if (payload.userId) {
    ioInstance.to(`user:${payload.userId}`).emit(eventName, payload);
  }
}

export function emitOrderCreated(payload) {
  emitToUserAndStaff("order:created", payload);
}

export function emitOrderStatusUpdated(payload) {
  emitToUserAndStaff("order:status-updated", payload);
}

export function emitPaymentUpdated(payload) {
  emitToUserAndStaff("order:payment-updated", payload);
}
