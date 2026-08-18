import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { hashPassword, verifyPassword } from '../../lib/credentials.js';
import { ConflictError, UnauthorizedError } from '../../lib/errors.js';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function registerUser(input: {
  name: string;
  email: string;
  password: string;
}): Promise<PublicUser> {
  const email = normalizeEmail(input.email);

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) {
    throw new ConflictError('Já existe uma conta com este e-mail', 'EMAIL_TAKEN');
  }

  const [created] = await db
    .insert(users)
    .values({
      name: input.name.trim(),
      email,
      passwordHash: await hashPassword(input.password),
    })
    .returning({
      id: users.id,
      name: users.name,
      email: users.email,
      createdAt: users.createdAt,
    });

  // O insert com RETURNING sempre devolve uma linha; o `!` documenta isso para
  // o compilador sem afrouxar o strict do projeto inteiro.
  return created!;
}

export async function authenticateUser(input: {
  email: string;
  password: string;
}): Promise<PublicUser> {
  const email = normalizeEmail(input.email);

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  /**
   * O hash é verificado mesmo quando o e-mail não existe, contra um hash
   * descartável. Sem isso, "e-mail inexistente" responde em 1ms e "senha
   * errada" em 100ms — a diferença de tempo entrega quais e-mails estão
   * cadastrados.
   */
  const hashToCheck =
    user?.passwordHash ?? '$2a$12$00000000000000000000000000000000000000000000000000000';

  const valid = await verifyPassword(input.password, hashToCheck);

  if (!user || !valid) {
    throw new UnauthorizedError('E-mail ou senha incorretos', 'INVALID_CREDENTIALS');
  }

  return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt };
}
