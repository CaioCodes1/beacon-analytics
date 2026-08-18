import { eq, and, desc, isNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { projects, apiKeys } from '../../db/schema.js';
import { generateApiKey } from '../../lib/credentials.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // remove os acentos separados pelo NFD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export async function createProject(ownerId: string, name: string) {
  const base = slugify(name) || 'projeto';
  // Colisão de slug é esperada (dois usuários com "Meu Site"), então o sufixo
  // aleatório é a regra e não a exceção.
  const slug = `${base}-${Math.random().toString(36).slice(2, 8)}`;

  const [created] = await db
    .insert(projects)
    .values({ ownerId, name: name.trim(), slug })
    .returning();

  if (!created) throw new ConflictError('Não foi possível criar o projeto');
  return created;
}

export async function listProjects(ownerId: string) {
  return db
    .select()
    .from(projects)
    .where(eq(projects.ownerId, ownerId))
    .orderBy(desc(projects.createdAt));
}

export async function deleteProject(ownerId: string, projectId: string) {
  const deleted = await db
    .delete(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
    .returning({ id: projects.id });

  if (deleted.length === 0) {
    throw new NotFoundError('Projeto não encontrado', 'PROJECT_NOT_FOUND');
  }
}

/**
 * Cria uma chave de ingestão.
 *
 * O valor em texto puro é devolvido aqui e nunca mais. Não existe endpoint de
 * "ver a chave de novo" — se o usuário perder, revoga e cria outra. Guardar o
 * texto puro só para poder reexibi-lo anularia todo o ganho de armazenar hash.
 */
export async function createApiKey(projectId: string, name: string) {
  const generated = generateApiKey();

  const [created] = await db
    .insert(apiKeys)
    .values({
      projectId,
      name: name.trim(),
      prefix: generated.prefix,
      keyHash: generated.hash,
    })
    .returning({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      createdAt: apiKeys.createdAt,
    });

  return { ...created!, key: generated.plaintext };
}

export async function listApiKeys(projectId: string) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.projectId, projectId))
    .orderBy(desc(apiKeys.createdAt));
}

/**
 * Revogação é lógica, não física: a linha continua no banco com `revoked_at`
 * preenchido. Apagar destruiria o histórico de qual chave enviou o quê — que é
 * a primeira coisa que se procura quando uma chave vaza.
 */
export async function revokeApiKey(projectId: string, keyId: string) {
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.projectId, projectId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });

  if (revoked.length === 0) {
    throw new NotFoundError('Chave não encontrada ou já revogada', 'API_KEY_NOT_FOUND');
  }
}
