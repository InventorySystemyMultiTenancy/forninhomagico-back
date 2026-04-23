import {
  MercadoPagoConfig,
  Preference,
  Payment as MPPayment,
} from "mercadopago";
import { AppError } from "../errors/AppError.js";
import { OrderRepository } from "../repositories/OrderRepository.js";
import { MesaRepository } from "../repositories/MesaRepository.js";

const orderRepository = new OrderRepository();
const mesaRepository = new MesaRepository();

export class PaymentController {
  async createPreference(req, res, next) {
    try {
      const { orderId } = req.body;

      if (!orderId) {
        throw new AppError("orderId obrigatorio.", 422);
      }

      const order = await orderRepository.findById(orderId);

      if (!order) {
        throw new AppError("Pedido nao encontrado.", 404);
      }

      if (order.userId !== req.user.id && req.user.role !== "ADMIN") {
        throw new AppError("Acesso negado.", 403);
      }

      const accessToken = process.env.MP_ACCESS_TOKEN;
      if (!accessToken) {
        throw new AppError("Mercado Pago nao configurado.", 500);
      }

      const client = new MercadoPagoConfig({ accessToken });
      const preferenceApi = new Preference(client);

      const frontendUrl =
        process.env.FRONTEND_URL ||
        "https://exemplopizzaria.selfmachine.com.br";

      const preference = await preferenceApi.create({
        body: {
          items: [
            {
              id: order.id,
              title: "Pedido Pizzaria Fellice",
              description: `Pedido #${order.id.slice(-6).toUpperCase()}`,
              quantity: 1,
              unit_price: parseFloat(Number(order.total).toFixed(2)),
              currency_id: "BRL",
            },
          ],
          external_reference: order.id,
          back_urls: {
            success: `${frontendUrl}/checkout/retorno`,
            failure: `${frontendUrl}/checkout/retorno`,
            pending: `${frontendUrl}/checkout/retorno`,
          },
          auto_return: "approved",
          notification_url: `${process.env.BACKEND_URL || "https://exemplopizzariabackend.onrender.com"}/api/payments/webhook`,
          statement_descriptor: "PIZZARIA FELLICE",
        },
      });

      return res.status(200).json({
        data: {
          preferenceId: preference.id,
          initPoint: preference.init_point,
          sandboxInitPoint: preference.sandbox_init_point,
        },
      });
    } catch (error) {
      return next(error);
    }
  }

  // Gera QR code PIX via MP Payment API (para pagamento na mesa/tablet)
  async createMesaPixPayment(req, res, next) {
    try {
      const { orderId } = req.body;

      if (!orderId) throw new AppError("orderId obrigatorio.", 422);

      const order = await orderRepository.findById(orderId);
      if (!order) throw new AppError("Pedido nao encontrado.", 404);

      // Apenas a propria mesa ou admin pode iniciar o pagamento
      const isMesa = req.user.role === "MESA";
      if (isMesa && order.mesaId !== req.user.id) {
        throw new AppError("Acesso negado.", 403);
      }
      if (
        !isMesa &&
        req.user.role !== "ADMIN" &&
        req.user.role !== "FUNCIONARIO"
      ) {
        throw new AppError("Acesso negado.", 403);
      }

      if (order.paymentStatus === "APROVADO") {
        throw new AppError("Pedido ja pago.", 409);
      }

      const mpToken = process.env.MP_ACCESS_TOKEN;
      if (!mpToken) throw new AppError("Mercado Pago nao configurado.", 500);

      const client = new MercadoPagoConfig({ accessToken: mpToken });
      const paymentApi = new MPPayment(client);

      const response = await paymentApi.create({
        body: {
          transaction_amount: parseFloat(Number(order.total).toFixed(2)),
          payment_method_id: "pix",
          payer: {
            email: process.env.MP_PIX_PAYER_EMAIL || "mesa@pizzaria.com",
          },
          description: `Pedido Mesa #${order.id.slice(-6).toUpperCase()}`,
          external_reference: order.id,
          notification_url: `${process.env.BACKEND_URL || "https://exemplopizzariabackend.onrender.com"}/api/payments/webhook`,
        },
      });

      const txData = response.point_of_interaction?.transaction_data ?? {};

      return res.status(200).json({
        data: {
          paymentId: response.id,
          status: response.status,
          qrCode: txData.qr_code,
          qrCodeBase64: txData.qr_code_base64,
          expiresAt: txData.ticket_url,
        },
      });
    } catch (error) {
      return next(error);
    }
  }

  // Envia cobrança direto para a maquininha (MP Point)
  async createMesaTerminalPayment(req, res, next) {
    try {
      const { orderId } = req.body;

      if (!orderId) throw new AppError("orderId obrigatorio.", 422);

      const order = await orderRepository.findById(orderId);
      if (!order) throw new AppError("Pedido nao encontrado.", 404);

      if (!order.mesaId) {
        throw new AppError("Pedido nao vinculado a uma mesa.", 422);
      }

      const isMesa = req.user.role === "MESA";
      if (isMesa && order.mesaId !== req.user.id) {
        throw new AppError("Acesso negado.", 403);
      }
      if (
        !isMesa &&
        req.user.role !== "ADMIN" &&
        req.user.role !== "FUNCIONARIO"
      ) {
        throw new AppError("Acesso negado.", 403);
      }

      if (order.paymentStatus === "APROVADO") {
        throw new AppError("Pedido ja pago.", 409);
      }

      const mesa = await mesaRepository.findById(order.mesaId);
      if (!mesa?.terminalId) {
        throw new AppError("Mesa sem maquininha configurada.", 422);
      }

      const mpToken = process.env.MP_ACCESS_TOKEN;
      if (!mpToken) throw new AppError("Mercado Pago nao configurado.", 500);

      // Busca o pos_id do device para incluir no header X-Pos-Id (obrigatório no modo PDV)
      const devicesResp = await fetch(
        "https://api.mercadopago.com/point/integration-api/devices",
        { headers: { Authorization: `Bearer ${mpToken}` } },
      );
      const devicesData = await devicesResp.json();
      const deviceInfo = (devicesData.devices ?? []).find(
        (d) => d.id === mesa.terminalId,
      );
      const posIdValue =
        deviceInfo?.external_pos_id || String(deviceInfo?.pos_id ?? "");

      const paymentBody = {
        amount: Math.round(Number(order.total) * 100),
        description: `Pedido Mesa ${mesa.number} #${order.id.slice(-6).toUpperCase()}`,
        additional_info: {
          external_reference: order.id,
          print_on_terminal: true,
        },
        notification_url: `${process.env.BACKEND_URL || "https://exemplopizzariabackend.onrender.com"}/api/payments/webhook`,
      };

      console.log("[createMesaTerminalPayment] terminalId:", mesa.terminalId);
      console.log(
        "[createMesaTerminalPayment] body:",
        JSON.stringify(paymentBody),
      );

      // Não usa X-Pos-Id — o device_id na URL já direciona para a maquininha correta.
      // Usar X-Pos-Id causaria broadcast para todos os devices do mesmo POS.
      const mpHeaders = {
        Authorization: `Bearer ${mpToken}`,
        "Content-Type": "application/json",
      };

      // MP Point Integration API (sem /v2/)
      const mpResponse = await fetch(
        `https://api.mercadopago.com/point/integration-api/devices/${mesa.terminalId}/payment-intents`,
        {
          method: "POST",
          headers: mpHeaders,
          body: JSON.stringify(paymentBody),
        },
      );

      if (!mpResponse.ok) {
        const errBody = await mpResponse.json().catch(() => ({}));
        console.error(
          "[createMesaTerminalPayment] MP error:",
          JSON.stringify(errBody),
        );
        throw new AppError(
          errBody?.message || "Erro ao enviar para a maquininha.",
          mpResponse.status >= 500 ? 502 : 422,
        );
      }

      const intent = await mpResponse.json();

      return res.status(200).json({
        data: {
          intentId: intent.id,
          deviceId: mesa.terminalId,
          status: intent.state,
        },
      });
    } catch (error) {
      return next(error);
    }
  }
}
