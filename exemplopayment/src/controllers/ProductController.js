import { ZodError } from "zod";
import { AppError } from "../errors/AppError.js";
import { ProductService } from "../services/ProductService.js";
import {
  createProductSchema,
  updateProductSchema,
} from "../validators/productSchemas.js";

const productService = new ProductService();

export class ProductController {
  async list(_req, res, next) {
    try {
      const products = await productService.listProducts();
      return res.status(200).json({ data: products });
    } catch (error) {
      return next(
        error instanceof AppError ? error : new AppError("Erro interno.", 500),
      );
    }
  }

  async listAdmin(_req, res, next) {
    try {
      const products = await productService.listProductsForAdmin();
      return res.status(200).json({ data: products });
    } catch (error) {
      return next(
        error instanceof AppError ? error : new AppError("Erro interno.", 500),
      );
    }
  }

  async listTopSelling(req, res, next) {
    try {
      const limit = Number(req.query.limit) || 6;
      const products = await productService.listTopSellingProducts(limit);
      return res.status(200).json({ data: products });
    } catch (error) {
      return next(
        error instanceof AppError ? error : new AppError("Erro interno.", 500),
      );
    }
  }

  async getById(req, res, next) {
    try {
      const product = await productService.getProductById(req.params.productId);
      return res.status(200).json({ data: product });
    } catch (error) {
      return next(error);
    }
  }

  async create(req, res, next) {
    try {
      const payload = createProductSchema.parse(req.body);
      const product = await productService.createProduct(payload);
      return res.status(201).json({ data: product });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async update(req, res, next) {
    try {
      const payload = updateProductSchema.parse(req.body);
      const product = await productService.updateProduct(
        req.params.productId,
        payload,
      );
      return res.status(200).json({ data: product });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async deactivate(req, res, next) {
    try {
      await productService.deactivateProduct(req.params.productId);
      return res.status(200).json({ message: "Produto desativado." });
    } catch (error) {
      return next(error);
    }
  }

  async restore(req, res, next) {
    try {
      await productService.restoreProduct(req.params.productId);
      return res.status(200).json({ message: "Produto reativado." });
    } catch (error) {
      return next(error);
    }
  }

  #handleError(error, next) {
    if (error instanceof ZodError) {
      return next(
        new AppError(error.errors.map((e) => e.message).join(", "), 422),
      );
    }
    return next(
      error instanceof AppError ? error : new AppError("Erro interno.", 500),
    );
  }
}
