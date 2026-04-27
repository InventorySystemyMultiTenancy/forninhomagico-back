import { ZodError } from "zod";
import { AppError } from "../errors/AppError.js";
import { AuthService } from "../services/AuthService.js";
import { loginSchema, registerSchema } from "../validators/authSchemas.js";

const authService = new AuthService();

export class AuthController {
  async register(req, res, next) {
    try {
      const payload = registerSchema.parse(req.body);
      const user = await authService.register(payload, null);

      return res.status(201).json({
        message: "Usuario criado com sucesso.",
        data: user,
      });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async createUserByAdmin(req, res, next) {
    try {
      const payload = registerSchema.parse(req.body);
      const user = await authService.register(payload, req.user);

      return res.status(201).json({
        message: "Usuario da equipe criado com sucesso.",
        data: user,
      });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async login(req, res, next) {
    try {
      const payload = loginSchema.parse(req.body);
      const result = await authService.login(payload);

      return res.status(200).json({
        message: "Login realizado com sucesso.",
        data: result,
      });
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
