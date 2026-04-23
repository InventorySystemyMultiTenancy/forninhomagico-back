import { AppError } from "../errors/AppError.js";

export const errorMiddleware = (error, _req, res, _next) => {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      error: {
        message: error.message,
        details: error.details,
      },
    });
  }

  console.error("[500 Internal Error]", error);

  return res.status(500).json({
    error: {
      message: "Erro interno do servidor.",
      detail: process.env.NODE_ENV !== "production" ? error.message : undefined,
    },
  });
};
