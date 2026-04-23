import axios from "axios";
import { AppError } from "../errors/AppError.js";

// ─── Constantes da Pizzaria ───────────────────────────────────────────────────
// Endereço fixo: Avenida Cachoeira Paulista, 17 — CEP 03551-000, São Paulo
const PIZZARIA_LAT = -23.5318;
const PIZZARIA_LON = -46.5043;

const TAXA_BASE = 5.0; // R$ 5,00 fixo (saída do motoboy)
const TAXA_POR_KM = 2.0; // R$ 2,00 por km rodado

// ─── Helpers ─────────────────────────────────────────────────────────────────
const formatBRL = (valor) =>
  valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/**
 * Executa uma chamada axios com retry automático em caso de falha de rede/timeout.
 * Não retenta erros HTTP 4xx (erros do cliente).
 */
async function axiosWithRetry(config, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await axios(config);
    } catch (err) {
      // Não retenta se for erro HTTP com resposta (4xx/5xx do servidor externo)
      if (err.response) throw err;
      lastErr = err;
      // Aguarda 500ms antes de tentar de novo (exceto na última tentativa)
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  throw lastErr;
}

// ─── Serviço de Entrega ───────────────────────────────────────────────────────
export class DeliveryService {
  /**
   * Calcula o frete com base no CEP, número e cidade do cliente.
   * @param {string} cep    - CEP do cliente (com ou sem traço)
   * @param {string} numero - Número da residência
   * @param {string} cidade - Cidade do cliente
   * @returns {{ distanciaKm: number, valorFrete: string, tempoEstimado: number }}
   */
  async calculateFreight({ cep, numero, cidade, rua }) {
    // ── Etapa 1: Geocodificação via Nominatim ────────────────────────────────
    const cleanCep = cep.replace(/\D/g, "");
    // Usa o nome da rua quando disponível para maior precisão
    const query =
      rua && rua.trim()
        ? `${rua.trim()}, ${numero}, ${cidade}, Brasil`
        : `${cleanCep}, ${numero}, ${cidade}, Brasil`;

    let lat, lon, displayName;

    try {
      const nominatimRes = await axiosWithRetry({
        method: "get",
        url: "https://nominatim.openstreetmap.org/search",
        params: {
          q: query,
          format: "json",
          limit: 1,
          countrycodes: "br",
          // Restringe ao município de São Paulo (bounding box)
          viewbox: "-46.8254,-23.3568,-46.3648,-24.0085",
          bounded: 1,
        },
        headers: {
          "User-Agent": "PizzariaFellice/1.0 (contato@pizzariafellice.com.br)",
          "Accept-Language": "pt-BR",
        },
        timeout: 15000,
      });

      if (!nominatimRes.data || nominatimRes.data.length === 0) {
        throw new AppError(
          "Endereço não encontrado. Verifique o CEP, número e cidade informados.",
          422,
        );
      }

      lat = parseFloat(nominatimRes.data[0].lat);
      lon = parseFloat(nominatimRes.data[0].lon);
      displayName = nominatimRes.data[0].display_name;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        "Falha ao consultar serviço de geocodificação. Tente novamente.",
        502,
      );
    }

    // ── Etapa 2: Cálculo de Rota via OSRM ───────────────────────────────────
    let distanceMeters, durationSeconds;

    try {
      const osrmRes = await axiosWithRetry({
        method: "get",
        url: `http://router.project-osrm.org/route/v1/driving/${PIZZARIA_LON},${PIZZARIA_LAT};${lon},${lat}`,
        params: { overview: "false" },
        timeout: 15000,
      });

      if (osrmRes.data.code !== "Ok" || !osrmRes.data.routes?.[0]) {
        throw new AppError(
          "Não foi possível calcular a rota para o endereço informado.",
          422,
        );
      }

      distanceMeters = osrmRes.data.routes[0].distance;
      durationSeconds = osrmRes.data.routes[0].duration;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        "Falha ao calcular rota de entrega. Tente novamente.",
        502,
      );
    }

    // ── Etapa 3: Cálculo do Frete ────────────────────────────────────────────
    const distanciaKm = Math.round((distanceMeters / 1000) * 10) / 10;
    const valorFreteNumerico = TAXA_BASE + distanciaKm * TAXA_POR_KM;
    const tempoEstimado = Math.ceil(durationSeconds / 60);

    return {
      lat,
      lon,
      displayName,
      distanciaKm,
      valorFrete: formatBRL(valorFreteNumerico),
      valorFreteNumerico: Math.round(valorFreteNumerico * 100) / 100,
      tempoEstimado,
    };
  }
}
