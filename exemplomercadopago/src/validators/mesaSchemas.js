import { z } from "zod";

export const createMesaSchema = z.object({
  name: z.string().min(1).max(100),
  number: z.number().int().positive(),
  terminalId: z.string().min(1).max(100).optional(),
});

export const updateMesaSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  number: z.number().int().positive().optional(),
  terminalId: z.string().min(1).max(100).nullable().optional(),
  isActive: z.boolean().optional(),
});
