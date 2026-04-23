import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { AppError } from "../errors/AppError.js";
import { UserRepository } from "../repositories/UserRepository.js";

const STAFF_ROLES = new Set(["ADMIN", "FUNCIONARIO", "COZINHA", "MOTOBOY"]);

export class AuthService {
  constructor(userRepository = new UserRepository()) {
    this.userRepository = userRepository;
  }

  async register(
    { name, email, phone, cpf, address, password, role },
    authUser = null,
  ) {
    if (email) {
      const existingByEmail = await this.userRepository.findByEmail(email);
      if (existingByEmail) throw new AppError("Email ja cadastrado.", 409);
    }

    if (phone) {
      const existingByPhone = await this.userRepository.findByPhone(phone);
      if (existingByPhone) throw new AppError("Telefone ja cadastrado.", 409);
    }

    if (cpf) {
      const existingByCpf = await this.userRepository.findByCpf(cpf);
      if (existingByCpf) throw new AppError("CPF ja cadastrado.", 409);
    }

    const requestedRole = role || "CLIENTE";

    if (STAFF_ROLES.has(requestedRole)) {
      if (!authUser)
        throw new AppError("Apenas admin pode criar contas de equipe.", 403);
      if (authUser.role !== "ADMIN")
        throw new AppError("Apenas admin pode criar contas de equipe.", 403);
    }

    if (requestedRole === "ADMIN" && authUser?.role !== "ADMIN") {
      throw new AppError("Apenas admin pode criar outro admin.", 403);
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await this.userRepository.create({
      name,
      email: email || null,
      phone: phone || null,
      cpf: cpf || null,
      address: address || null,
      passwordHash,
      role: requestedRole,
    });

    if (requestedRole === "CLIENTE") {
      const token = jwt.sign(
        { role: user.role, email: user.email || null },
        process.env.JWT_SECRET,
        { subject: user.id, expiresIn: process.env.JWT_EXPIRES_IN || "8h" },
      );
      return {
        accessToken: token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          address: user.address,
          role: user.role,
        },
      };
    }

    return { user };
  }

  async login({ identifier, password }) {
    const user = await this.userRepository.findByEmailOrPhone(identifier);

    if (!user) throw new AppError("Credenciais invalidas.", 401);

    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) throw new AppError("Credenciais invalidas.", 401);

    const token = jwt.sign(
      { role: user.role, email: user.email || null },
      process.env.JWT_SECRET,
      { subject: user.id, expiresIn: process.env.JWT_EXPIRES_IN || "8h" },
    );

    return {
      accessToken: token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        address: user.address,
        role: user.role,
      },
    };
  }
}
