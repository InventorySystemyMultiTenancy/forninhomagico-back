import express from "express";
import cors from "cors";
import { AuthController } from "./controllers/AuthController.js";
import { OrderController } from "./controllers/OrderController.js";
import { PaymentController } from "./controllers/PaymentController.js";
import { ProductController } from "./controllers/ProductController.js";
import { MesaController } from "./controllers/MesaController.js";
import {
  authenticateToken,
  authorizeRoles,
  enforceOrderOwnership,
} from "./middlewares/authMiddleware.js";
import { errorMiddleware } from "./middlewares/errorMiddleware.js";
import { prisma } from "./lib/prisma.js";
import { DeliveryService } from "./services/DeliveryService.js";
import { deliveryFreightSchema } from "./validators/orderSchemas.js";

const app = express();
const authController = new AuthController();
const orderController = new OrderController();
const paymentController = new PaymentController();
const productController = new ProductController();
const mesaController = new MesaController();

const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, Render health checks)
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  }),
);
app.use(express.json());

app.get("/health", (_req, res) => {
  return res.status(200).json({ status: "ok" });
});

// Public product routes
app.get("/api/products", (req, res, next) =>
  productController.list(req, res, next),
);
app.get("/api/products/top", (req, res, next) =>
  productController.listTopSelling(req, res, next),
);
app.get("/api/products/:productId", (req, res, next) =>
  productController.getById(req, res, next),
);

// Admin product management routes
app.get(
  "/api/admin/products",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => productController.listAdmin(req, res, next),
);
app.post(
  "/api/admin/products",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => productController.create(req, res, next),
);
app.put(
  "/api/admin/products/:productId",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => productController.update(req, res, next),
);
app.delete(
  "/api/admin/products/:productId",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => productController.deactivate(req, res, next),
);
app.patch(
  "/api/admin/products/:productId/restore",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => productController.restore(req, res, next),
);

app.post("/api/auth/register", (req, res, next) =>
  authController.register(req, res, next),
);

app.post("/api/auth/login", (req, res, next) =>
  authController.login(req, res, next),
);

app.post(
  "/api/auth/users",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => authController.createUserByAdmin(req, res, next),
);

app.get(
  "/api/orders",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO", "COZINHA"),
  (req, res, next) => orderController.listAll(req, res, next),
);

// Motoboy: pedidos prontos para entrega
app.get(
  "/api/motoboy/orders",
  authenticateToken,
  authorizeRoles("MOTOBOY", "ADMIN", "FUNCIONARIO"),
  (req, res, next) => orderController.motoboyOrders(req, res, next),
);

// Cálculo de frete (Nominatim + OSRM)
const deliveryService = new DeliveryService();
app.post(
  "/api/delivery/calculate",
  authenticateToken,
  async (req, res, next) => {
    try {
      const { cep, numero, cidade, rua, complemento } =
        deliveryFreightSchema.parse(req.body);
      const result = await deliveryService.calculateFreight({
        cep,
        numero,
        cidade,
        rua,
        complemento,
      });
      return res.status(200).json({ data: result });
    } catch (err) {
      return next(err);
    }
  },
);

app.get(
  "/api/admin/orders/history",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO"),
  (req, res, next) => orderController.history(req, res, next),
);

app.get(
  "/api/admin/clients",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO"),
  async (_req, res, next) => {
    try {
      const users = await prisma.user.findMany({
        where: { role: "CLIENTE" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      });
      return res.status(200).json({ data: users });
    } catch (err) {
      return next(err);
    }
  },
);

app.get(
  "/api/admin/analytics",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO"),
  (req, res, next) => orderController.analytics(req, res, next),
);

app.post(
  "/api/orders",
  authenticateToken,
  authorizeRoles("CLIENTE", "ADMIN"),
  (req, res, next) => orderController.create(req, res, next),
);

app.get(
  "/api/orders/me",
  authenticateToken,
  authorizeRoles("CLIENTE"),
  (req, res, next) => orderController.getMyOrders(req, res, next),
);

app.get(
  "/api/orders/:orderId",
  authenticateToken,
  authorizeRoles(
    "CLIENTE",
    "ADMIN",
    "COZINHA",
    "FUNCIONARIO",
    "MOTOBOY",
    "MESA",
  ),
  enforceOrderOwnership,
  (req, res, next) => orderController.getById(req, res, next),
);

app.patch(
  "/api/orders/:orderId/cancel",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO"),
  (req, res, next) => orderController.cancel(req, res, next),
);

app.patch(
  "/api/orders/:orderId/assign-motoboy",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO", "COZINHA"),
  (req, res, next) => orderController.assignMotoboy(req, res, next),
);

app.post(
  "/api/orders/:orderId/confirm-delivery",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO", "COZINHA", "MOTOBOY"),
  (req, res, next) => orderController.confirmDelivery(req, res, next),
);

app.get(
  "/api/admin/motoboys",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO", "COZINHA"),
  async (_req, res, next) => {
    try {
      const motoboys = await prisma.$queryRaw`
        SELECT id, name FROM "User" WHERE role::text = 'MOTOBOY' ORDER BY name ASC
      `;
      return res.status(200).json({ data: motoboys });
    } catch (err) {
      return next(err);
    }
  },
);

app.delete(
  "/api/orders/:orderId",
  authenticateToken,
  authorizeRoles("CLIENTE", "ADMIN"),
  (req, res, next) => orderController.deleteOrder(req, res, next),
);

app.patch(
  "/api/orders/:orderId/status",
  authenticateToken,
  authorizeRoles("ADMIN", "COZINHA", "FUNCIONARIO"),
  (req, res, next) => orderController.updateStatus(req, res, next),
);

app.patch(
  "/api/orders/:orderId/payment-status",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO"),
  (req, res, next) => orderController.adminUpdatePaymentStatus(req, res, next),
);

app.post("/api/payments/webhook", (req, res, next) =>
  orderController.paymentWebhook(req, res, next),
);

// MP IPN validation — sends GET to confirm the endpoint is alive
app.get("/api/payments/webhook", (_req, res) => {
  return res.status(200).json({ status: "ok" });
});

app.post("/api/payments/preference", authenticateToken, (req, res, next) =>
  paymentController.createPreference(req, res, next),
);

// Mesa: acesso publico por token (QR code)
app.get("/api/mesas/acesso/:token", (req, res, next) =>
  mesaController.access(req, res, next),
);

// Mesa: CRUD (admin)
app.get(
  "/api/mesas",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => mesaController.list(req, res, next),
);
app.post(
  "/api/mesas",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => mesaController.create(req, res, next),
);
app.put(
  "/api/mesas/:mesaId",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => mesaController.update(req, res, next),
);
app.delete(
  "/api/mesas/:mesaId",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => mesaController.delete(req, res, next),
);
app.post(
  "/api/mesas/:mesaId/regenerar-token",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => mesaController.regenerateToken(req, res, next),
);

// Mesa: pedidos da sessao (role MESA)
app.get(
  "/api/mesa/orders",
  authenticateToken,
  authorizeRoles("MESA"),
  (req, res, next) => mesaController.myOrders(req, res, next),
);
app.post(
  "/api/mesa/orders",
  authenticateToken,
  authorizeRoles("MESA"),
  (req, res, next) => orderController.create(req, res, next),
);

// Mesa: pagamento PIX (QR code no tablet)
app.post(
  "/api/mesa/payments/pix",
  authenticateToken,
  authorizeRoles("MESA", "ADMIN", "FUNCIONARIO"),
  (req, res, next) => paymentController.createMesaPixPayment(req, res, next),
);

// Mesa: pagamento na maquininha (MP Point)
app.post(
  "/api/mesa/payments/terminal",
  authenticateToken,
  authorizeRoles("MESA", "ADMIN", "FUNCIONARIO"),
  (req, res, next) =>
    paymentController.createMesaTerminalPayment(req, res, next),
);

app.use(errorMiddleware);

export { app };
