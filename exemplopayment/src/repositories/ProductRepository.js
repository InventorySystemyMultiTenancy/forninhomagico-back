import { prisma } from "../lib/prisma.js";

// Busca categorias via raw SQL (compatível com qualquer versão do Prisma Client)
async function fetchCategories(ids) {
  if (!ids.length) return new Map();
  const rows =
    await prisma.$queryRaw`SELECT "id", "category" FROM "Product" WHERE "id" = ANY(${ids})`;
  return new Map(rows.map((r) => [r.id, r.category ?? "Geral"]));
}

export class ProductRepository {
  async findAll() {
    const products = await prisma.product.findMany({
      where: { isActive: true },
      include: { sizes: { orderBy: { size: "asc" } } },
      orderBy: [{ isCrust: "asc" }, { name: "asc" }],
    });
    const catMap = await fetchCategories(products.map((p) => p.id));
    return products.map((p) => ({
      ...p,
      category: catMap.get(p.id) ?? "Geral",
    }));
  }

  async findAllForAdmin() {
    const products = await prisma.product.findMany({
      include: { sizes: { orderBy: { size: "asc" } } },
      orderBy: [{ isCrust: "asc" }, { name: "asc" }],
    });
    const catMap = await fetchCategories(products.map((p) => p.id));
    return products.map((p) => ({
      ...p,
      category: catMap.get(p.id) ?? "Geral",
    }));
  }

  async create({ name, description, imageUrl, category, isCrust, sizes }) {
    // category é gravado via raw SQL para ser compatível com qualquer versão do Prisma Client
    const product = await prisma.product.create({
      data: {
        name,
        description: description ?? null,
        imageUrl: imageUrl ?? null,
        isCrust: isCrust ?? false,
        sizes: {
          create: sizes.map(({ size, price, costPrice }) => ({
            size,
            price,
            ...(costPrice != null ? { costPrice } : {}),
          })),
        },
      },
      include: { sizes: { orderBy: { size: "asc" } } },
    });
    const cat = category ?? "Geral";
    await prisma.$executeRaw`UPDATE "Product" SET "category" = ${cat} WHERE "id" = ${product.id}`;
    return { ...product, category: cat };
  }

  async update(
    productId,
    { name, description, imageUrl, category, isCrust, sizes },
  ) {
    return prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: productId },
        data: {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
          ...(imageUrl !== undefined && { imageUrl }),
          ...(isCrust !== undefined && { isCrust }),
        },
      });

      if (category !== undefined) {
        await tx.$executeRaw`UPDATE "Product" SET "category" = ${category} WHERE "id" = ${productId}`;
      }

      if (sizes) {
        await tx.productSize.deleteMany({ where: { productId } });
        await tx.productSize.createMany({
          data: sizes.map(({ size, price, costPrice }) => ({
            productId,
            size,
            price,
            ...(costPrice != null ? { costPrice } : {}),
          })),
        });
      }

      return tx.product.findUnique({
        where: { id: productId },
        include: { sizes: { orderBy: { size: "asc" } } },
      });
    });
  }

  async setActive(productId, isActive) {
    return prisma.product.update({
      where: { id: productId },
      data: { isActive },
    });
  }

  async findByIdWithSizes(productId) {
    return prisma.product.findUnique({
      where: { id: productId },
      include: { sizes: true },
    });
  }

  async findTopSelling(limit = 6) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ranked."productId", SUM(ranked.quantity)::int AS "soldCount"
       FROM (
         SELECT oi."productId", oi.quantity
         FROM "OrderItem" oi
         INNER JOIN "Order" o ON o.id = oi."orderId"
         WHERE oi."productId" IS NOT NULL
           AND o."paymentStatus"::text = 'APROVADO'

         UNION ALL

         SELECT oi."firstHalfProductId" AS "productId", oi.quantity
         FROM "OrderItem" oi
         INNER JOIN "Order" o ON o.id = oi."orderId"
         WHERE oi."firstHalfProductId" IS NOT NULL
           AND o."paymentStatus"::text = 'APROVADO'

         UNION ALL

         SELECT oi."secondHalfProductId" AS "productId", oi.quantity
         FROM "OrderItem" oi
         INNER JOIN "Order" o ON o.id = oi."orderId"
         WHERE oi."secondHalfProductId" IS NOT NULL
           AND o."paymentStatus"::text = 'APROVADO'
       ) ranked
       INNER JOIN "Product" p ON p.id = ranked."productId"
       WHERE p."isActive" = true
         AND p."isCrust" = false
       GROUP BY ranked."productId"
       ORDER BY "soldCount" DESC, ranked."productId" ASC
       LIMIT $1`,
      limit,
    );

    if (!rows.length) {
      return [];
    }

    const ids = rows.map((row) => row.productId);
    const soldCountById = new Map(rows.map((row) => [row.productId, row.soldCount]));
    const products = await prisma.product.findMany({
      where: {
        id: { in: ids },
        isActive: true,
        isCrust: false,
      },
      include: {
        sizes: { orderBy: { size: "asc" } },
      },
    });

    const categoryMap = await fetchCategories(products.map((product) => product.id));
    const productsById = new Map(products.map((product) => [product.id, product]));

    return ids
      .map((id) => productsById.get(id))
      .filter(Boolean)
      .map((product) => ({
        ...product,
        category: categoryMap.get(product.id) ?? "Geral",
        soldCount: soldCountById.get(product.id) ?? 0,
      }));
  }

  async findSizePrice(productId, size, { isCrust } = {}) {
    const sizeEntry = await prisma.productSize.findUnique({
      where: {
        productId_size: {
          productId,
          size,
        },
      },
      include: {
        product: {
          select: {
            id: true,
            isActive: true,
            isCrust: true,
          },
        },
      },
    });

    if (!sizeEntry?.product?.isActive) {
      return null;
    }

    if (
      typeof isCrust === "boolean" &&
      sizeEntry.product.isCrust !== isCrust
    ) {
      return null;
    }

    return sizeEntry;
  }
}
