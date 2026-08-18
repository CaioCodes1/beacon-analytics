import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

/* -------------------------------------------------------------------------- */
/* Senhas de usuário                                                          */
/* -------------------------------------------------------------------------- */

const BCRYPT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/* -------------------------------------------------------------------------- */
/* Chaves de ingestão                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Por que senha usa bcrypt e chave de API usa SHA-256.
 *
 * Bcrypt é lento de propósito: senhas humanas têm pouca entropia e precisam que
 * cada tentativa de adivinhação custe caro ao atacante.
 *
 * Uma chave de API aqui tem 256 bits de aleatoriedade vinda do CSPRNG do
 * sistema. Não existe dicionário para isso — força bruta é inviável mesmo com
 * um hash instantâneo. E como a chave é verificada em *toda* requisição de
 * ingestão, usar bcrypt custaria ~100ms de CPU por evento recebido, o que
 * transformaria a autenticação no gargalo da API inteira.
 *
 * SHA-256 + comparação em tempo constante é a escolha certa para segredos de
 * alta entropia. A regra não é "bcrypt sempre", é "trabalho proporcional à
 * fraqueza do segredo".
 */

const KEY_BYTES = 32;
const KEY_PREFIX = 'bk_';

export interface GeneratedApiKey {
  /** Valor completo. Aparece uma única vez, na resposta da criação. */
  plaintext: string;
  /** Parte visível, guardada em claro para o usuário identificar a chave. */
  prefix: string;
  /** O que vai para o banco. */
  hash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const secret = randomBytes(KEY_BYTES).toString('base64url');
  const plaintext = `${KEY_PREFIX}${secret}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, 11),
    hash: hashApiKey(plaintext),
  };
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Comparação em tempo constante: o tempo de resposta não pode revelar quantos
 * caracteres do hash o atacante já acertou.
 */
export function apiKeyMatches(plaintext: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashApiKey(plaintext), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

export function apiKeyPrefixOf(plaintext: string): string {
  return plaintext.slice(0, 11);
}
