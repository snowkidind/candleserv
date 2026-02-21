import crypto from "crypto";
import { query } from "./pool";

export interface UserRow {
  id: number;
  status: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  isAdmin: boolean;
  password: string;
  lastLogin: Date | null;
  lastLoginFail: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SafeUser = Omit<UserRow, "password">;

function rowToUser(row: Record<string, unknown>): UserRow {
  return {
    id: row.id as number,
    status: row.status as string,
    email: row.email as string,
    firstName: (row.firstName as string) ?? null,
    lastName: (row.lastName as string) ?? null,
    isAdmin: row.isAdmin as boolean,
    password: row.password as string,
    lastLogin: (row.lastLogin as Date) ?? null,
    lastLoginFail: (row.lastLoginFail as Date) ?? null,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

export function toSafeUser(user: UserRow): SafeUser {
  const { password: _p, ...rest } = user;
  return rest;
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const res = await query(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase().trim()]);
  if (!res.rows.length) return null;
  return rowToUser(res.rows[0]);
}

export async function findUserById(id: number): Promise<UserRow | null> {
  const res = await query(`SELECT * FROM users WHERE id = $1`, [id]);
  if (!res.rows.length) return null;
  return rowToUser(res.rows[0]);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, 10000, 64, "sha512", (err, key) => {
      if (err) return reject(err);
      resolve(`${salt}:${key.toString("hex")}`);
    });
  });
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, 10000, 64, "sha512", (err, key) => {
      if (err) return reject(err);
      resolve(crypto.timingSafeEqual(Buffer.from(hash, "hex"), key));
    });
  });
}

export async function createUser(opts: {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  isAdmin?: boolean;
}): Promise<UserRow> {
  const hashed = await hashPassword(opts.password);
  const res = await query(
    `INSERT INTO users (email, password, "firstName", "lastName", "isAdmin")
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      opts.email.toLowerCase().trim(),
      hashed,
      opts.firstName ?? null,
      opts.lastName ?? null,
      opts.isAdmin ?? false,
    ]
  );
  return rowToUser(res.rows[0]);
}

export async function touchLastLogin(id: number): Promise<void> {
  await query(`UPDATE users SET "lastLogin" = NOW(), "updatedAt" = NOW() WHERE id = $1`, [id]);
}

export async function touchLastLoginFail(id: number): Promise<void> {
  await query(`UPDATE users SET "lastLoginFail" = NOW(), "updatedAt" = NOW() WHERE id = $1`, [id]);
}

export async function listUsers(): Promise<SafeUser[]> {
  const res = await query(`SELECT * FROM users ORDER BY "createdAt"`);
  return res.rows.map((r: Record<string, unknown>) => toSafeUser(rowToUser(r)));
}
