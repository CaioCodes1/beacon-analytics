/**
 * Verificacao das duas trocas de versao maior, sem precisar de banco.
 *
 * - @fastify/jwt 10: o plugin registra, assina e verifica um token?
 * - drizzle-orm 0.45: as consultas ainda geram o mesmo SQL?
 *
 * O segundo ponto e o que importa na correcao do drizzle: a falha corrigida
 * era de escape de identificadores, ou seja, exatamente a parte que gera os
 * nomes de tabela e coluna. Comparar o SQL gerado testa isso direto.
 */
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { eq, and, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { apiKeys, projects, users, events } from '../src/db/schema.js';

let falhas = 0;
const ok = (nome: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'OK  ' : 'FALHA'} ${nome}${extra ? ' -> ' + extra : ''}`);
  if (!cond) falhas++;
};

// ---- @fastify/jwt 10 ----
const app = Fastify();
await app.register(jwt, { secret: 'chave-de-teste-com-pelo-menos-32-caracteres-ok', sign: { expiresIn: '1h' } });
const token = app.jwt.sign({ sub: 'usuario-123', email: 'a@b.com' });
ok('jwt.sign devolve um token de 3 partes', token.split('.').length === 3);
const payload = app.jwt.verify(token) as { sub: string; email: string; exp: number };
ok('jwt.verify devolve o mesmo sub', payload.sub === 'usuario-123', payload.sub);
ok('jwt.verify devolve o mesmo email', payload.email === 'a@b.com', payload.email);
ok('token tem expiracao (expiresIn aplicado)', typeof payload.exp === 'number');
let rejeitou = false;
try { app.jwt.verify(token.slice(0, -3) + 'xxx'); } catch { rejeitou = true; }
ok('token adulterado e rejeitado', rejeitou);
let semAlg = false;
const p = token.split('.')[1];
const noneToken = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url') + '.' + p + '.';
try { app.jwt.verify(noneToken); } catch { semAlg = true; }
ok('token com alg:none e rejeitado', semAlg);
await app.close();

// ---- drizzle-orm 0.45: SQL gerado ----
const db = drizzle({ connection: 'postgres://x:x@127.0.0.1:1/x' });

const q1 = db.select().from(apiKeys).where(and(eq(apiKeys.prefix, 'abc'), isNull(apiKeys.revokedAt))).limit(1).toSQL();
ok('identificadores citados com aspas duplas', /"api_keys"/.test(q1.sql), q1.sql.slice(0, 90));
ok('valor vai como parametro $1, nao interpolado', q1.sql.includes('$1') && q1.params.includes('abc'));
ok('literal nao aparece no SQL (sem injecao)', !q1.sql.includes("'abc'"));

const q2 = db.select({ id: projects.id, ownerId: projects.ownerId }).from(projects).where(eq(projects.id, 'p1')).toSQL();
ok('select parcial cita as colunas com aspas', /"owner_id"/.test(q2.sql) && /from "projects"/.test(q2.sql), q2.sql.slice(0, 90));
ok('where do select parcial e qualificado pela tabela', /"projects"\."id"/.test(q2.sql));

const q3 = db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, 'k1')).toSQL();
ok('update parametriza o set', q3.sql.includes('$1') && q3.params.length === 2);

const malicioso = "'; DROP TABLE users; --";
const q4 = db.select().from(users).where(eq(users.email, malicioso)).toSQL();
ok('payload de injecao vira parametro, nao SQL', !q4.sql.includes('DROP TABLE') && q4.params.includes(malicioso));

const q5 = db.select().from(events).limit(1).toSQL();
ok('tabela de eventos ainda resolve', /"events"/.test(q5.sql));

console.log(falhas === 0 ? '\nTODAS AS VERIFICACOES PASSARAM' : `\n${falhas} VERIFICACAO(OES) FALHARAM`);
process.exit(falhas === 0 ? 0 : 1);
