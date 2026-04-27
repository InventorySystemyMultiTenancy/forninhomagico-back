import dotenv from "dotenv";
import http from "http";
import { app } from "./app.js";
import { initializeSocketServer } from "./realtime/socketServer.js";
import { prisma } from "./lib/prisma.js";

dotenv.config();

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

const port = Number(process.env.PORT || 3000);
const server = http.createServer(app);

initializeSocketServer(server);

// Auto-migrate new columns so the server never fails due to missing columns
async function runMigrations() {
  const migrations = [
    `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "isPickup" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "assignedMotoboyId" TEXT`,
    `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "deliveryCode" TEXT`,
  ];
  for (const sql of migrations) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      console.error("[migration] falhou:", sql, err.message);
    }
  }
  console.log("[migration] colunas verificadas/criadas com sucesso");
}

runMigrations().then(() => {
  server.listen(port, () => {
    console.log(`API Pizzaria China rodando na porta ${port}`);
  });
});
