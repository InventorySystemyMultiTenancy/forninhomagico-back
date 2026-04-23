import { z } from "zod";

export const loginSchema = z.object({
  identifier: z.string().min(1, "Email ou telefone obrigatorio"),
  password: z.string().min(6).max(100),
});

export const registerSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().optional().nullable(),
  phone: z.string().min(10).max(20).optional().nullable(),
  cpf: z.string().min(11).max(14).optional().nullable(),
  address: z.string().max(255).optional().nullable(),
  password: z.string().min(6).max(100),
  role: z
    .enum(["ADMIN", "FUNCIONARIO", "COZINHA", "MOTOBOY", "CLIENTE"])
    .optional(),
});
